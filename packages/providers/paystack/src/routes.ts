import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type IdFactory,
  type Payment,
  type PaymentMethod,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import {
  PAYMENT_SIMULATE_JOB,
  maskInstrument,
  resolveInstrument,
  type PaymentSimulator,
} from '@paybox/simulator';
import {
  checkoutPaySchema,
  chargeAuthorizationSchema,
  chargeSchema,
  customerSchema,
  deactivateAuthorizationSchema,
  initializeSchema,
  normalizeMetadata,
  partialDebitSchema,
  recipientSchema,
  refundSchema,
  submitBirthdaySchema,
  submitOtpSchema,
  submitPhoneSchema,
  submitPinSchema,
  transferSchema,
} from './schemas.js';
import {
  numericTransactionId,
  ok,
  serializeCustomer,
  serializeRefund,
  serializeTransaction,
  serializeTransfer,
} from './serializers.js';
import { toPaystackError } from './errors.js';
import { assertPaystackCredentials } from './auth.js';
import { renderCheckoutPage, renderCheckoutResult } from './checkout.js';
import { fromPaystackStatus } from './status.js';
import { paystackAuthorizationMinter } from './authorization.js';

export interface PaystackPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  /** Public origin, e.g. http://localhost:8080 — used to build checkout URLs. */
  baseUrl: string;
  /** Mount path, e.g. /paystack. */
  basePath: string;
  allowAnyKey?: boolean;
  includeFees?: boolean;
  /**
   * When true, a charge whose test instrument implies an outcome plays that
   * outcome out automatically after a short delay, the way a real mobile-money
   * prompt or card authorization would. Off means the developer drives every
   * transition explicitly from the CLI or dashboard.
   */
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'paystack' as const;

/**
 * Paystack-compatible HTTP surface (spec §13, §33).
 *
 * Endpoint paths and response envelopes follow Paystack's published API. What
 * this file does NOT do is make decisions: every route translates a request
 * into an engine call and translates the result back. All the payment
 * behaviour lives in @paybox/core, which is what keeps provider logic out of
 * the engine and the engine out of the providers (spec §30).
 */
export const paystackPlugin: FastifyPluginAsync<PaystackPluginOptions> = async (
  fastify,
  options,
) => {
  const { engine, simulator, storage, clock, ids } = options;
  const includeFees = options.includeFees ?? true;
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;

  // Every Paystack error, including thrown PayboxErrors, leaves in Paystack's
  // envelope rather than Fastify's default shape.
  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toPaystackError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ status: false, message: 'The requested resource was not found.' }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertPaystackCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  async function loadTransaction(handle: string): Promise<Payment> {
    // Paystack lets you address a transaction by numeric id or by reference,
    // so accept both, plus our canonical id for convenience from the CLI.
    const byRef = await storage.payments.byReference(PROVIDER, handle);
    if (byRef) return byRef;
    const byId = await storage.payments.byId(handle);
    if (byId && byId.provider === PROVIDER) return byId;

    const numeric = Number(handle);
    if (Number.isFinite(numeric)) {
      const { items } = await storage.payments.list({ provider: PROVIDER, limit: 500 });
      const match = items.find(
        (p) => numericTransactionId(p.providerTransactionId) === numeric,
      );
      if (match) return match;
    }
    throw new PayboxError('not_found', `Transaction ${handle} not found.`);
  }

  async function decorate(payment: Payment) {
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    const events = await storage.events.listByResource(payment.id);
    return serializeTransaction(payment, {
      customer,
      events,
      includeFees,
      authorization: await storedAuthorization(payment),
    });
  }

  /**
   * The authorization this payment would have minted, if it exists.
   *
   * Looked up by the code the minter derives from the instrument rather than
   * by payment id: a card charged twice dedupes onto one authorization, so the
   * second payment has no row of its own and must still report the same
   * chargeable code.
   */
  async function storedAuthorization(payment: Payment) {
    const draft = paystackAuthorizationMinter(payment);
    if (!draft?.providerAuthorizationCode) return null;
    return storage.authorizations.byCode(PROVIDER, draft.providerAuthorizationCode);
  }

  /** Resolve an `AUTH_...` code (or a canonical id) to a chargeable row. */
  async function requireAuthorization(handle: string) {
    const code = handle.replace(/^AUTH_/, '');
    const authorization =
      (await engine.resolveAuthorization(PROVIDER, code)) ??
      (await engine.resolveAuthorization(PROVIDER, handle));
    if (!authorization) {
      throw new PayboxError('not_found', `Authorization ${handle} not found.`);
    }
    engine.assertChargeable(authorization);
    return authorization;
  }

  /**
   * Charge a stored authorization off-session.
   *
   * Unlike `/charge`, this settles inline: the customer is not present, so
   * there is no prompt to wait on and Paystack answers with a finished
   * transaction. The outcome still comes from the instrument behind the
   * authorization, so an `AUTH_` minted from the insufficient-funds test card
   * declines here exactly as the original charge did.
   */
  async function chargeStoredAuthorization(input: {
    authorizationCode: string;
    email: string;
    amount: number;
    currency: string;
    reference?: string | undefined;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    const authorization = await requireAuthorization(input.authorizationCode);
    const customer = await engine.createCustomer({ provider: PROVIDER, email: input.email });

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: input.amount,
      currency: input.currency,
      ...(input.reference ? { reference: input.reference } : {}),
      customerId: customer.id,
      paymentMethod: authorization.channel,
      paymentMethodDetails: {
        bin: authorization.bin,
        last4: authorization.last4,
        exp_month: authorization.expMonth,
        exp_year: authorization.expYear,
        brand: authorization.brand,
        card_type: authorization.cardType,
        bank: authorization.bank,
        country: authorization.countryCode,
      },
      metadata: {
        ...(input.metadata ?? {}),
        email: input.email,
        authorization_code: `AUTH_${authorization.providerAuthorizationCode}`,
      },
      status: 'pending',
      providerStatus: 'pending',
    });

    const { outcome } = resolveInstrument(authorization.last4, authorization.channel);
    return simulator.apply(payment.id, outcome);
  }

  /** Schedule the outcome implied by a test instrument. */
  async function scheduleOutcome(payment: Payment, identifier: string | null): Promise<void> {
    if (!autoAdvance) return;
    const { outcome } = resolveInstrument(identifier, payment.paymentMethod);
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: PAYMENT_SIMULATE_JOB,
      payload: { paymentId: payment.id, outcome },
      status: 'ready',
      runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `payment:${payment.id}`,
      createdAt: clock.nowISO(),
      updatedAt: clock.nowISO(),
    });
  }

  /* ---------------------------------------------------------------- *
   * Transactions
   * ---------------------------------------------------------------- */

  fastify.post('/transaction/initialize', async (request, reply) => {
    authenticate(request);
    const body = initializeSchema.parse(request.body);
    const currency = (body.currency ?? 'NGN').toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `Currency ${currency} is not supported.`);
    }

    const customer = await engine.createCustomer({ provider: PROVIDER, email: body.email });
    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      callbackUrl: body.callback_url ?? null,
      metadata: { ...normalizeMetadata(body.metadata), email: body.email },
      status: 'pending',
      providerStatus: 'pending',
      // Paystack checkout links are time-limited; modelling that is what makes
      // `paybox time advance` able to reproduce an abandoned checkout.
      expiresInMs: 60 * 60_000,
    });

    // The access code doubles as the checkout URL segment, which is exactly
    // how Paystack's own authorization_url is shaped.
    const accessCode = payment.providerTransactionId;
    return reply.status(200).send(
      ok('Authorization URL created', {
        authorization_url: `${options.baseUrl}${options.basePath}/checkout/${accessCode}`,
        access_code: accessCode,
        reference: payment.reference,
      }),
    );
  });

  fastify.get<{ Params: { reference: string } }>(
    '/transaction/verify/:reference',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadTransaction(request.params.reference);
      return reply.send(ok('Verification successful', await decorate(payment)));
    },
  );

  fastify.get<{ Params: { id: string } }>('/transaction/:id', async (request, reply) => {
    authenticate(request);
    const payment = await loadTransaction(request.params.id);
    return reply.send(ok('Transaction retrieved', await decorate(payment)));
  });

  fastify.get<{ Querystring: { perPage?: string; page?: string; status?: string } }>(
    '/transaction',
    async (request, reply) => {
      authenticate(request);
      const perPage = Math.min(Number(request.query.perPage ?? 50) || 50, 200);
      const pageNumber = Math.max(Number(request.query.page ?? 1) || 1, 1);
      const canonical = request.query.status
        ? fromPaystackStatus(request.query.status)
        : undefined;

      const { items, total } = await storage.payments.list({
        provider: PROVIDER,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
        ...(canonical ? { status: canonical } : {}),
      });
      const data = await Promise.all(items.map((p) => decorate(p)));
      return reply.send({
        status: true,
        message: 'Transactions retrieved',
        data,
        meta: { total, skipped: (pageNumber - 1) * perPage, perPage, page: pageNumber },
      });
    },
  );

  fastify.post('/transaction/charge_authorization', async (request, reply) => {
    authenticate(request);
    const body = chargeAuthorizationSchema.parse(request.body);
    const currency = (body.currency ?? 'NGN').toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `Currency ${currency} is not supported.`);
    }

    const payment = await chargeStoredAuthorization({
      authorizationCode: body.authorization_code,
      email: body.email,
      amount: body.amount,
      currency,
      reference: body.reference,
      metadata: normalizeMetadata(body.metadata),
    });
    return reply.send(ok('Charge attempted', await decorate(payment)));
  });

  /**
   * Partial debit (spec §33).
   *
   * Paystack debits up to `amount` and no less than `at_least`. The emulator
   * has no notion of a balance behind a card, so it debits the full requested
   * amount and enforces only the arithmetic the caller can get wrong --
   * `at_least` exceeding `amount`, which is always a bug in the request.
   */
  fastify.post('/transaction/partial_debit', async (request, reply) => {
    authenticate(request);
    const body = partialDebitSchema.parse(request.body);
    const currency = body.currency.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `Currency ${currency} is not supported.`);
    }
    const atLeast = body.at_least == null ? null : Number(body.at_least);
    if (atLeast != null && Number.isFinite(atLeast) && atLeast > body.amount) {
      throw new PayboxError(
        'validation_failed',
        `at_least (${atLeast}) cannot exceed amount (${body.amount}).`,
        { details: { at_least: atLeast, amount: body.amount } },
      );
    }

    const payment = await chargeStoredAuthorization({
      authorizationCode: body.authorization_code,
      email: body.email,
      amount: body.amount,
      currency,
      reference: body.reference,
    });
    return reply.send(ok('Charge attempted', await decorate(payment)));
  });

  /**
   * Direct charge (spec §33 mobile money / card / bank).
   *
   * Mobile money is asynchronous at Paystack: the API returns immediately with
   * a prompt-pending status and the real outcome arrives later by webhook.
   * That asymmetry is one of the hardest things to test against a sandbox, so
   * the emulator reproduces it exactly rather than returning a settled result.
   */
  fastify.post('/charge', async (request, reply) => {
    authenticate(request);
    const body = chargeSchema.parse(request.body);
    const currency = (body.currency ?? 'GHS').toUpperCase();

    let method: PaymentMethod = 'card';
    let identifier: string | null = null;
    let details: Record<string, unknown> = {};

    if (body.mobile_money) {
      method = 'mobile_money';
      identifier = body.mobile_money.phone;
      details = {
        phone: body.mobile_money.phone,
        network: body.mobile_money.provider,
        country: 'GH',
      };
    } else if (body.card) {
      method = 'card';
      identifier = body.card.number;
      const masked = maskInstrument(body.card.number);
      // Only the masked fragments are ever persisted. The PAN is discarded
      // here and the CVV is never read at all (spec §29).
      details = {
        ...masked,
        exp_month: body.card.expiry_month ?? null,
        exp_year: body.card.expiry_year ?? null,
        brand: 'visa',
        card_type: 'visa',
        bank: 'TEST BANK',
      };
    } else if (body.bank) {
      method = 'bank';
      identifier = body.bank.account_number;
      details = { bank: body.bank.code, account_number: maskInstrument(body.bank.account_number).last4 };
    } else {
      throw new PayboxError(
        'validation_failed',
        'Supply one of mobile_money, card or bank on a charge request.',
      );
    }

    const customer = await engine.createCustomer({ provider: PROVIDER, email: body.email });
    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      paymentMethod: method,
      paymentMethodDetails: details,
      metadata: { ...normalizeMetadata(body.metadata), email: body.email },
      status: 'pending',
      providerStatus: 'pending',
      expiresInMs: 10 * 60_000,
    });

    // Mobile money goes straight to "awaiting customer authorization"; cards
    // and bank charges start processing immediately.
    const pending =
      method === 'mobile_money'
        ? await engine.transitionPayment(payment.id, 'requires_action', {
            providerStatus: 'ongoing',
          })
        : await engine.transitionPayment(payment.id, 'processing', {
            providerStatus: 'processing',
          });

    await scheduleOutcome(pending, identifier);

    const displayText =
      method === 'mobile_money'
        ? 'Please approve the payment prompt on your phone to complete this transaction.'
        : 'Your payment is being processed.';

    return reply.send(
      ok('Charge attempted', {
        reference: pending.reference,
        status: method === 'mobile_money' ? 'pay_offline' : 'processing',
        display_text: displayText,
        amount: pending.amount,
        currency: pending.currency,
        transaction: String(numericTransactionId(pending.providerTransactionId)),
      }),
    );
  });

  /* ---------------------------------------------------------------- *
   * Charge continuation steps
   *
   * Paystack's card flow is a conversation: a charge can come back asking for
   * a PIN, then an OTP, then succeed. Each step below advances a payment that
   * is parked in `requires_action` -- the state the `authentication_required`
   * test instrument leaves it in.
   * ---------------------------------------------------------------- */

  /** The OTP the emulator accepts. Any other value fails the charge. */
  const VALID_OTP = '123456';
  const VALID_PIN = '1234';

  async function requirePendingCharge(reference: string): Promise<Payment> {
    const payment = await loadTransaction(reference);
    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `Transaction ${reference} is not awaiting a customer action; it is ${payment.status}.`,
        { details: { reference, status: payment.status } },
      );
    }
    return payment;
  }

  /** Paystack's "next step" envelope, shared by the submit_* endpoints. */
  function nextStep(payment: Payment, status: string, displayText: string) {
    return ok('Charge attempted', {
      reference: payment.reference,
      status,
      display_text: displayText,
      amount: payment.amount,
      currency: payment.currency,
    });
  }

  fastify.post('/charge/submit_pin', async (request, reply) => {
    authenticate(request);
    const body = submitPinSchema.parse(request.body);
    const payment = await requirePendingCharge(body.reference);
    if (body.pin !== VALID_PIN) {
      const failed = await simulator.apply(payment.id, 'authentication_failed');
      return reply.send(ok('Charge attempted', await decorate(failed)));
    }
    // A correct PIN does not settle anything: Paystack answers by asking for
    // the OTP, and the payment stays parked awaiting it.
    return reply.send(
      nextStep(payment, 'send_otp', 'Please enter the OTP sent to your phone'),
    );
  });

  fastify.post('/charge/submit_phone', async (request, reply) => {
    authenticate(request);
    const body = submitPhoneSchema.parse(request.body);
    const payment = await requirePendingCharge(body.reference);
    return reply.send(
      nextStep(payment, 'send_otp', 'Please enter the OTP sent to your phone'),
    );
  });

  fastify.post('/charge/submit_birthday', async (request, reply) => {
    authenticate(request);
    const body = submitBirthdaySchema.parse(request.body);
    const payment = await requirePendingCharge(body.reference);
    return reply.send(
      nextStep(payment, 'send_otp', 'Please enter the OTP sent to your phone'),
    );
  });

  /**
   * Submit the OTP that completes (or fails) a parked charge.
   *
   * The response is the full transaction object. Paystack's documented
   * `ChargeSubmitOtpResponse` is a strict subset of those fields plus
   * `redirect_url`, which is added here -- returning a superset keeps one
   * serializer and cannot break a client reading documented fields.
   */
  fastify.post('/charge/submit_otp', async (request, reply) => {
    authenticate(request);
    const body = submitOtpSchema.parse(request.body);
    const payment = await requirePendingCharge(body.reference);

    // A wrong OTP is an authentication failure, not a customer rejection --
    // they are different `gateway_response` strings and different failure
    // codes, and conflating them would misreport why the charge died.
    const settled =
      body.otp === VALID_OTP
        ? await simulator.apply(payment.id, 'success')
        : await simulator.apply(payment.id, 'authentication_failed');
    return reply.send(
      ok('Charge attempted', {
        ...(await decorate(settled)),
        redirect_url: settled.callbackUrl,
      }),
    );
  });

  /**
   * Poll a charge that came back pending (spec §33).
   *
   * Paystack's guidance is to wait ten seconds or more before calling this.
   * Under a frozen clock that wait is `paybox time advance 10s`, which is the
   * whole reason this endpoint is worth having locally.
   */
  fastify.get<{ Params: { reference: string } }>(
    '/charge/:reference',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadTransaction(request.params.reference);
      return reply.send(ok('Charge retrieved', await decorate(payment)));
    },
  );

  /* ---------------------------------------------------------------- *
   * Hosted checkout
   * ---------------------------------------------------------------- */

  fastify.get<{ Params: { accessCode: string } }>(
    '/checkout/:accessCode',
    async (request, reply) => {
      const payment = await storage.payments.byProviderTransactionId(
        PROVIDER,
        request.params.accessCode,
      );
      if (!payment) {
        return reply.status(404).type('text/html').send('<h1>Checkout session not found</h1>');
      }
      return reply
        .type('text/html')
        .send(
          renderCheckoutPage({
            payment,
            accessCode: request.params.accessCode,
            basePath: options.basePath,
          }),
        );
    },
  );

  fastify.post<{ Params: { accessCode: string } }>(
    '/checkout/:accessCode/pay',
    async (request, reply) => {
      const payment = await storage.payments.byProviderTransactionId(
        PROVIDER,
        request.params.accessCode,
      );
      if (!payment) {
        return reply.status(404).type('text/html').send('<h1>Checkout session not found</h1>');
      }
      const form = checkoutPaySchema.parse(request.body);
      const identifier = form.method === 'card' ? form.card_number : form.phone;

      const details =
        form.method === 'card'
          ? { ...maskInstrument(identifier ?? ''), brand: 'visa', card_type: 'visa', bank: 'TEST BANK' }
          : { phone: identifier ?? null, network: form.network ?? 'mtn', country: 'GH' };

      const started = await engine.transitionPayment(
        payment.id,
        form.method === 'mobile_money' ? 'requires_action' : 'processing',
        {
          providerStatus: form.method === 'mobile_money' ? 'ongoing' : 'processing',
          paymentMethod: form.method as PaymentMethod,
          paymentMethodDetails: details,
        },
      );
      await scheduleOutcome(started, identifier ?? null);

      return reply.type('text/html').send(
        renderCheckoutResult({
          payment: started,
          callbackUrl: started.callbackUrl,
          message:
            form.method === 'mobile_money'
              ? 'Approve the prompt on your phone'
              : 'Processing your payment',
        }),
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * Refunds
   * ---------------------------------------------------------------- */

  fastify.post('/refund', async (request, reply) => {
    authenticate(request);
    const body = refundSchema.parse(request.body);
    const payment = await loadTransaction(body.transaction);
    const refund = await engine.createRefund({
      paymentId: payment.id,
      amount: body.amount,
      reason: body.customer_note ?? body.merchant_note ?? null,
    });
    // Paystack queues refunds rather than settling them inline, so we do too.
    return reply
      .status(200)
      .send(ok('Refund has been queued for processing', serializeRefund(refund, payment)));
  });

  fastify.get<{ Params: { id: string } }>('/refund/:id', async (request, reply) => {
    authenticate(request);
    const refund =
      (await storage.refunds.byId(request.params.id)) ??
      (await storage.refunds.byProviderRefundId(PROVIDER, request.params.id));
    if (!refund) throw new PayboxError('not_found', `Refund ${request.params.id} not found.`);
    const payment = await storage.payments.byId(refund.paymentId);
    return reply.send(ok('Refund retrieved', serializeRefund(refund, payment)));
  });

  /* ---------------------------------------------------------------- *
   * Customers
   * ---------------------------------------------------------------- */

  fastify.post('/customer', async (request, reply) => {
    authenticate(request);
    const body = customerSchema.parse(request.body);
    const customer = await engine.createCustomer({
      provider: PROVIDER,
      email: body.email,
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      phone: body.phone ?? null,
      metadata: body.metadata ?? {},
    });
    return reply.send(ok('Customer created', serializeCustomer(customer)));
  });

  fastify.get<{ Params: { code: string } }>('/customer/:code', async (request, reply) => {
    authenticate(request);
    const code = request.params.code.replace(/^CUS_/, '');
    const customer =
      (await storage.customers.byProviderCustomerId(PROVIDER, code)) ??
      (await storage.customers.byId(request.params.code));
    if (!customer) {
      throw new PayboxError('not_found', `Customer ${request.params.code} not found.`);
    }
    return reply.send(ok('Customer retrieved', serializeCustomer(customer)));
  });

  fastify.get('/customer', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.customers.list({ limit: 100 });
    return reply.send({
      status: true,
      message: 'Customers retrieved',
      data: items.filter((c) => c.provider === PROVIDER).map(serializeCustomer),
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  /**
   * Deactivate a stored authorization.
   *
   * Irreversible, as at Paystack: there is no reactivate endpoint, and the
   * emulator does not invent one.
   */
  fastify.post('/customer/authorization/deactivate', async (request, reply) => {
    authenticate(request);
    const body = deactivateAuthorizationSchema.parse(request.body);
    const code = body.authorization_code.replace(/^AUTH_/, '');
    const authorization = await engine.resolveAuthorization(PROVIDER, code);
    if (!authorization) {
      throw new PayboxError(
        'not_found',
        `Authorization ${body.authorization_code} not found.`,
      );
    }
    const deactivated = await engine.deactivateAuthorization(authorization.id);
    return reply.send(
      ok('Authorization has been deactivated', {
        authorization_code: `AUTH_${deactivated.providerAuthorizationCode}`,
      }),
    );
  });

  /* ---------------------------------------------------------------- *
   * Transfers
   * ---------------------------------------------------------------- */

  fastify.post('/transferrecipient', async (request, reply) => {
    authenticate(request);
    const body = recipientSchema.parse(request.body);
    const now = clock.nowISO();
    const recipient = await storage.recipients.insert({
      id: ids.next('cus'),
      provider: PROVIDER,
      providerRecipientId: ids.token(12),
      type: body.type,
      name: body.name,
      accountNumber: body.account_number,
      bankCode: body.bank_code,
      bankName: null,
      currency: body.currency.toUpperCase(),
      metadata: body.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
    return reply.send(
      ok('Transfer recipient created successfully', {
        active: true,
        createdAt: recipient.createdAt,
        currency: recipient.currency,
        domain: 'test',
        id: numericTransactionId(recipient.providerRecipientId),
        integration: 100_000,
        name: recipient.name,
        recipient_code: `RCP_${recipient.providerRecipientId}`,
        type: recipient.type,
        updatedAt: recipient.updatedAt,
        is_deleted: false,
        details: {
          authorization_code: null,
          account_number: recipient.accountNumber,
          account_name: recipient.name,
          bank_code: recipient.bankCode,
          bank_name: recipient.bankName,
        },
      }),
    );
  });

  fastify.post('/transfer', async (request, reply) => {
    authenticate(request);
    const body = transferSchema.parse(request.body);
    const code = body.recipient.replace(/^RCP_/, '');
    const recipient = await storage.recipients.byProviderRecipientId(PROVIDER, code);
    if (!recipient) {
      throw new PayboxError('not_found', `Transfer recipient ${body.recipient} not found.`);
    }

    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: body.amount,
      currency: (body.currency ?? recipient.currency).toUpperCase(),
      reference: body.reference,
      recipientName: recipient.name,
      recipientAccount: recipient.accountNumber,
      recipientBankCode: recipient.bankCode,
      reason: body.reason ?? null,
      status: 'pending',
    });
    return reply.send(ok('Transfer has been queued', serializeTransfer(transfer)));
  });

  fastify.get<{ Params: { id: string } }>('/transfer/:id', async (request, reply) => {
    authenticate(request);
    const code = request.params.id.replace(/^TRF_/, '');
    const transfer =
      (await storage.transfers.byProviderTransferId(PROVIDER, code)) ??
      (await storage.transfers.byId(request.params.id));
    if (!transfer) {
      throw new PayboxError('not_found', `Transfer ${request.params.id} not found.`);
    }
    return reply.send(ok('Transfer retrieved', serializeTransfer(transfer)));
  });

};

/** Convenience for tests that want the plugin registered on a bare Fastify. */
export async function registerPaystack(
  fastify: FastifyInstance,
  options: PaystackPluginOptions,
): Promise<void> {
  await fastify.register(paystackPlugin, { ...options, prefix: options.basePath });
}

export type { FastifyReply };

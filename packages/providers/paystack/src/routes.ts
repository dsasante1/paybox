import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type IdFactory,
  type Dispute,
  type Payment,
  type PaymentMethod,
  type Refund,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import type { SubscriptionRunner } from '@paybox/simulator';
import {
  PAYMENT_SIMULATE_JOB,
  REFUND_SETTLE_JOB,
  maskInstrument,
  outcomeFromMetadata,
  resolveInstrument,
  type PaymentSimulator,
} from '@paybox/simulator';
import {
  checkoutPaySchema,
  chargeAuthorizationSchema,
  chargeSchema,
  customerSchema,
  deactivateAuthorizationSchema,
  dedicatedAccountAssignSchema,
  dedicatedAccountCreateSchema,
  disputeEvidenceSchema,
  disputeOpenSchema,
  disputeResolveSchema,
  initializeSchema,
  normalizeMetadata,
  partialDebitSchema,
  planCreateSchema,
  planUpdateSchema,
  recipientSchema,
  refundRetrySchema,
  refundSchema,
  submitBirthdaySchema,
  submitOtpSchema,
  submitPhoneSchema,
  splitCreateSchema,
  splitSubaccountSchema,
  splitUpdateSchema,
  subaccountCreateSchema,
  subaccountUpdateSchema,
  submitPinSchema,
  subscriptionCreateSchema,
  subscriptionToggleSchema,
  transferSchema,
} from './schemas.js';
import {
  fail,
  numericTransactionId,
  ok,
  serializeCustomer,
  serializeDedicatedAccount,
  serializeDispute,
  serializeInvoice,
  serializePlan,
  serializeRefund,
  serializeSplit,
  serializeSubaccount,
  serializeSubscription,
  serializeTransaction,
  serializeTransfer,
} from './serializers.js';
import { toPaystackError } from './errors.js';
import { assertPaystackCredentials } from './auth.js';
import { renderCheckoutPage, renderCheckoutResult } from './checkout.js';
import {
  fromPaystackDisputeStatus,
  fromPaystackStatus,
  toPaystackStatus,
} from './status.js';
import { paystackAuthorizationMinter } from './authorization.js';
import {
  expectedOtp,
  paystackInstrumentResolver,
  paystackRefundOutcome,
} from './instruments.js';
import {
  destinationForRecipientType,
  paystackTransferFee,
  transferFeeRefundable,
} from './fees.js';

export interface PaystackPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  /** Drives recurring billing; renewals are scheduled through it. */
  subscriptions: SubscriptionRunner;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  /** Public origin, e.g. http://localhost:8080 — used to build checkout URLs. */
  baseUrl: string;
  /** Mount path, e.g. /paystack. */
  basePath: string;
  allowAnyKey?: boolean;
  includeFees?: boolean;
  /** Transfer fee per currency, in minor units. See PayboxConfig.balance. */
  transferFee?: Record<string, number>;
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
  const { engine, simulator, subscriptions, storage, clock, ids } = options;
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
      const match = await findByNumericId(
        numeric,
        (p: Payment) => p.providerTransactionId,
        (limit, offset) => storage.payments.list({ provider: PROVIDER, limit, offset }),
      );
      if (match) return match;
    }
    throw new PayboxError('not_found', `Transaction ${handle} not found.`);
  }

  async function decorate(payment: Payment) {
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    const events = await storage.events.listByResource(payment.id);
    const split = await splitFor(payment);
    return serializeTransaction(payment, {
      customer,
      events,
      includeFees,
      authorization: await storedAuthorization(payment),
      split,
      // Only report a breakdown once money actually moved. Showing shares of
      // a payment that never succeeded would misrepresent what was settled.
      ...(split && payment.status === 'successful'
        ? { splitBreakdown: engine.computeSplit(split, payment.amount) }
        : {}),
    });
  }

  /** The split a transaction was created under, recorded in its metadata. */
  async function splitFor(payment: Payment) {
    const code = payment.metadata.split_code;
    if (typeof code !== 'string' || code.length === 0) return null;
    return storage.splits.byCode(PROVIDER, code.replace(/^SPL_/, ''));
  }

  /**
   * Serialise a page of transactions with a fixed number of queries.
   *
   * `decorate` costs four queries per payment, which on a 200-row page is 800
   * against a synchronous SQLite driver that serialises them -- so the page
   * blocks the event loop for the whole run. This batches each lookup into one
   * query regardless of page size.
   */
  async function decorateMany(payments: readonly Payment[]) {
    if (payments.length === 0) return [];

    const customers = await storage.customers.byIds(
      payments.map((p) => p.customerId).filter((id): id is string => id !== null),
    );
    const events = await storage.events.listByResources(payments.map((p) => p.id));

    // Only settled payments can carry an authorization or a split breakdown,
    // so unsettled rows contribute nothing to either lookup.
    const settled = payments.filter((p) => p.status === 'successful');
    const authorizations = await storage.authorizations.byCodes(
      PROVIDER,
      payments
        .map((p) => paystackAuthorizationMinter(p)?.providerAuthorizationCode)
        .filter((code): code is string => typeof code === 'string'),
    );
    const splits = await storage.splits.byCodes(
      PROVIDER,
      settled
        .map((p) => p.metadata.split_code)
        .filter((code): code is string => typeof code === 'string')
        .map((code) => code.replace(/^SPL_/, '')),
    );

    return payments.map((payment) => {
      const draft = paystackAuthorizationMinter(payment);
      const rawSplit = payment.metadata.split_code;
      const split =
        typeof rawSplit === 'string' ? (splits.get(rawSplit.replace(/^SPL_/, '')) ?? null) : null;
      return serializeTransaction(payment, {
        customer: payment.customerId ? (customers.get(payment.customerId) ?? null) : null,
        events: events.get(payment.id) ?? [],
        includeFees,
        authorization: draft?.providerAuthorizationCode
          ? (authorizations.get(draft.providerAuthorizationCode) ?? null)
          : null,
        split,
        ...(split && payment.status === 'successful'
          ? { splitBreakdown: engine.computeSplit(split, payment.amount) }
          : {}),
      });
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

    const { outcome } = resolveInstrument(authorization.last4, authorization.channel, {
      resolver: paystackInstrumentResolver,
    });
    return simulator.apply(payment.id, outcome);
  }

  /** Schedule the outcome implied by a test instrument. */
  async function scheduleOutcome(
    payment: Payment,
    identifier: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!autoAdvance) return;
    const { outcome } = resolveInstrument(identifier, payment.paymentMethod, {
      override: outcomeFromMetadata(metadata),
      resolver: paystackInstrumentResolver,
    });
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
      metadata: {
        ...normalizeMetadata(body.metadata),
        email: body.email,
        ...(body.split_code ? { split_code: body.split_code } : {}),
        ...(body.subaccount ? { subaccount: body.subaccount } : {}),
      },
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

  fastify.get<{
    Querystring: {
      perPage?: string;
      page?: string;
      status?: string;
      from?: string;
      to?: string;
      customer?: string;
    };
  }>(
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
        ...normalizeDateRange(request.query.from, request.query.to),
      });
      const data = await decorateMany(items);
      return reply.send({
        status: true,
        message: 'Transactions retrieved',
        data,
        meta: { total, skipped: (pageNumber - 1) * perPage, perPage, page: pageNumber },
      });
    },
  );

  /**
   * The transaction's own history.
   *
   * Paystack's `log` object, served on its own. It is built from the canonical
   * event timeline, so it is genuinely the sequence the payment went through
   * rather than a stub.
   */
  fastify.get<{ Params: { id: string } }>(
    '/transaction/timeline/:id',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadTransaction(request.params.id);
      const decorated = await decorate(payment);
      return reply.send(ok('Timeline retrieved', decorated.log));
    },
  );

  /**
   * Volume totals.
   *
   * Only successful transactions count toward a total -- an attempted charge
   * that failed moved no money, and including it would overstate revenue.
   */
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/transaction/totals',
    async (request, reply) => {
      authenticate(request);
      const range = normalizeDateRange(request.query.from, request.query.to);

      // Aggregated across every matching row, not across one page: summing a
      // page would silently disagree with the count printed beside it.
      const volumes = await storage.payments.sumByCurrency({
        provider: PROVIDER,
        statuses: SETTLED_STATUSES,
        ...range,
      });
      const { total } = await storage.payments.list({
        provider: PROVIDER,
        limit: 1,
        ...range,
      });

      return reply.send(
        ok('Transaction totals', {
          total_transactions: total,
          total_volume: volumes.reduce((sum, v) => sum + v.amount, 0),
          total_volume_by_currency: volumes.map((v) => ({
            currency: v.currency,
            amount: v.amount,
          })),
          pending_transfers: 0,
          pending_transfers_by_currency: [],
        }),
      );
    },
  );

  /**
   * Export.
   *
   * Paystack answers with a link to a generated CSV. The emulator writes no
   * files, so it returns the rows inline under `data.rows` alongside the
   * documented `path`. docs/paystack.md says the path is not fetchable.
   */
  fastify.get<{ Querystring: { from?: string; to?: string; status?: string } }>(
    '/transaction/export',
    async (request, reply) => {
      authenticate(request);
      const canonical = request.query.status
        ? fromPaystackStatus(request.query.status)
        : undefined;
      const filter = {
        provider: PROVIDER,
        ...(canonical ? { status: canonical } : {}),
        ...normalizeDateRange(request.query.from, request.query.to),
      };

      // Paged to exhaustion. A truncated export is worse than a slow one: it
      // looks complete and is not.
      const items = await collectAll((limit, offset) =>
        storage.payments.list({ ...filter, limit, offset }),
      );

      const rows = items.map((payment) => ({
        id: numericTransactionId(payment.providerTransactionId),
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        status: toPaystackStatus(payment.status),
        channel: payment.paymentMethod,
        paid_at: payment.paidAt,
        created_at: payment.createdAt,
      }));

      return reply.send(
        ok('Export successful', {
          path: `${options.baseUrl}${options.basePath}/transaction/export.csv`,
          expiresAt: new Date(clock.now() + 60 * 60_000).toISOString(),
          total: rows.length,
          rows,
        }),
      );
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
      metadata: {
        ...normalizeMetadata(body.metadata),
        ...(body.split_code ? { split_code: body.split_code } : {}),
        ...(body.subaccount ? { subaccount: body.subaccount } : {}),
      },
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
  /**
   * How each channel presents itself on the wire.
   *
   * `parks` means the charge stops at `requires_action` because the customer
   * has to do something out of band -- approve a prompt, dial a code, sign in
   * at their bank. Everything else starts processing immediately.
   *
   * NOTE: the `status` and `display_text` strings below are **modelled, not
   * verified**. Paystack's OpenAPI specification types every `/charge`
   * response as a generic transaction object and contains no `pay_offline`,
   * `send_otp` or `ussd_code` field, so the envelope cannot be machine-checked
   * against it. docs/paystack.md says so plainly.
   */
  const CHANNEL_PRESENTATION = {
    mobile_money: {
      parks: true,
      status: 'pay_offline',
      displayText:
        'Please approve the payment prompt on your phone to complete this transaction.',
    },
    ussd: {
      parks: true,
      status: 'pay_offline',
      // Filled in per charge: Paystack embeds the dial string in the text.
      displayText: '',
    },
    eft: {
      parks: true,
      status: 'pay_offline',
      displayText: 'Please complete the payment in your banking app.',
    },
    card: { parks: false, status: 'processing', displayText: 'Your payment is being processed.' },
    bank: { parks: false, status: 'processing', displayText: 'Your payment is being processed.' },
  } as const satisfies Partial<
    Record<PaymentMethod, { parks: boolean; status: string; displayText: string }>
  >;

  fastify.post('/charge', async (request, reply) => {
    authenticate(request);
    const body = chargeSchema.parse(request.body);
    const currency = (body.currency ?? 'GHS').toUpperCase();

    // Paystack's spec composes /charge from one channel object at a time.
    // Two at once is ambiguous, so refuse rather than silently picking one.
    const supplied = (['mobile_money', 'card', 'bank', 'ussd', 'eft'] as const).filter(
      (key) => body[key] != null,
    );
    if (supplied.length === 0) {
      throw new PayboxError(
        'validation_failed',
        'Supply one of mobile_money, card, bank, ussd or eft on a charge request.',
      );
    }
    if (supplied.length > 1) {
      throw new PayboxError(
        'validation_failed',
        `Supply exactly one channel on a charge request; received ${supplied.join(', ')}.`,
        { details: { channels: supplied } },
      );
    }

    let method: PaymentMethod;
    let identifier: string | null = null;
    let details: Record<string, unknown> = {};
    let ussdCode: string | null = null;

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
      details = {
        bank: body.bank.code,
        account_number: maskInstrument(body.bank.account_number).last4,
      };
    } else if (body.ussd) {
      method = 'ussd';
      // A USSD charge carries only a bank code from a fixed enum -- there are
      // no last four digits to select an outcome from, which is exactly what
      // `metadata.paybox_outcome` exists for.
      ussdCode = buildUssdCode(body.ussd.type, body.reference ?? body.email);
      details = { bank_code: body.ussd.type, ussd_code: ussdCode, country: 'NG' };
    } else if (body.eft) {
      method = 'eft';
      details = { provider: body.eft.provider, country: 'ZA' };
    } else {
      throw new PayboxError('validation_failed', 'Unsupported charge channel.');
    }

    const metadata = normalizeMetadata(body.metadata);
    const customer = await engine.createCustomer({ provider: PROVIDER, email: body.email });
    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      paymentMethod: method,
      paymentMethodDetails: details,
      metadata: {
        ...metadata,
        email: body.email,
        ...(body.split_code ? { split_code: body.split_code } : {}),
        ...(body.subaccount ? { subaccount: body.subaccount } : {}),
      },
      status: 'pending',
      providerStatus: 'pending',
      expiresInMs: 10 * 60_000,
    });

    const presentation = CHANNEL_PRESENTATION[method];
    const pending = presentation.parks
      ? await engine.transitionPayment(payment.id, 'requires_action', {
          providerStatus: 'ongoing',
        })
      : await engine.transitionPayment(payment.id, 'processing', {
          providerStatus: 'processing',
        });

    await scheduleOutcome(pending, identifier, metadata);

    return reply.send(
      ok('Charge attempted', {
        reference: pending.reference,
        status: presentation.status,
        display_text: ussdCode
          ? `Please dial ${ussdCode} on your mobile phone to complete the transaction`
          : presentation.displayText,
        amount: pending.amount,
        currency: pending.currency,
        transaction: String(numericTransactionId(pending.providerTransactionId)),
        ...(ussdCode ? { ussd_code: ussdCode } : {}),
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

  /**
   * The OTP a given charge accepts.
   *
   * Most instruments use `123456`, which is what Paystack publishes for their
   * card flows. Their Orange CIV mobile-money number uses `1234` instead, so
   * the expected value is looked up from whatever identifier the payment
   * retained rather than being a single constant.
   */
  function otpFor(payment: Payment): string {
    const details = payment.paymentMethodDetails;
    const identifier =
      typeof details.phone === 'string' ? details.phone : (details.last4 as string | undefined);
    return expectedOtp(identifier);
  }

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
      body.otp === otpFor(payment)
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

    // Paystack queues refunds rather than settling them inline, so we do too --
    // and then actually settle them, driven by the instrument behind the
    // payment. Two of Paystack's published cards exist precisely to send a
    // refund down the failed and needs-attention paths.
    await scheduleRefundOutcome(refund.id, payment);

    return reply
      .status(200)
      .send(ok('Refund has been queued for processing', serializeRefund(refund, payment)));
  });

  /** Play a queued refund out over virtual time, as the processor would. */
  async function scheduleRefundOutcome(refundId: string, payment: Payment): Promise<void> {
    if (!autoAdvance) return;
    const last4 = payment.paymentMethodDetails.last4;
    const outcome = paystackRefundOutcome(typeof last4 === 'string' ? last4 : null);
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: REFUND_SETTLE_JOB,
      payload: { refundId, outcome },
      status: 'ready',
      runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `refund:${refundId}`,
      createdAt: clock.nowISO(),
      updatedAt: clock.nowISO(),
    });
  }

  async function requireRefund(handle: string) {
    const refund =
      (await storage.refunds.byId(handle)) ??
      (await storage.refunds.byProviderRefundId(PROVIDER, handle));
    if (refund) return refund;

    const numeric = Number(handle);
    if (Number.isFinite(numeric)) {
      const match = await findByNumericId(
        numeric,
        (r: Refund) => r.providerRefundId,
        (limit, offset) => storage.refunds.list({ limit, offset }),
      );
      if (match) return match;
    }
    throw new PayboxError('not_found', `Refund ${handle} not found.`);
  }

  /**
   * Recover a refund that stalled for want of bank details.
   *
   * Paystack returns **422** when the refund is not in `needs-attention`, and
   * says so explicitly: "Use this endpoint only when you receive a
   * refund.needs-attention webhook event." Reproducing that refusal is the
   * point -- calling it speculatively is a bug this should surface.
   */
  fastify.post<{ Params: { id: string } }>(
    '/refund/retry_with_customer_details/:id',
    async (request, reply) => {
      authenticate(request);
      const body = refundRetrySchema.parse(request.body);
      const refund = await requireRefund(request.params.id);

      if (refund.status !== 'needs_attention') {
        return reply.status(422).send(
          fail(
            `Refund ${request.params.id} is ${refund.providerStatus}, not needs-attention. ` +
              'Use this endpoint only after a refund.needs-attention event.',
            { code: 'invalid_state_transition' },
          ),
        );
      }

      // Paystack: the account currency "should be the same as the currency the
      // payment was made". A mismatch cannot be settled, so refuse it here
      // rather than accepting details that could never be used.
      const supplied = body.refund_account_details.currency.toUpperCase();
      if (supplied !== refund.currency) {
        throw new PayboxError(
          'validation_failed',
          `Refund account currency ${supplied} does not match the refund's ${refund.currency}.`,
          { details: { supplied, expected: refund.currency } },
        );
      }

      // Bank details supplied: the refund goes back on the processing path.
      const retried = await engine.transitionRefund(refund.id, 'processing', {
        accountDetails: { ...body.refund_account_details },
      });

      // The retry is not guaranteed to work. Re-resolve the outcome from the
      // instrument so a card documented as failing its refund keeps failing
      // -- a retry that always succeeds would make the give-up path
      // untestable.
      const payment = await storage.payments.byId(retried.paymentId);
      const last4 = payment?.paymentMethodDetails.last4;
      const outcome = paystackRefundOutcome(typeof last4 === 'string' ? last4 : null);
      const settled = await engine.transitionRefund(
        retried.id,
        outcome === 'needs_attention' ? 'successful' : outcome,
      );
      return reply.send(ok('Refund retry successful', serializeRefund(settled, payment)));
    },
  );

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

  fastify.get<{ Querystring: { perPage?: string; page?: string; search?: string } }>(
    '/customer',
    async (request, reply) => {
      authenticate(request);
      const perPage = Math.min(Number(request.query.perPage ?? 50) || 50, 200);
      const pageNumber = Math.max(Number(request.query.page ?? 1) || 1, 1);
      // Filtering and paging in SQL, not in memory: the previous version
      // fetched 100 rows and filtered afterwards, so page 2 was wrong and a
      // provider filter could silently drop rows out of the page.
      const { items, total } = await storage.customers.list({
        provider: PROVIDER,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
        ...(request.query.search ? { search: request.query.search } : {}),
      });
      return reply.send({
        status: true,
        message: 'Customers retrieved',
        data: items.map(serializeCustomer),
        meta: { total, skipped: (pageNumber - 1) * perPage, perPage, page: pageNumber },
      });
    },
  );

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
   * Plans and subscriptions
   * ---------------------------------------------------------------- */

  fastify.post('/plan', async (request, reply) => {
    authenticate(request);
    const body = planCreateSchema.parse(request.body);
    const currency = (body.currency ?? 'NGN').toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `Currency ${currency} is not supported.`);
    }

    const plan = await engine.createPlan({
      provider: PROVIDER,
      name: body.name,
      amount: body.amount,
      currency,
      interval: body.interval,
      description: body.description ?? null,
      invoiceLimit: body.invoice_limit == null ? 0 : Number(body.invoice_limit),
      ...(body.send_invoices !== undefined ? { sendInvoices: body.send_invoices } : {}),
      ...(body.send_sms !== undefined ? { sendSms: body.send_sms } : {}),
    });
    return reply.status(201).send(ok('Plan created', serializePlan(plan)));
  });

  fastify.get('/plan', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.plans.list({ provider: PROVIDER, limit: 100 });
    return reply.send({
      status: true,
      message: 'Plans retrieved',
      data: items.map(serializePlan),
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  async function requirePlan(handle: string) {
    const code = handle.replace(/^PLN_/, '');
    const plan =
      (await storage.plans.byCode(PROVIDER, code)) ?? (await storage.plans.byId(handle));
    if (!plan) throw new PayboxError('not_found', `Plan ${handle} not found.`);
    return plan;
  }

  fastify.get<{ Params: { code: string } }>('/plan/:code', async (request, reply) => {
    authenticate(request);
    return reply.send(ok('Plan retrieved', serializePlan(await requirePlan(request.params.code))));
  });

  fastify.put<{ Params: { code: string } }>('/plan/:code', async (request, reply) => {
    authenticate(request);
    const body = planUpdateSchema.parse(request.body);
    const plan = await requirePlan(request.params.code);
    // Amount and interval are deliberately not updatable here: changing either
    // on a plan with live subscriptions would silently reprice them, and
    // Paystack does not repricing existing subscriptions either.
    const updated = await engine.updatePlan(plan.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.send_invoices !== undefined ? { sendInvoices: body.send_invoices } : {}),
      ...(body.send_sms !== undefined ? { sendSms: body.send_sms } : {}),
    });
    return reply.send(ok('Plan updated', serializePlan(updated)));
  });

  /**
   * Start a subscription.
   *
   * `authorization` is optional at Paystack: omitted, it uses the customer's
   * most recent one. Resolving that is adapter work, so the engine only ever
   * sees a concrete, chargeable instrument.
   */
  fastify.post('/subscription', async (request, reply) => {
    authenticate(request);
    const body = subscriptionCreateSchema.parse(request.body);

    const customerCode = body.customer.replace(/^CUS_/, '');
    const customer =
      (await storage.customers.byProviderCustomerId(PROVIDER, customerCode)) ??
      (await storage.customers.byEmail(PROVIDER, body.customer)) ??
      (await storage.customers.byId(body.customer));
    if (!customer) {
      throw new PayboxError('not_found', `Customer ${body.customer} not found.`);
    }

    const plan = await requirePlan(body.plan);

    const authorization = body.authorization
      ? await engine.resolveAuthorization(PROVIDER, body.authorization.replace(/^AUTH_/, ''))
      : (await storage.authorizations.listByCustomer(customer.id)).find((a) => a.reusable);
    if (!authorization) {
      throw new PayboxError(
        'not_found',
        `No reusable authorization available for ${body.customer}. ` +
          'Charge a card for this customer first, then subscribe.',
        { details: { customer: body.customer } },
      );
    }

    const subscription = await engine.createSubscription({
      provider: PROVIDER,
      customerId: customer.id,
      planId: plan.id,
      authorizationId: authorization.id,
      startDate: body.start_date ?? null,
      ...(body.quantity != null ? { quantity: Number(body.quantity) } : {}),
    });
    await subscriptions.start(subscription);

    return reply.status(201).send(
      ok(
        'Subscription successfully created',
        serializeSubscription(subscription, { plan, customer, authorization }),
      ),
    );
  });

  fastify.get('/subscription', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.subscriptions.list({
      provider: PROVIDER,
      limit: 100,
    });
    const data = await Promise.all(items.map((s) => decorateSubscription(s)));
    return reply.send({
      status: true,
      message: 'Subscriptions retrieved',
      data,
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  async function decorateSubscription(subscription: Awaited<
    ReturnType<typeof engine.createSubscription>
  >) {
    return serializeSubscription(subscription, {
      plan: await storage.plans.byId(subscription.planId),
      customer: await storage.customers.byId(subscription.customerId),
      authorization: await storage.authorizations.byId(subscription.authorizationId),
    });
  }

  async function requireSubscription(handle: string) {
    const code = handle.replace(/^SUB_/, '');
    const subscription =
      (await storage.subscriptions.byCode(PROVIDER, code)) ??
      (await storage.subscriptions.byId(handle));
    if (!subscription) {
      throw new PayboxError('not_found', `Subscription ${handle} not found.`);
    }
    return subscription;
  }

  fastify.get<{ Params: { code: string } }>('/subscription/:code', async (request, reply) => {
    authenticate(request);
    const subscription = await requireSubscription(request.params.code);
    return reply.send(ok('Subscription retrieved', await decorateSubscription(subscription)));
  });

  /**
   * Stop renewing. Paystack requires the email token as well as the code --
   * it is what authorises a customer-initiated cancellation from an email
   * link, so the emulator checks it rather than accepting any value.
   */
  fastify.post('/subscription/disable', async (request, reply) => {
    authenticate(request);
    const body = subscriptionToggleSchema.parse(request.body);
    const subscription = await requireSubscription(body.code);
    if (body.token !== subscription.emailToken) {
      throw new PayboxError('authentication_failed', 'Invalid subscription email token.');
    }
    await engine.transitionSubscription(subscription.id, 'non_renewing');
    return reply.send(ok('Subscription disabled successfully', true));
  });

  fastify.post('/subscription/enable', async (request, reply) => {
    authenticate(request);
    const body = subscriptionToggleSchema.parse(request.body);
    const subscription = await requireSubscription(body.code);
    if (body.token !== subscription.emailToken) {
      throw new PayboxError('authentication_failed', 'Invalid subscription email token.');
    }
    const resumed = await engine.transitionSubscription(subscription.id, 'active', {
      nextPaymentDate: clock.nowISO(),
    });
    await subscriptions.start(resumed);
    return reply.send(ok('Subscription enabled successfully', true));
  });

  fastify.get<{ Params: { code: string } }>(
    '/subscription/:code/manage/link',
    async (request, reply) => {
      authenticate(request);
      const subscription = await requireSubscription(request.params.code);
      return reply.send(
        ok('Link generated', {
          link: `${options.baseUrl}${options.basePath}/subscription/manage/${subscription.emailToken}`,
        }),
      );
    },
  );

  /** Billing history. Not a Paystack endpoint shape; see docs/paystack.md. */
  fastify.get<{ Params: { code: string } }>(
    '/subscription/:code/invoices',
    async (request, reply) => {
      authenticate(request);
      const subscription = await requireSubscription(request.params.code);
      const invoices = await storage.invoices.listBySubscription(subscription.id);
      const data = await Promise.all(
        invoices.map(async (invoice) =>
          serializeInvoice(
            invoice,
            invoice.paymentId ? await storage.payments.byId(invoice.paymentId) : null,
          ),
        ),
      );
      return reply.send(ok('Invoices retrieved', data));
    },
  );

  /* ---------------------------------------------------------------- *
   * Dedicated virtual accounts
   *
   * A DVA is an inbound rail: money transferred into the account number is
   * attributed to its customer. The numbers minted here are synthetic and
   * belong to no bank (spec §29).
   * ---------------------------------------------------------------- */

  /**
   * The banks that can back a DVA.
   *
   * Paystack exposes this through `GET /dedicated_account/available_providers`
   * and the real list varies by integration and country. These three are the
   * ones Paystack's own documentation uses in its examples; the emulator
   * treats the list as closed so that an unavailable bank produces the
   * assignment failure a developer needs to handle.
   */
  const DVA_PROVIDERS = [
    { provider_slug: 'titan-paystack', bank_name: 'Titan Paystack', id: 1, bank_id: 302 },
    { provider_slug: 'wema-bank', bank_name: 'Wema Bank', id: 2, bank_id: 20 },
    { provider_slug: 'paystack-mfb', bank_name: 'Paystack-Titan MFB', id: 3, bank_id: 807 },
  ] as const;

  const DEFAULT_DVA_PROVIDER = DVA_PROVIDERS[0];

  /**
   * A synthetic ten-digit NUBAN.
   *
   * Derived from the customer code so the same customer always gets the same
   * number under a fixed seed, which keeps integration tests reproducible.
   */
  function syntheticAccountNumber(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) % 1_000_000_000;
    }
    return String(1_000_000_000 + hash).slice(0, 10);
  }

  async function assignAccount(
    customer: Awaited<ReturnType<typeof engine.createCustomer>>,
    preferredBank: string | undefined,
    currency: string,
  ) {
    const bank = preferredBank
      ? DVA_PROVIDERS.find((p) => p.provider_slug === preferredBank)
      : DEFAULT_DVA_PROVIDER;

    if (!bank) {
      // Record the failure so the `dedicatedaccount.assign.failed` webhook
      // fires, then answer with the error -- both halves happen in production.
      await engine.failDedicatedAccountAssignment({
        provider: PROVIDER,
        customerId: customer.id,
        reason: `Preferred bank "${preferredBank}" is not available.`,
      });
      throw new PayboxError(
        'validation_failed',
        `Preferred bank "${preferredBank}" is not available on this integration.`,
        {
          details: {
            available: DVA_PROVIDERS.map((p) => p.provider_slug),
          },
        },
      );
    }

    const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
    return engine.createDedicatedAccount({
      provider: PROVIDER,
      customerId: customer.id,
      accountNumber: syntheticAccountNumber(customer.providerCustomerId),
      accountName: name || customer.email,
      bankName: bank.bank_name,
      bankSlug: bank.provider_slug,
      currency,
    });
  }

  fastify.post('/dedicated_account', async (request, reply) => {
    authenticate(request);
    const body = dedicatedAccountCreateSchema.parse(request.body);
    const code = body.customer.replace(/^CUS_/, '');
    const customer =
      (await storage.customers.byProviderCustomerId(PROVIDER, code)) ??
      (await storage.customers.byId(body.customer));
    if (!customer) {
      throw new PayboxError('not_found', `Customer ${body.customer} not found.`);
    }

    const account = await assignAccount(customer, body.preferred_bank, 'NGN');
    return reply.send(
      ok('NUBAN successfully created', serializeDedicatedAccount(account, customer)),
    );
  });

  /** Creates the customer if needed, then assigns, per the documented flow. */
  fastify.post('/dedicated_account/assign', async (request, reply) => {
    authenticate(request);
    const body = dedicatedAccountAssignSchema.parse(request.body);

    const customer = await engine.createCustomer({
      provider: PROVIDER,
      email: body.email,
      firstName: body.first_name,
      lastName: body.last_name,
      phone: body.phone,
    });
    const account = await assignAccount(
      customer,
      body.preferred_bank,
      body.country === 'GH' ? 'GHS' : 'NGN',
    );

    return reply.send(
      ok('Assign dedicated account in progress', serializeDedicatedAccount(account, customer)),
    );
  });

  fastify.get('/dedicated_account/available_providers', async (request, reply) => {
    authenticate(request);
    return reply.send(ok('Dedicated account providers retrieved', DVA_PROVIDERS));
  });

  fastify.get('/dedicated_account', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.dedicatedAccounts.list({
      provider: PROVIDER,
      limit: 100,
    });
    const data = await Promise.all(
      items.map(async (account) =>
        serializeDedicatedAccount(account, await storage.customers.byId(account.customerId)),
      ),
    );
    return reply.send({
      status: true,
      message: 'Managed accounts successfully retrieved',
      data,
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  fastify.get<{ Params: { id: string } }>(
    '/dedicated_account/:id',
    async (request, reply) => {
      authenticate(request);
      const account =
        (await storage.dedicatedAccounts.byId(request.params.id)) ??
        (await storage.dedicatedAccounts.byProviderAccountId(PROVIDER, request.params.id)) ??
        (await storage.dedicatedAccounts.byAccountNumber(PROVIDER, request.params.id));
      if (!account) {
        throw new PayboxError('not_found', `Dedicated account ${request.params.id} not found.`);
      }
      const customer = await storage.customers.byId(account.customerId);
      return reply.send(
        ok('Dedicated account retrieved', serializeDedicatedAccount(account, customer)),
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * Disputes
   * ---------------------------------------------------------------- */

  async function requireDispute(handle: string) {
    const dispute =
      (await storage.disputes.byId(handle)) ??
      (await storage.disputes.byProviderDisputeId(PROVIDER, handle));
    if (dispute) return dispute;

    // Paystack addresses disputes by numeric id, so accept that too.
    const numeric = Number(handle);
    if (Number.isFinite(numeric)) {
      const match = await findByNumericId(
        numeric,
        (d: Dispute) => d.providerDisputeId,
        (limit, offset) => storage.disputes.list({ provider: PROVIDER, limit, offset }),
      );
      if (match) return match;
    }
    throw new PayboxError('not_found', `Dispute ${handle} not found.`);
  }

  async function decorateDispute(dispute: Awaited<ReturnType<typeof requireDispute>>) {
    return serializeDispute(dispute, await storage.payments.byId(dispute.paymentId));
  }

  /**
   * Open a dispute.
   *
   * **Emulator-only.** Paystack has no endpoint for this -- a chargeback
   * originates with the payer's bank, not the merchant. It exists here because
   * otherwise a dispute could never come into being locally, which would make
   * the whole flow untestable. Documented as emulator-specific.
   */
  fastify.post('/dispute', async (request, reply) => {
    authenticate(request);
    const body = disputeOpenSchema.parse(request.body);
    const payment = await loadTransaction(body.transaction);

    const dispute = await engine.createDispute({
      paymentId: payment.id,
      ...(body.category ? { category: body.category } : {}),
      ...(body.refund_amount !== undefined ? { refundAmount: body.refund_amount } : {}),
      ...(body.message ? { message: body.message } : {}),
    });
    await engine.scheduleDisputeReminder(dispute);

    return reply.status(201).send(ok('Dispute created', await decorateDispute(dispute)));
  });

  fastify.get<{ Querystring: { status?: string; perPage?: string; page?: string } }>(
    '/dispute',
    async (request, reply) => {
      authenticate(request);
      const perPage = Math.min(Number(request.query.perPage ?? 50) || 50, 200);
      const pageNumber = Math.max(Number(request.query.page ?? 1) || 1, 1);
      // Validated, not cast: an unrecognised filter should be a bad request,
      // not an empty 200 that reads as "no disputes".
      const canonical = request.query.status
        ? fromPaystackDisputeStatus(request.query.status)
        : undefined;

      const { items, total } = await storage.disputes.list({
        provider: PROVIDER,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
        ...(canonical ? { status: canonical } : {}),
      });
      const data = await Promise.all(items.map((d) => decorateDispute(d)));
      return reply.send({
        status: true,
        message: 'Disputes retrieved',
        data,
        meta: { total, skipped: (pageNumber - 1) * perPage, perPage, page: pageNumber },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/dispute/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(
      ok('Dispute retrieved', await decorateDispute(await requireDispute(request.params.id))),
    );
  });

  fastify.get<{ Params: { id: string } }>(
    '/dispute/transaction/:id',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadTransaction(request.params.id);
      const disputes = await storage.disputes.listByPayment(payment.id);
      const data = await Promise.all(disputes.map((d) => decorateDispute(d)));
      return reply.send(ok('Dispute retrieved', data));
    },
  );

  /** PUT, not POST -- the spec's `dispute_resolve` operation is a PUT. */
  fastify.put<{ Params: { id: string } }>('/dispute/:id/resolve', async (request, reply) => {
    authenticate(request);
    const body = disputeResolveSchema.parse(request.body);
    const dispute = await requireDispute(request.params.id);

    const resolved = await engine.resolveDispute(dispute.id, {
      resolution: body.resolution,
      message: body.message,
      ...(body.refund_amount !== undefined ? { refundAmount: body.refund_amount } : {}),
    });
    return reply.send(ok('Dispute successfully resolved', await decorateDispute(resolved)));
  });

  fastify.post<{ Params: { id: string } }>('/dispute/:id/evidence', async (request, reply) => {
    authenticate(request);
    const body = disputeEvidenceSchema.parse(request.body);
    const dispute = await requireDispute(request.params.id);
    const updated = await engine.addDisputeEvidence(dispute.id, { ...body });
    return reply.send(
      ok('Evidence created', {
        id: numericTransactionId(updated.providerDisputeId),
        ...body,
        dispute: numericTransactionId(updated.providerDisputeId),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }),
    );
  });

  /**
   * Upload URL for dispute attachments.
   *
   * The emulator stores no files. It returns a URL of the documented shape so
   * an integration's upload step does not have to be branched around, and
   * docs/paystack.md states that nothing is actually stored there.
   */
  fastify.get<{ Params: { id: string } }>(
    '/dispute/:id/upload_url',
    async (request, reply) => {
      authenticate(request);
      const dispute = await requireDispute(request.params.id);
      return reply.send(
        ok('Upload url generated', {
          signedUrl: `${options.baseUrl}${options.basePath}/dispute/${dispute.id}/upload`,
          fileName: `${dispute.providerDisputeId}.pdf`,
        }),
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * Marketplace: subaccounts, splits and balance
   * ---------------------------------------------------------------- */

  fastify.post('/subaccount', async (request, reply) => {
    authenticate(request);
    const body = subaccountCreateSchema.parse(request.body);
    const subaccount = await engine.createSubaccount({
      provider: PROVIDER,
      businessName: body.business_name,
      settlementBank: body.settlement_bank,
      accountNumber: body.account_number,
      percentageCharge: body.percentage_charge,
      currency: (body.currency ?? 'NGN').toUpperCase(),
      description: body.description ?? null,
      primaryContactEmail: body.primary_contact_email ?? null,
      primaryContactName: body.primary_contact_name ?? null,
      primaryContactPhone: body.primary_contact_phone ?? null,
      metadata: normalizeMetadata(body.metadata),
    });
    return reply.status(201).send(ok('Subaccount created', serializeSubaccount(subaccount)));
  });

  fastify.get('/subaccount', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.subaccounts.list({ provider: PROVIDER, limit: 100 });
    return reply.send({
      status: true,
      message: 'Subaccounts retrieved',
      data: items.map(serializeSubaccount),
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  async function requireSubaccount(handle: string) {
    const code = handle.replace(/^ACCT_/, '');
    const subaccount =
      (await storage.subaccounts.byCode(PROVIDER, code)) ??
      (await storage.subaccounts.byId(handle));
    if (!subaccount) throw new PayboxError('not_found', `Subaccount ${handle} not found.`);
    return subaccount;
  }

  fastify.get<{ Params: { code: string } }>('/subaccount/:code', async (request, reply) => {
    authenticate(request);
    const subaccount = await requireSubaccount(request.params.code);
    return reply.send(ok('Subaccount retrieved', serializeSubaccount(subaccount)));
  });

  fastify.put<{ Params: { code: string } }>('/subaccount/:code', async (request, reply) => {
    authenticate(request);
    const body = subaccountUpdateSchema.parse(request.body);
    const subaccount = await requireSubaccount(request.params.code);
    const updated = await storage.subaccounts.update(subaccount.id, {
      ...(body.business_name !== undefined ? { businessName: body.business_name } : {}),
      ...(body.settlement_bank !== undefined ? { settlementBank: body.settlement_bank } : {}),
      ...(body.account_number !== undefined ? { accountNumber: body.account_number } : {}),
      ...(body.percentage_charge !== undefined
        ? { percentageCharge: body.percentage_charge }
        : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      updatedAt: clock.nowISO(),
    });
    return reply.send(ok('Subaccount updated', serializeSubaccount(updated)));
  });

  /** Resolve `ACCT_...` codes to rows, preserving the caller's order. */
  async function resolveSplitEntries(
    entries: { subaccount: string; share: number }[],
  ): Promise<{ subaccountId: string; subaccountCode: string; share: number }[]> {
    const resolved = [];
    for (const entry of entries) {
      const subaccount = await requireSubaccount(entry.subaccount);
      resolved.push({
        subaccountId: subaccount.id,
        subaccountCode: subaccount.providerSubaccountCode,
        share: entry.share,
      });
    }
    return resolved;
  }

  async function decorateSplit(split: Awaited<ReturnType<typeof engine.createSplit>>) {
    const map = new Map<string, Awaited<ReturnType<typeof requireSubaccount>>>();
    for (const entry of split.entries) {
      const subaccount = await storage.subaccounts.byId(entry.subaccountId);
      if (subaccount) map.set(entry.subaccountId, subaccount);
    }
    return serializeSplit(split, map);
  }

  fastify.post('/split', async (request, reply) => {
    authenticate(request);
    const body = splitCreateSchema.parse(request.body);
    const split = await engine.createSplit({
      provider: PROVIDER,
      name: body.name,
      type: body.type,
      currency: body.currency,
      entries: await resolveSplitEntries(body.subaccounts),
      ...(body.bearer_type ? { bearerType: body.bearer_type } : {}),
      ...(body.bearer_subaccount
        ? { bearerSubaccountId: (await requireSubaccount(body.bearer_subaccount)).id }
        : {}),
    });
    return reply.status(201).send(ok('Split created', await decorateSplit(split)));
  });

  fastify.get('/split', async (request, reply) => {
    authenticate(request);
    const { items, total } = await storage.splits.list({ provider: PROVIDER, limit: 100 });
    const data = await Promise.all(items.map((split) => decorateSplit(split)));
    return reply.send({
      status: true,
      message: 'Splits retrieved',
      data,
      meta: { total, skipped: 0, perPage: 100, page: 1 },
    });
  });

  async function requireSplit(handle: string) {
    const code = handle.replace(/^SPL_/, '');
    const split =
      (await storage.splits.byCode(PROVIDER, code)) ?? (await storage.splits.byId(handle));
    if (!split) throw new PayboxError('not_found', `Split ${handle} not found.`);
    return split;
  }

  fastify.get<{ Params: { id: string } }>('/split/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(ok('Split retrieved', await decorateSplit(await requireSplit(request.params.id))));
  });

  fastify.put<{ Params: { id: string } }>('/split/:id', async (request, reply) => {
    authenticate(request);
    const body = splitUpdateSchema.parse(request.body);
    const split = await requireSplit(request.params.id);
    const updated = await storage.splits.update(split.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.bearer_type !== undefined ? { bearerType: body.bearer_type } : {}),
      updatedAt: clock.nowISO(),
    });
    return reply.send(ok('Split group updated', await decorateSplit(updated)));
  });

  fastify.post<{ Params: { id: string } }>(
    '/split/:id/subaccount/add',
    async (request, reply) => {
      authenticate(request);
      const body = splitSubaccountSchema.parse(request.body);
      const split = await requireSplit(request.params.id);
      const subaccount = await requireSubaccount(body.subaccount);

      // Re-check the total, or repeated adds could push a percentage split
      // past 100 one subaccount at a time.
      const others = split.entries.filter((e) => e.subaccountId !== subaccount.id);
      const total = others.reduce((sum, e) => sum + e.share, 0) + body.share;
      if (split.type === 'percentage' && total > 100) {
        throw new PayboxError(
          'validation_failed',
          `Adding ${body.share}% would bring the split to ${total}%, which exceeds 100.`,
          { details: { total } },
        );
      }

      const updated = await storage.splits.addSubaccount(split.id, subaccount.id, body.share);
      return reply.send(ok('Subaccount added', await decorateSplit(updated)));
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/split/:id/subaccount/remove',
    async (request, reply) => {
      authenticate(request);
      const body = z.object({ subaccount: z.string().min(1) }).parse(request.body);
      const split = await requireSplit(request.params.id);
      const subaccount = await requireSubaccount(body.subaccount);
      const updated = await storage.splits.removeSubaccount(split.id, subaccount.id);
      return reply.send(ok('Subaccount removed', await decorateSplit(updated)));
    },
  );

  /**
   * Balance, folded from the ledger.
   *
   * `GET /balance` reports every currency that has seen movement. A fresh
   * emulator has none, so it reports the opening float in the default
   * currency rather than an empty list, which would read as "broke".
   */
  fastify.get('/balance', async (request, reply) => {
    authenticate(request);
    const currencies = await storage.ledger.currencies(PROVIDER);
    const listed = currencies.length > 0 ? currencies : ['NGN'];
    const data = await Promise.all(
      listed.map(async (currency) => ({
        currency,
        balance: await engine.getBalance(PROVIDER, currency),
      })),
    );
    return reply.send(ok('Balances retrieved', data));
  });

  fastify.get<{ Querystring: { perPage?: string; page?: string; currency?: string } }>(
    '/balance/ledger',
    async (request, reply) => {
      authenticate(request);
      const perPage = Math.min(Number(request.query.perPage ?? 50) || 50, 200);
      const pageNumber = Math.max(Number(request.query.page ?? 1) || 1, 1);
      const { items, total } = await storage.ledger.list({
        provider: PROVIDER,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
        ...(request.query.currency ? { currency: request.query.currency.toUpperCase() } : {}),
      });
      return reply.send({
        status: true,
        message: 'Balance ledger retrieved',
        data: items.map((entry) => ({
          integration: 100_000,
          domain: 'test',
          balance: null,
          currency: entry.currency,
          difference: entry.direction === 'credit' ? entry.amount : -entry.amount,
          reason: entry.reason,
          model_responsible: entry.resourceId,
          model_row: entry.resourceId,
          created_at: entry.createdAt,
          updated_at: entry.createdAt,
        })),
        meta: { total, skipped: (pageNumber - 1) * perPage, perPage, page: pageNumber },
      });
    },
  );

  /* ---------------------------------------------------------------- *
   * Reference data
   *
   * A small fixed list, not Paystack's full directory. It exists so that
   * `transferrecipient` can resolve a bank name instead of returning null,
   * and so an integration that populates a bank dropdown has something to
   * populate it from. docs/paystack.md states the list is not exhaustive.
   * ---------------------------------------------------------------- */

  const BANKS = [
    { name: 'Access Bank', slug: 'access-bank', code: '044', country: 'Nigeria', currency: 'NGN', type: 'nuban' },
    { name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', code: '058', country: 'Nigeria', currency: 'NGN', type: 'nuban' },
    { name: 'Zenith Bank', slug: 'zenith-bank', code: '057', country: 'Nigeria', currency: 'NGN', type: 'nuban' },
    { name: 'United Bank For Africa', slug: 'united-bank-for-africa', code: '033', country: 'Nigeria', currency: 'NGN', type: 'nuban' },
    { name: 'First Bank of Nigeria', slug: 'first-bank-of-nigeria', code: '011', country: 'Nigeria', currency: 'NGN', type: 'nuban' },
    { name: 'MTN Mobile Money', slug: 'mtn', code: 'MTN', country: 'Ghana', currency: 'GHS', type: 'mobile_money' },
    { name: 'Telecel Cash', slug: 'telecel', code: 'VOD', country: 'Ghana', currency: 'GHS', type: 'mobile_money' },
    { name: 'AirtelTigo Money', slug: 'airteltigo', code: 'ATL', country: 'Ghana', currency: 'GHS', type: 'mobile_money' },
  ] as const;

  /** Look up a bank name for a code, for recipient enrichment. */
  function bankName(code: string | null): string | null {
    if (!code) return null;
    return BANKS.find((bank) => bank.code === code)?.name ?? null;
  }

  fastify.get<{ Querystring: { country?: string; currency?: string; type?: string } }>(
    '/bank',
    async (request, reply) => {
      authenticate(request);
      const country = request.query.country?.toLowerCase();
      const currency = request.query.currency?.toUpperCase();
      const type = request.query.type;

      const data = BANKS.filter(
        (bank) =>
          (!country || bank.country.toLowerCase() === country) &&
          (!currency || bank.currency === currency) &&
          (!type || bank.type === type),
      ).map((bank) => ({
        id: numericTransactionId(bank.code) % 1_000,
        name: bank.name,
        slug: bank.slug,
        code: bank.code,
        longcode: bank.code,
        gateway: null,
        pay_with_bank: false,
        active: true,
        country: bank.country,
        currency: bank.currency,
        type: bank.type,
        is_deleted: false,
      }));

      return reply.send(ok('Banks retrieved', data));
    },
  );

  fastify.get('/country', async (request, reply) => {
    authenticate(request);
    return reply.send(
      ok('Countries retrieved', [
        { id: 1, name: 'Nigeria', iso_code: 'NG', default_currency_code: 'NGN' },
        { id: 2, name: 'Ghana', iso_code: 'GH', default_currency_code: 'GHS' },
        { id: 3, name: 'South Africa', iso_code: 'ZA', default_currency_code: 'ZAR' },
        { id: 4, name: 'Kenya', iso_code: 'KE', default_currency_code: 'KES' },
      ]),
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
      bankName: bankName(body.bank_code),
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

    const transferCurrency = (body.currency ?? recipient.currency).toUpperCase();
    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: body.amount,
      currency: transferCurrency,
      reference: body.reference,
      recipientName: recipient.name,
      recipientAccount: recipient.accountNumber,
      recipientBankCode: recipient.bankCode,
      reason: body.reason ?? null,
      status: 'pending',
      // Paystack holds the fee alongside the amount, so the emulator has to
      // as well -- otherwise a transfer passes here that would be refused
      // there for being a few naira short. The rate follows their published
      // schedule: tiered by amount in NGN and KES, and split by destination
      // in GHS and KES.
      fee: paystackTransferFee({
        amount: body.amount,
        currency: transferCurrency,
        destination: destinationForRecipientType(recipient.type),
        override: options.transferFee?.[transferCurrency],
        enabled: includeFees,
      }),
      feeRefundable: transferFeeRefundable(transferCurrency),
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

/** Statuses in which money was actually collected. */
const SETTLED_STATUSES = ['successful', 'partially_refunded', 'refunded'] as const;

/** One repository page. `page()` in storage clamps this to 500. */
const PAGE_SIZE = 500;

/**
 * A hard ceiling on paged reads, so a runaway loop cannot exhaust memory.
 *
 * Far above any realistic local dataset. Reaching it means something is
 * wrong, and stopping is better than growing without bound.
 */
const MAX_PAGED_ROWS = 100_000;

/**
 * Read every page of a listing rather than only the first.
 *
 * The repository caps a single page at 500. Anything that needs *all* rows --
 * an export, a lookup by a derived id -- has to page, or it silently operates
 * on a 500-row window and reports a confidently wrong answer.
 */
async function collectAll<T>(
  fetch: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < MAX_PAGED_ROWS; offset += PAGE_SIZE) {
    const { items } = await fetch(PAGE_SIZE, offset);
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Find a row by the numeric id Paystack would have minted for it.
 *
 * The numeric form is a one-way hash of the provider id, so it cannot be
 * queried directly; the rows have to be scanned. Scanning only the newest
 * page -- which is what this used to do -- makes older resources return 404
 * for an id this API itself issued, so it pages to exhaustion and stops at
 * the first match.
 */
async function findByNumericId<T>(
  numeric: number,
  providerIdOf: (row: T) => string,
  fetch: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>,
): Promise<T | null> {
  for (let offset = 0; offset < MAX_PAGED_ROWS; offset += PAGE_SIZE) {
    const { items } = await fetch(PAGE_SIZE, offset);
    const match = items.find((row) => numericTransactionId(providerIdOf(row)) === numeric);
    if (match) return match;
    if (items.length < PAGE_SIZE) break;
  }
  return null;
}

/**
 * Normalise Paystack's `from`/`to` query parameters into repository bounds.
 *
 * A bare date means the whole day: `to=2026-03-01` has to include everything
 * that happened on the 1st, so it is widened to the end of that day. Taking it
 * literally as midnight would silently exclude the day the caller asked for.
 */
function normalizeDateRange(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const range: { from?: string; to?: string } = {};
  if (from) range.from = dateOnly.test(from) ? `${from}T00:00:00.000Z` : from;
  if (to) range.to = dateOnly.test(to) ? `${to}T23:59:59.999Z` : to;
  return range;
}

/**
 * The dial string a USSD charge asks the payer to enter.
 *
 * Paystack's own documentation shows `*737*33*4*18791#` -- the bank code, two
 * short menu segments, then a per-session identifier. The segments are session
 * state we do not model, so they are derived deterministically from the charge
 * so that the same charge always yields the same string under a fixed seed.
 *
 * The shape is documented; the middle digits are ours. docs/paystack.md says
 * so rather than implying the whole string is reproduced.
 */
function buildUssdCode(bankCode: string, seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100_000;
  }
  const session = String(hash).padStart(5, '0');
  return `*${bankCode}*33*4*${session}#`;
}

/** Convenience for tests that want the plugin registered on a bare Fastify. */
export async function registerPaystack(
  fastify: FastifyInstance,
  options: PaystackPluginOptions,
): Promise<void> {
  await fastify.register(paystackPlugin, { ...options, prefix: options.basePath });
}

export type { FastifyReply };

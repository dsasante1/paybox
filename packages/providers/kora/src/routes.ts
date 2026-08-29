import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type IdFactory,
  type Payment,
  type PaymentMethod,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { maskInstrument, resolveInstrument, type PaymentSimulator } from '@paybox/simulator';
import { assertKoraCredentials } from './auth.js';
import { toKoraError } from './errors.js';
import { decryptChargeData } from './encryption.js';
import { renderKoraCheckout, renderKoraResult } from './checkout.js';
import {
  koraRef,
  majorString,
  ok,
  serializeCharge,
  serializePayout,
  serializeRefund,
  serializeVirtualAccount,
} from './serializers.js';
import {
  authorizeChargeSchema,
  bankTransferSchema,
  cardChargeSchema,
  checkoutPaySchema,
  creditVirtualAccountSchema,
  disburseSchema,
  encryptedChargeSchema,
  initializeSchema,
  mobileMoneySchema,
  refundSchema,
  resolveBankSchema,
  virtualAccountSchema,
} from './schemas.js';

export interface KoraPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  /** Card payloads are AES-encrypted under the secret key. */
  secretKey: string;
  allowAnyKey?: boolean;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'kora' as const;
/** Kora's API lives under this prefix, which is part of its published URLs. */
const API = '/merchant/api/v1';

/**
 * Kora-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a Kora request can never be answered in another provider's envelope. Every
 * route translates a request into engine calls and translates the result back;
 * no payment behaviour lives here (spec §30).
 *
 * Shapes verified against the Kora Public APIs Postman collection
 * (docs.korapay.com, collection 303979/SVzxXeSM, read 2026-08-29). Coverage is
 * documented honestly in docs/kora.md.
 */
export const koraPlugin: FastifyPluginAsync<KoraPluginOptions> = async (fastify, options) => {
  const { engine, simulator, storage, clock, ids } = options;
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toKoraError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      status: false,
      message: `Unknown endpoint (${request.method} ${request.url}).`,
      data: null,
    }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertKoraCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  /* ------------------------------ lookups ------------------------------ */

  /** A charge is addressable by the merchant's reference or Kora's own. */
  async function loadPayment(handle: string): Promise<Payment> {
    const direct = await storage.payments.byReference(PROVIDER, handle);
    if (direct) return direct;

    const { items } = await storage.payments.list({ provider: PROVIDER, limit: 1000 });
    const match = items.find(
      (payment) => koraRef('CA', payment.id) === handle || payment.id === handle,
    );
    if (match) return match;
    throw new PayboxError('not_found', `No charge found for "${handle}".`);
  }

  async function decorate(payment: Payment, extra: Parameters<typeof serializeCharge>[1] = {}) {
    return serializeCharge(payment, {
      customer: payment.customerId ? await storage.customers.byId(payment.customerId) : null,
      ...extra,
    });
  }

  async function upsertCustomer(input: { email: string; name?: string | undefined }) {
    const existing = await storage.customers.byEmail(PROVIDER, input.email);
    if (existing) return existing;
    const [firstName, ...rest] = (input.name ?? '').split(' ');
    return engine.createCustomer({
      provider: PROVIDER,
      email: input.email,
      firstName: firstName || null,
      lastName: rest.join(' ') || null,
      phone: null,
    });
  }

  function assertCurrency(code: string): string {
    const currency = code.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `The currency ${code} is not supported.`);
    }
    return currency;
  }

  async function assertUniqueReference(reference: string): Promise<void> {
    if (await storage.payments.byReference(PROVIDER, reference)) {
      throw new PayboxError(
        'duplicate_reference',
        `Reference "${reference}" has already been used.`,
      );
    }
  }

  async function scheduleOutcome(payment: Payment, identifier: string | null): Promise<void> {
    if (!autoAdvance) return;
    const { outcome } = resolveInstrument(identifier, payment.paymentMethod);
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: 'payment.simulate',
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

  /** A synthetic account number. Belongs to no bank; nothing can pay into it. */
  function syntheticAccountNumber(): string {
    return ids.token(10).replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  }

  /* --------------------------- checkout redirect --------------------------- */

  fastify.post(`${API}/charges/initialize`, async (request, reply) => {
    authenticate(request);
    const body = initializeSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'NGN');
    await assertUniqueReference(body.reference);

    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
    });

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      metadata: {
        ...(body.metadata ?? {}),
        email: body.customer.email,
        ...(body.customer.name ? { customer_name: body.customer.name } : {}),
        ...(body.narration ? { narration: body.narration } : {}),
        ...(body.merchant_bears_cost !== undefined
          ? { merchant_bears_cost: body.merchant_bears_cost }
          : {}),
      },
      status: 'pending',
    });

    return reply.send(
      ok('Charge created successfully', {
        reference: payment.reference,
        checkout_url: `${options.baseUrl}${options.basePath}/checkout/${encodeURIComponent(
          payment.reference,
        )}`,
      }),
    );
  });

  /* ------------------------------- card -------------------------------- */

  fastify.post(`${API}/charges/card`, async (request, reply) => {
    authenticate(request);
    const envelope = encryptedChargeSchema.parse(request.body ?? {});
    // Kora requires the payload encrypted. paybox also accepts the plain shape
    // so a developer exploring with curl need not hand-encrypt; docs/kora.md
    // records that as an emulator convenience, not Kora behaviour.
    const payload = envelope.charge_data
      ? decryptChargeData(options.secretKey, envelope.charge_data)
      : ((request.body ?? {}) as Record<string, unknown>);

    const body = cardChargeSchema.parse(payload);
    const currency = assertCurrency(body.currency ?? 'NGN');
    await assertUniqueReference(body.reference);

    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
    });
    const masked = maskInstrument(body.card.number);

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      paymentMethod: 'card',
      paymentMethodDetails: {
        ...masked,
        exp_month: body.card.expiry_month != null ? String(body.card.expiry_month) : null,
        exp_year: body.card.expiry_year != null ? String(body.card.expiry_year) : null,
      },
      metadata: {
        ...(body.metadata ?? {}),
        email: body.customer.email,
        ...(body.customer.name ? { customer_name: body.customer.name } : {}),
      },
      status: 'pending',
    });

    // Kora's card flow always steps up through an OTP, which is what makes it
    // a two-call flow rather than a single charge.
    const parked = await engine.transitionPayment(payment.id, 'requires_action');
    return reply.send(
      ok(
        'Charge in progress',
        await decorate(parked, {
          authModel: 'OTP',
          message:
            'Please enter the OTP sent to your mobile number and email address.',
        }),
      ),
    );
  });

  fastify.post(`${API}/charges/card/authorize`, async (request, reply) => {
    authenticate(request);
    const body = authorizeChargeSchema.parse(request.body ?? {});
    const handle = body.transaction_reference ?? body.reference;
    if (!handle) {
      throw new PayboxError(
        'validation_failed',
        'One of `transaction_reference` or `reference` is required.',
      );
    }

    const payment = await loadPayment(handle);
    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `This charge is not awaiting authorization; it is ${payment.status}.`,
      );
    }

    // The outcome is decided by the instrument, not the OTP: the OTP proves
    // the customer is present, and the card decides whether the money moves.
    const last4 = payment.paymentMethodDetails.last4;
    const { outcome } = resolveInstrument(
      typeof last4 === 'string' ? last4 : null,
      payment.paymentMethod,
    );
    const settled = await simulator.apply(
      payment.id,
      outcome === 'authentication_required' ? 'success' : outcome,
    );
    return reply.send(ok('Charge completed', await decorate(settled)));
  });

  fastify.post(`${API}/charges/card/resend-otp`, async (request, reply) => {
    authenticate(request);
    const body = authorizeChargeSchema.parse(request.body ?? {});
    const payment = await loadPayment(body.transaction_reference ?? body.reference ?? '');
    return reply.send(
      ok('OTP resent successfully', await decorate(payment, { authModel: 'OTP' })),
    );
  });

  /* --------------------------- bank transfer --------------------------- */

  fastify.post(`${API}/charges/bank-transfer`, async (request, reply) => {
    authenticate(request);
    const body = bankTransferSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'NGN');
    await assertUniqueReference(body.reference);

    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
    });

    // Kora mints a short-lived virtual account for the payer to send to. The
    // charge stays pending until the money arrives, which is the whole point
    // of the rail: the merchant does not control when that happens.
    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      paymentMethod: 'bank_transfer',
      paymentMethodDetails: {
        account_name: body.account_name ?? 'PAYBOX TEST ACCOUNT',
        account_number: syntheticAccountNumber(),
        bank_name: 'PAYBOX TEST BANK',
        bank_code: '000',
      },
      metadata: {
        email: body.customer.email,
        ...(body.narration ? { narration: body.narration } : {}),
      },
      status: 'pending',
      // Kora's transfer accounts expire; modelling it is the point (spec §39).
      expiresInMs: 30 * 60_000,
    });

    const processing = await engine.transitionPayment(payment.id, 'processing');
    return reply.send(
      ok('Bank transfer initiated successfully', await decorate(processing)),
    );
  });

  /* ---------------------------- mobile money ---------------------------- */

  fastify.post(`${API}/charges/mobile-money`, async (request, reply) => {
    authenticate(request);
    const body = mobileMoneySchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'GHS');
    await assertUniqueReference(body.reference);

    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
    });

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      paymentMethod: 'mobile_money',
      paymentMethodDetails: { phone_number: body.mobile_money.number },
      metadata: {
        email: body.customer.email,
        ...(body.description ? { description: body.description } : {}),
      },
      status: 'pending',
    });

    const parked = await engine.transitionPayment(payment.id, 'requires_action');
    return reply.send(
      ok(
        'Authorization required',
        await decorate(parked, {
          authModel: 'OTP',
          message: 'Token generated and sent out successfully',
        }),
      ),
    );
  });

  fastify.post(`${API}/charges/mobile-money/authorize`, async (request, reply) => {
    authenticate(request);
    const body = authorizeChargeSchema.parse(request.body ?? {});
    const payment = await loadPayment(body.reference ?? body.transaction_reference ?? '');
    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `This charge is not awaiting authorization; it is ${payment.status}.`,
      );
    }

    // The OTP is accepted, and the charge moves to the STK prompt on the
    // customer's handset -- a second step-up, which is why Kora's mobile-money
    // flow is three calls rather than two.
    return reply.send(
      ok(
        'Authorization required',
        await decorate(payment, {
          authModel: 'STK_PROMPT',
          message:
            'You will receive a prompt on your mobile number. Kindly enter your wallet PIN to authorize the payment',
        }),
      ),
    );
  });

  /**
   * Kora's own sandbox endpoint for approving the STK prompt.
   *
   * Not an emulator invention: `/charges/mobile-money/sandbox/authorize-stk`
   * is in Kora's published collection, because there is no other way to
   * approve a prompt that would otherwise appear on a real handset.
   */
  fastify.post(`${API}/charges/mobile-money/sandbox/authorize-stk`, async (request, reply) => {
    authenticate(request);
    const body = authorizeChargeSchema.parse(request.body ?? {});
    const payment = await loadPayment(body.reference ?? body.transaction_reference ?? '');

    const phone = payment.paymentMethodDetails.phone_number;
    const { outcome } = resolveInstrument(
      typeof phone === 'string' ? phone : null,
      payment.paymentMethod,
    );
    const settled = await simulator.apply(
      payment.id,
      outcome === 'authentication_required' ? 'success' : outcome,
    );

    return reply.send(
      ok(
        'Approved by financial institution',
        await decorate(settled, { authModel: 'STK_PROMPT' }),
      ),
    );
  });

  /* ------------------------------- query ------------------------------- */

  fastify.get<{ Params: { reference: string } }>(
    `${API}/charges/:reference`,
    async (request, reply) => {
      authenticate(request);
      const payment = await loadPayment(request.params.reference);
      return reply.send(ok('Charge retrieved successfully', await decorate(payment)));
    },
  );

  /* ------------------------------ refunds ------------------------------ */

  fastify.post(`${API}/refunds/initiate`, async (request, reply) => {
    authenticate(request);
    const body = refundSchema.parse(request.body);
    const payment = await loadPayment(body.payment_reference);

    const refund = await engine.createRefund({
      paymentId: payment.id,
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      reason: body.reason ?? null,
      ...(body.reference ? { metadata: { reference: body.reference } } : {}),
    });
    const settled = await engine.transitionRefund(refund.id, 'successful');
    return reply.send(ok('Refund successfully initiated', serializeRefund(settled, payment)));
  });

  fastify.get<{ Params: { reference: string } }>(
    `${API}/refunds/:reference`,
    async (request, reply) => {
      authenticate(request);
      const { items } = await storage.refunds.list({ limit: 500 });
      const refund = items.find(
        (row) =>
          row.provider === PROVIDER &&
          (row.providerRefundId === request.params.reference || row.id === request.params.reference),
      );
      if (!refund) {
        throw new PayboxError('not_found', `No refund found for "${request.params.reference}".`);
      }
      return reply.send(
        ok(
          'Refund details retrieved successfully',
          serializeRefund(refund, await storage.payments.byId(refund.paymentId)),
        ),
      );
    },
  );

  fastify.get(`${API}/refunds`, async (request, reply) => {
    authenticate(request);
    const { items } = await storage.refunds.list({ limit: 100 });
    const refunds = await Promise.all(
      items
        .filter((row) => row.provider === PROVIDER)
        .map(async (row) => serializeRefund(row, await storage.payments.byId(row.paymentId))),
    );
    return reply.send(ok('Refunds retrieved successfully', { has_more: false, refunds }));
  });

  /* ------------------------------ payouts ------------------------------ */

  fastify.post(`${API}/transactions/disburse`, async (request, reply) => {
    authenticate(request);
    const body = disburseSchema.parse(request.body);
    const destination = body.destination;
    const currency = assertCurrency(destination.currency ?? 'NGN');

    const isBank = destination.type === 'bank_account';
    const account = isBank
      ? (destination.bank_account?.account_number ?? destination.bank_account?.account ?? null)
      : (destination.mobile_money?.mobile_number ?? null);
    const bank = isBank
      ? (destination.bank_account?.bank_code ?? destination.bank_account?.bank ?? null)
      : (destination.mobile_money?.operator ?? null);

    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: destination.amount,
      currency,
      reference: body.reference,
      recipientAccount: account,
      recipientBankCode: bank,
      recipientName: destination.customer?.name ?? null,
      reason: destination.narration ?? null,
      status: 'processing',
      metadata: {
        type: destination.type,
        ...(destination.customer?.email ? { email: destination.customer.email } : {}),
      },
    });

    return reply.send(ok('transfer initiated successfully', serializePayout(transfer)));
  });

  fastify.get<{ Params: { reference: string } }>(
    `${API}/transactions/:reference`,
    async (request, reply) => {
      authenticate(request);
      const { items } = await storage.transfers.list({ limit: 500 });
      const transfer = items.find(
        (row) => row.provider === PROVIDER && row.reference === request.params.reference,
      );
      if (!transfer) {
        throw new PayboxError(
          'not_found',
          `No transaction found for "${request.params.reference}".`,
        );
      }
      return reply.send(ok('Transaction retrieved successfully', serializePayout(transfer)));
    },
  );

  /* -------------------------- virtual accounts -------------------------- */

  fastify.post(`${API}/virtual-bank-account`, async (request, reply) => {
    authenticate(request);
    const body = virtualAccountSchema.parse(request.body);
    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
    });

    const account = await engine.createDedicatedAccount({
      provider: PROVIDER,
      customerId: customer.id,
      accountNumber: syntheticAccountNumber(),
      accountName: body.account_name,
      bankName: 'PAYBOX TEST BANK',
      bankSlug: 'paybox-test-bank',
      currency: 'NGN',
      metadata: { account_reference: body.account_reference },
    });

    return reply.send(
      ok(
        'Virtual bank account created successfully',
        serializeVirtualAccount({
          accountReference: body.account_reference,
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          bankName: account.bankName,
          bankCode: '000',
          currency: account.currency,
          customer: { name: body.customer.name ?? null, email: body.customer.email },
          createdAt: account.createdAt,
        }),
      ),
    );
  });

  fastify.get<{ Params: { reference: string } }>(
    `${API}/virtual-bank-account/:reference`,
    async (request, reply) => {
      authenticate(request);
      const { items } = await storage.dedicatedAccounts.list({ provider: PROVIDER, limit: 500 });
      const account = items.find(
        (row) =>
          row.metadata.account_reference === request.params.reference ||
          row.accountNumber === request.params.reference,
      );
      if (!account) {
        throw new PayboxError(
          'not_found',
          `No virtual account found for "${request.params.reference}".`,
        );
      }
      const customer = await storage.customers.byId(account.customerId);
      return reply.send(
        ok(
          'Virtual bank account retrieved successfully',
          serializeVirtualAccount({
            accountReference: String(account.metadata.account_reference ?? account.accountNumber),
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            bankName: account.bankName,
            bankCode: '000',
            currency: account.currency,
            customer: {
              name: [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || null,
              email: customer?.email ?? null,
            },
            createdAt: account.createdAt,
          }),
        ),
      );
    },
  );

  /**
   * Kora's own sandbox endpoint for funding a virtual account.
   *
   * `/virtual-bank-account/sandbox/credit` is in Kora's published collection:
   * money arriving in a virtual account originates with the payer's bank, so
   * there is no other way to test the inbound rail.
   */
  fastify.post(`${API}/virtual-bank-account/sandbox/credit`, async (request, reply) => {
    authenticate(request);
    const body = creditVirtualAccountSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'NGN');

    const account = await storage.dedicatedAccounts.byAccountNumber(
      PROVIDER,
      body.account_number,
    );
    if (!account) {
      throw new PayboxError('not_found', `No virtual account ${body.account_number}.`);
    }

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      customerId: account.customerId,
      paymentMethod: 'bank_transfer',
      paymentMethodDetails: {
        account_number: account.accountNumber,
        account_name: account.accountName,
        bank_name: account.bankName,
      },
      metadata: { virtual_account: account.accountNumber },
      status: 'processing',
    });
    const settled = await simulator.apply(payment.id, 'success');

    return reply.send(ok('Virtual bank account credited', await decorate(settled)));
  });

  /* ---------------------------- verification ---------------------------- */

  fastify.post(`${API}/misc/banks/resolve`, async (request, reply) => {
    authenticate(request);
    const body = resolveBankSchema.parse(request.body);
    // Synthetic: the emulator resolves no real account at any real bank.
    return reply.send(
      ok('Account resolved successfully', {
        account_number: body.account,
        account_name: 'PAYBOX TEST ACCOUNT',
        bank_code: body.bank,
        bank_name: 'PAYBOX TEST BANK',
      }),
    );
  });

  /* --------------------------- the hosted page --------------------------- */

  fastify.get<{ Params: { ref: string } }>('/checkout/:ref', async (request, reply) => {
    const payment = await loadPayment(request.params.ref);
    if (payment.status !== 'pending' && payment.status !== 'created') {
      return reply.type('text/html').send(
        renderKoraResult({
          payment,
          redirectUrl: payment.callbackUrl,
          message: 'This payment has already been submitted.',
        }),
      );
    }
    return reply.type('text/html').send(
      renderKoraCheckout({
        payment,
        reference: payment.reference,
        basePath: options.basePath,
      }),
    );
  });

  fastify.post<{ Params: { ref: string } }>('/checkout/:ref/pay', async (request, reply) => {
    const payment = await loadPayment(request.params.ref);
    const body = checkoutPaySchema.parse(request.body ?? {});
    const masked = maskInstrument(body.card_number);

    const started = await engine.transitionPayment(payment.id, 'processing', {
      paymentMethod: 'card',
      paymentMethodDetails: {
        ...masked,
        exp_month: body.exp_month ?? null,
        exp_year: body.exp_year ?? null,
      },
    });
    await scheduleOutcome(started, body.card_number);

    return reply.type('text/html').send(
      renderKoraResult({
        payment: started,
        redirectUrl: started.callbackUrl,
        message: 'Your payment is being processed.',
      }),
    );
  });

  void majorString;
};

/** Convenience for tests that want the plugin on a bare Fastify. */
export async function registerKora(
  fastify: FastifyInstance,
  options: KoraPluginOptions,
): Promise<void> {
  await fastify.register(koraPlugin, { ...options, prefix: options.basePath });
}

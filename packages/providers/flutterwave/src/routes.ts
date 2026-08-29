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
import {
  maskInstrument,
  resolveInstrument,
  type PaymentSimulator,
  type SubscriptionRunner,
} from '@paybox/simulator';
import { assertFlutterwaveCredentials } from './auth.js';
import { toFlutterwaveError } from './errors.js';
import { decryptPayload } from './encryption.js';
import {
  FLUTTERWAVE_MOMO_OTP,
  OTP_OUTCOMES,
  findPublishedCard,
  flutterwaveInstrumentResolver,
  momoFails,
} from './instruments.js';
import { fromFlutterwaveChargeType, type FlutterwaveAuthMode } from './status.js';
import {
  authorizationMeta,
  flwRef,
  numericId,
  ok,
  serializeCustomer,
  serializeRefund,
  serializeTransaction,
  serializeTransfer,
} from './serializers.js';
import {
  cardChargeSchema,
  checkoutPaySchema,
  encryptedChargeSchema,
  listQuerySchema,
  paymentsInitiateSchema,
  railChargeSchema,
  refundSchema,
  transferSchema,
  validateChargeSchema,
} from './schemas.js';
import { renderFlutterwaveCheckout, renderFlutterwaveResult } from './checkout.js';

export interface FlutterwavePluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  subscriptions: SubscriptionRunner;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  /** The 3DES key a caller must encrypt direct card payloads with. */
  encryptionKey: string;
  allowAnyKey?: boolean;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'flutterwave' as const;

/**
 * Flutterwave v3-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a Flutterwave request can never be answered in Paystack's or Stripe's
 * envelope. Every route translates a request into engine calls and translates
 * the result back; no payment behaviour lives here (spec §30).
 *
 * Shapes verified against developer.flutterwave.com/v3.0.0/docs, read
 * 2026-08-29. Coverage is documented honestly in docs/flutterwave.md.
 */
export const flutterwavePlugin: FastifyPluginAsync<FlutterwavePluginOptions> = async (
  fastify,
  options,
) => {
  const { engine, simulator, storage, clock, ids } = options;
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toFlutterwaveError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      status: 'error',
      message: `Unknown endpoint (${request.method} ${request.url}).`,
      data: null,
    }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertFlutterwaveCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  /* ---------------------------------------------------------------- *
   * Lookups
   * ---------------------------------------------------------------- */

  /**
   * Resolve a Flutterwave handle to a payment.
   *
   * Three forms address the same row: the numeric `id`, the `flw_ref`, and the
   * merchant's own `tx_ref`. Flutterwave's own API is the same way, and an
   * integration will use whichever it happens to have.
   */
  async function loadPayment(handle: string): Promise<Payment> {
    const direct = await storage.payments.byReference(PROVIDER, handle);
    if (direct) return direct;

    // Numeric id and flw_ref are both derived from the canonical id, so they
    // are resolved by scanning rather than reversing a hash.
    const { items } = await storage.payments.list({ provider: PROVIDER, limit: 1000 });
    const match = items.find(
      (payment) =>
        String(numericId(payment.id)) === handle ||
        flwRef(payment.id) === handle ||
        payment.id === handle,
    );
    if (match) return match;

    throw new PayboxError('not_found', `No transaction found for "${handle}".`);
  }

  async function customerFor(payment: Payment) {
    return payment.customerId ? storage.customers.byId(payment.customerId) : null;
  }

  async function decorate(payment: Payment) {
    return serializeTransaction(payment, { customer: await customerFor(payment) });
  }

  /** Find or create the customer a charge names, keyed on email. */
  async function upsertCustomer(input: {
    email: string;
    name?: string | undefined;
    phone?: string | undefined;
  }) {
    const existing = await storage.customers.byEmail(PROVIDER, input.email);
    if (existing) return existing;
    const [firstName, ...rest] = (input.name ?? '').split(' ');
    return engine.createCustomer({
      provider: PROVIDER,
      email: input.email,
      firstName: firstName || null,
      lastName: rest.join(' ') || null,
      phone: input.phone ?? null,
    });
  }

  /** Schedule the outcome a test instrument implies, as a real rail would. */
  async function scheduleOutcome(payment: Payment, identifier: string | null): Promise<void> {
    if (!autoAdvance) return;
    const { outcome } = resolveInstrument(identifier, payment.paymentMethod, {
      resolver: flutterwaveInstrumentResolver,
    });
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

  function assertCurrency(code: string): string {
    const currency = code.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `The currency ${code} is not supported.`);
    }
    return currency;
  }

  /* ---------------------------------------------------------------- *
   * Standard checkout: POST /v3/payments
   * ---------------------------------------------------------------- */

  fastify.post('/v3/payments', async (request, reply) => {
    authenticate(request);
    const body = paymentsInitiateSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'NGN');

    const existing = await storage.payments.byReference(PROVIDER, body.tx_ref);
    if (existing) {
      throw new PayboxError(
        'duplicate_reference',
        `Transaction reference "${body.tx_ref}" has already been used.`,
      );
    }

    const customer = await upsertCustomer({
      email: body.customer.email,
      name: body.customer.name,
      phone: body.customer.phonenumber,
    });

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.tx_ref,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      metadata: {
        ...(body.meta ?? {}),
        email: body.customer.email,
        ...(body.customer.name ? { fullname: body.customer.name } : {}),
        ...(body.payment_options ? { payment_options: body.payment_options } : {}),
        checkout_title: body.customizations?.title ?? 'Payment',
      },
      status: 'pending',
    });

    return reply.send(
      ok('Hosted Link', {
        link: `${options.baseUrl}${options.basePath}/checkout/${encodeURIComponent(
          payment.reference,
        )}`,
      }),
    );
  });

  /* ---------------------------------------------------------------- *
   * Direct charges: POST /v3/charges?type=…
   * ---------------------------------------------------------------- */

  /**
   * Card details, decrypted.
   *
   * Flutterwave requires the payload 3DES-encrypted in `client`. paybox also
   * accepts the plain shape, so a developer exploring with curl need not
   * hand-encrypt — recorded in docs/flutterwave.md as an emulator convenience,
   * not as Flutterwave behaviour.
   */
  function cardPayload(rawBody: unknown): Record<string, unknown> {
    const envelope = encryptedChargeSchema.parse(rawBody ?? {});
    if (envelope.client) return decryptPayload(options.encryptionKey, envelope.client);
    return (rawBody ?? {}) as Record<string, unknown>;
  }

  /**
   * Which step-up a card demands, and what the caller has already supplied.
   *
   * Flutterwave's flow is: charge, get told the mode, resend with that field,
   * then (for OTP) validate. Each stage is a real state transition here rather
   * than a canned response, so the timeline shows what actually happened.
   */
  function pendingAuthMode(
    card: ReturnType<typeof findPublishedCard>,
    supplied: Record<string, unknown>,
  ): FlutterwaveAuthMode | null {
    const mode = card?.authMode ?? null;
    if (!mode) return null;
    if (mode === 'pin' && typeof supplied.pin === 'string') return null;
    if (mode === 'avs_noauth' && typeof supplied.city === 'string') return null;
    if (mode === 'otp' && typeof supplied.otp === 'string') return null;
    return mode;
  }

  fastify.post<{ Querystring: { type?: string } }>('/v3/charges', async (request, reply) => {
    authenticate(request);
    const type = request.query.type ?? 'card';
    const method = fromFlutterwaveChargeType(type);
    if (!method) {
      throw new PayboxError(
        'validation_failed',
        `Unknown charge type "${type}". Flutterwave's documented types are card, ` +
          `mobile_money_*, bank_transfer, ussd, debit_ng_account and nqr.`,
      );
    }

    const { body, meta } =
      method === 'card'
        ? await chargeCard(request)
        : await chargeRail(request, method, type);
    return reply.send(meta === undefined ? body : { ...body, meta });
  });

  /** What a charge handler produces: an envelope, and optionally `meta`. */
  interface ChargeResult {
    body: ReturnType<typeof ok<Awaited<ReturnType<typeof decorate>>>>;
    meta?: unknown;
  }

  async function chargeCard(request: FastifyRequest): Promise<ChargeResult> {
    const payload = cardPayload(request.body);
    const body = cardChargeSchema.parse(payload);
    const currency = assertCurrency(body.currency ?? 'NGN');
    const card = findPublishedCard(body.card_number);
    const masked = maskInstrument(body.card_number);

    const customer = await upsertCustomer({
      email: body.email,
      name: body.fullname,
      phone: body.phone_number,
    });

    // A second call for the same tx_ref is the caller supplying the auth field
    // they were asked for, not a new charge.
    const existing = await storage.payments.byReference(PROVIDER, body.tx_ref);
    const payment =
      existing ??
      (await engine.createPayment({
        provider: PROVIDER,
        amount: body.amount,
        currency,
        reference: body.tx_ref,
        customerId: customer.id,
        callbackUrl: body.redirect_url ?? null,
        paymentMethod: 'card',
        paymentMethodDetails: {
          ...masked,
          exp_month: body.expiry_month != null ? String(body.expiry_month) : null,
          exp_year: body.expiry_year != null ? String(body.expiry_year) : null,
          brand: card?.network ?? null,
          country: body.country ?? 'NG',
        },
        metadata: {
          ...(body.meta ?? {}),
          email: body.email,
          ...(body.fullname ? { fullname: body.fullname } : {}),
        },
        status: 'pending',
      }));

    const mode = pendingAuthMode(card, payload);

    if (mode) {
      // Park at requires_action and tell the caller exactly what to send back.
      const parked =
        payment.status === 'requires_action'
          ? payment
          : await engine.transitionPayment(payment.id, 'requires_action', {
              paymentMethodDetails: { auth_mode: mode },
            });
      await storage.payments.update(parked.id, {
        metadata: { ...parked.metadata, auth_mode: mode },
        updatedAt: clock.nowISO(),
      });

      const fresh = await loadPayment(parked.id);
      return {
        body: ok('Charge authorization data required', await decorate(fresh)),
        meta: authorizationMeta(mode, {
          redirectUrl: `${options.baseUrl}${options.basePath}/3ds/${encodeURIComponent(
            fresh.reference,
          )}`,
        }),
      };
    }

    // A supplied OTP is validated here rather than at /validate-charge when the
    // card's mode was OTP from the start.
    if (typeof payload.otp === 'string') {
      const failure = OTP_OUTCOMES[payload.otp];
      if (failure) {
        const failed = await simulator.apply(payment.id, failure);
        return { body: ok('Charge validation failed', await decorate(failed)) };
      }
    }

    // The caller has just satisfied the step-up this card demanded, so settle
    // it now rather than scheduling the card's raw outcome again.
    //
    // A published card's outcome describes its *first* leg: the successful
    // ones resolve to `authentication_required`, which is what parks them at
    // the PIN or 3-D Secure prompt. Replaying that after the PIN arrives would
    // park the charge a second time and it would never settle.
    if (card?.authMode) {
      const settled = await simulator.apply(payment.id, postAuthOutcome(card));
      return { body: ok('Charge initiated', await decorate(settled)) };
    }

    await scheduleOutcome(payment, body.card_number);
    return { body: ok('Charge initiated', await decorate(await loadPayment(payment.id))) };
  }

  /**
   * What a card does *after* its step-up is satisfied.
   *
   * `authentication_required` is the parking instruction, not a verdict --
   * Flutterwave's table calls these cards "PIN authentication" and "3DS
   * authentication" precisely because they succeed once authenticated. A card
   * that genuinely fails carries its own failure outcome and keeps it.
   */
  function postAuthOutcome(card: NonNullable<ReturnType<typeof findPublishedCard>>) {
    return card.outcome === 'authentication_required' ? ('success' as const) : card.outcome;
  }

  async function chargeRail(
    request: FastifyRequest,
    method: PaymentMethod,
    type: string,
  ): Promise<ChargeResult> {
    const body = railChargeSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? 'NGN');

    const existing = await storage.payments.byReference(PROVIDER, body.tx_ref);
    if (existing) {
      throw new PayboxError(
        'duplicate_reference',
        `Transaction reference "${body.tx_ref}" has already been used.`,
      );
    }

    const customer = await upsertCustomer({
      email: body.email,
      name: body.fullname,
      phone: body.phone_number,
    });

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.tx_ref,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      paymentMethod: method,
      paymentMethodDetails: {
        ...(body.phone_number ? { phone_number: body.phone_number } : {}),
        ...(body.network ? { network: body.network } : {}),
        ...(body.account_bank ? { bank: body.account_bank } : {}),
        charge_type: type,
      },
      metadata: {
        ...(body.meta ?? {}),
        email: body.email,
        ...(body.fullname ? { fullname: body.fullname } : {}),
      },
      status: 'pending',
    });

    // Mobile money parks awaiting the customer's handset, which is the whole
    // reason these rails are worth emulating: the merchant does not control
    // when — or whether — it completes.
    if (method === 'mobile_money') {
      if (momoFails(body.phone_number ?? null)) {
        const failed = await simulator.apply(payment.id, 'declined');
        return { body: ok('Charge initiated', await decorate(failed)) };
      }
      const parked = await engine.transitionPayment(payment.id, 'requires_action');
      return {
        body: ok('Charge initiated', await decorate(parked)),
        meta: { authorization: { mode: 'otp', endpoint: '/v3/validate-charge' } },
      };
    }

    await scheduleOutcome(payment, body.account_number ?? body.phone_number ?? null);
    return { body: ok('Charge initiated', await decorate(await loadPayment(payment.id))) };
  }

  /* ---------------------------------------------------------------- *
   * POST /v3/validate-charge
   * ---------------------------------------------------------------- */

  fastify.post('/v3/validate-charge', async (request, reply) => {
    authenticate(request);
    const body = validateChargeSchema.parse(request.body);
    const payment = await loadPayment(body.flw_ref);

    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `This transaction is not awaiting validation; it is ${payment.status}.`,
      );
    }

    // Flutterwave documents that any OTP validates in test mode, with two
    // exceptions that mock a specific failure.
    const failure = OTP_OUTCOMES[body.otp];
    if (failure) {
      const failed = await simulator.apply(payment.id, failure);
      return reply.send(ok('Charge validation failed', await decorate(failed)));
    }

    const settled = await simulator.apply(payment.id, 'success');
    return reply.send(ok('Charge validated', await decorate(settled)));
  });

  /* ---------------------------------------------------------------- *
   * Verification
   * ---------------------------------------------------------------- */

  fastify.get<{ Params: { id: string } }>(
    '/v3/transactions/:id/verify',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadPayment(request.params.id);
      return reply.send(ok('Transaction fetched successfully', await decorate(payment)));
    },
  );

  fastify.get<{ Querystring: { tx_ref?: string } }>(
    '/v3/transactions/verify_by_reference',
    async (request, reply) => {
      authenticate(request);
      if (!request.query.tx_ref) {
        throw new PayboxError('validation_failed', 'tx_ref is required.');
      }
      const payment = await loadPayment(request.query.tx_ref);
      return reply.send(ok('Transaction fetched successfully', await decorate(payment)));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>(
    '/v3/transactions',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query);
      const page = Math.max(1, Number(query.page ?? 1) || 1);
      const limit = 20;
      const { items, total } = await storage.payments.list({
        provider: PROVIDER,
        limit,
        offset: (page - 1) * limit,
        ...(query.tx_ref ? { reference: query.tx_ref } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      });
      const data = await Promise.all(items.map((payment) => decorate(payment)));
      return reply.send(
        ok('Transactions fetched successfully', data, {
          page_info: { total, current_page: page, total_pages: Math.ceil(total / limit) },
        }),
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * Refunds
   * ---------------------------------------------------------------- */

  fastify.post<{ Params: { id: string } }>(
    '/v3/transactions/:id/refund',
    async (request, reply) => {
      authenticate(request);
      const body = refundSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.id);

      const refund = await engine.createRefund({
        paymentId: payment.id,
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        reason: body.comments ?? null,
      });
      // Flutterwave settles test refunds at once.
      const settled = await engine.transitionRefund(refund.id, 'successful');
      return reply.send(ok('Refund initiated', serializeRefund(settled, payment)));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>('/v3/refunds', async (request, reply) => {
    authenticate(request);
    const { items } = await storage.refunds.list({ limit: 100 });
    const data = await Promise.all(
      items.map(async (refund) =>
        serializeRefund(refund, await storage.payments.byId(refund.paymentId)),
      ),
    );
    return reply.send(ok('Refunds fetched', data));
  });

  /* ---------------------------------------------------------------- *
   * Payouts (Flutterwave calls them transfers)
   * ---------------------------------------------------------------- */

  fastify.post('/v3/transfers', async (request, reply) => {
    authenticate(request);
    const body = transferSchema.parse(request.body);
    const currency = assertCurrency(body.currency ?? body.debit_currency ?? 'NGN');

    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      ...(body.reference ? { reference: body.reference } : {}),
      recipientAccount: body.account_number,
      recipientBankCode: body.account_bank,
      recipientName: body.beneficiary_name ?? null,
      reason: body.narration ?? null,
      status: 'pending',
      metadata: { ...(body.meta ? { meta: body.meta } : {}) },
    });

    return reply.send(ok('Transfer Queued Successfully', serializeTransfer(transfer)));
  });

  fastify.get<{ Params: { id: string } }>('/v3/transfers/:id', async (request, reply) => {
    authenticate(request);
    const { items } = await storage.transfers.list({ limit: 500 });
    const transfer = items.find(
      (row) =>
        row.provider === PROVIDER &&
        (String(numericId(row.id)) === request.params.id ||
          row.reference === request.params.id ||
          row.id === request.params.id),
    );
    if (!transfer) {
      throw new PayboxError('not_found', `No transfer found for "${request.params.id}".`);
    }
    return reply.send(ok('Transfer fetched', serializeTransfer(transfer)));
  });

  fastify.get('/v3/transfers', async (request, reply) => {
    authenticate(request);
    const { items } = await storage.transfers.list({ limit: 100 });
    const data = items.filter((row) => row.provider === PROVIDER).map(serializeTransfer);
    return reply.send(ok('Transfers fetched', data));
  });

  /* ---------------------------------------------------------------- *
   * Customers
   * ---------------------------------------------------------------- */

  fastify.get<{ Querystring: Record<string, string> }>('/v3/customers', async (request, reply) => {
    authenticate(request);
    const { items } = await storage.customers.list({ provider: PROVIDER, limit: 100 });
    return reply.send(ok('Customers fetched', items.map(serializeCustomer)));
  });

  /* ---------------------------------------------------------------- *
   * The hosted page
   * ---------------------------------------------------------------- */

  fastify.get<{ Params: { ref: string } }>('/checkout/:ref', async (request, reply) => {
    const payment = await loadPayment(request.params.ref);
    if (payment.status !== 'pending' && payment.status !== 'created') {
      return reply.type('text/html').send(
        renderFlutterwaveResult({
          payment,
          redirectUrl: resultUrl(payment),
          message: 'This payment has already been submitted.',
        }),
      );
    }
    return reply.type('text/html').send(
      renderFlutterwaveCheckout({
        payment,
        txRef: payment.reference,
        basePath: options.basePath,
        title: (payment.metadata.checkout_title as string | undefined) ?? 'Payment',
      }),
    );
  });

  fastify.post<{ Params: { ref: string } }>('/checkout/:ref/pay', async (request, reply) => {
    const payment = await loadPayment(request.params.ref);
    const body = checkoutPaySchema.parse(request.body ?? {});
    const masked = maskInstrument(body.card_number);
    const card = findPublishedCard(body.card_number);

    const started = await engine.transitionPayment(payment.id, 'processing', {
      paymentMethod: 'card',
      paymentMethodDetails: {
        ...masked,
        exp_month: body.exp_month ?? null,
        exp_year: body.exp_year ?? null,
        brand: card?.network ?? null,
      },
    });
    await scheduleOutcome(started, body.card_number);

    return reply.type('text/html').send(
      renderFlutterwaveResult({
        payment: started,
        redirectUrl: resultUrl(started),
        message: 'Your payment is being processed.',
      }),
    );
  });

  /**
   * The 3-D Secure page `meta.authorization.redirect` points at.
   *
   * Advertising a URL and answering it with a 404 would be worse than omitting
   * the redirect entirely.
   */
  fastify.get<{ Params: { ref: string } }>('/3ds/:ref', async (request, reply) => {
    const payment = await loadPayment(request.params.ref);
    if (payment.status === 'requires_action') {
      await simulator.apply(payment.id, 'success');
    }
    const settled = await loadPayment(payment.id);
    return reply.type('text/html').send(
      renderFlutterwaveResult({
        payment: settled,
        redirectUrl: resultUrl(settled),
        message: 'Authentication complete.',
      }),
    );
  });

  /**
   * Flutterwave appends `tx_ref`, `transaction_id` and `status` to the
   * merchant's redirect URL, so an integration reading them back finds them.
   */
  function resultUrl(payment: Payment): string | null {
    if (!payment.callbackUrl) return null;
    const separator = payment.callbackUrl.includes('?') ? '&' : '?';
    const params = new URLSearchParams({
      tx_ref: payment.reference,
      transaction_id: String(numericId(payment.id)),
      status: payment.status === 'successful' ? 'successful' : 'pending',
    });
    return `${payment.callbackUrl}${separator}${params.toString()}`;
  }
};

/** Convenience for tests that want the plugin on a bare Fastify. */
export async function registerFlutterwave(
  fastify: FastifyInstance,
  options: FlutterwavePluginOptions,
): Promise<void> {
  await fastify.register(flutterwavePlugin, { ...options, prefix: options.basePath });
}

void FLUTTERWAVE_MOMO_OTP;

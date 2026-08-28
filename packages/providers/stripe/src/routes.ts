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
import { expandFormBody } from './form.js';
import { assertStripeCredentials } from './auth.js';
import { toStripeError } from './errors.js';
import { stripeInstrumentResolver } from './instruments.js';
import { fromStripeStatus } from './status.js';
import {
  customerCreateSchema,
  listQuerySchema,
  paymentIntentCancelSchema,
  paymentIntentCaptureSchema,
  paymentIntentConfirmSchema,
  paymentIntentCreateSchema,
  paymentIntentUpdateSchema,
  paymentMethodAttachSchema,
  paymentMethodCreateSchema,
  refundCreateSchema,
} from './schemas.js';
import {
  list,
  serializeCharge,
  serializeCustomer,
  serializePaymentIntent,
  serializePaymentMethod,
  serializeRefund,
  stripeId,
} from './serializers.js';

export interface StripePluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  allowAnyKey?: boolean;
  /** Play a test card's outcome out automatically, as a real card would. */
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'stripe' as const;

/**
 * Stripe-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser and
 * body parser, which is why this project uses Fastify: a Stripe request must
 * never be answered in Paystack's envelope, and Stripe's form-only encoding
 * must not become the whole app's.
 *
 * Every route translates a request into engine calls and translates the result
 * back. No payment behaviour lives here (spec §30).
 */
export const stripePlugin: FastifyPluginAsync<StripePluginOptions> = async (
  fastify,
  options,
) => {
  const { engine, simulator, storage, clock, ids } = options;
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toStripeError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        type: 'invalid_request_error',
        message: `Unrecognized request URL (${request.method}: ${request.url}).`,
      },
    }),
  );

  /**
   * Stripe sends form-encoded bodies with bracketed keys, and nothing else.
   * Registered inside this plugin so the expansion applies to Stripe's routes
   * only -- Paystack's flat forms keep the app-level parser.
   */
  // The app registers a flat form parser for every provider. Fastify's
  // content-type parsers are inherited by a child scope rather than shadowed,
  // so the inherited one has to be removed here before this one can replace
  // it -- and the removal, like the addition, applies only inside this plugin.
  fastify.removeContentTypeParser('application/x-www-form-urlencoded');
  fastify.removeContentTypeParser('application/json');

  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const flat = Object.fromEntries(new URLSearchParams(body as string));
        done(null, expandFormBody(flat));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  // Stripe's own SDKs never send JSON, but curl users and hand-rolled clients
  // do; accepting it costs nothing and avoids a baffling 415.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = (body as string).trim();
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  const authenticate = (request: FastifyRequest): void => {
    assertStripeCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  /* ---------------------------------------------------------------- *
   * Lookups
   * ---------------------------------------------------------------- */

  /**
   * Resolve a Stripe id to a payment.
   *
   * `pi_`, `ch_` and the canonical id all address the same row here: paybox
   * models the intent and its latest charge as one payment, so the two ids are
   * two views of it. docs/stripe.md records that they are not independent
   * objects as they are at Stripe.
   */
  async function loadPayment(handle: string): Promise<Payment> {
    const canonical = handle.replace(/^(pi|ch)_/, 'pay_');
    const payment =
      (await storage.payments.byId(canonical)) ?? (await storage.payments.byId(handle));
    if (payment && payment.provider === PROVIDER) return payment;
    throw new PayboxError('not_found', `No such payment_intent: '${handle}'.`);
  }

  async function loadCustomer(handle: string) {
    const canonical = handle.replace(/^cus_/, 'cus_');
    const customer = await storage.customers.byId(canonical);
    if (customer && customer.provider === PROVIDER) return customer;
    throw new PayboxError('not_found', `No such customer: '${handle}'.`);
  }

  async function loadAuthorization(handle: string) {
    const canonical = handle.replace(/^pm_/, 'aut_');
    const authorization = await storage.authorizations.byId(canonical);
    if (authorization && authorization.provider === PROVIDER) return authorization;
    throw new PayboxError('not_found', `No such PaymentMethod: '${handle}'.`);
  }

  async function decorate(payment: Payment) {
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    return serializePaymentIntent(payment, {
      customer,
      baseUrl: options.baseUrl,
      basePath: options.basePath,
    });
  }

  /**
   * Translate Stripe's cursor pagination onto the repository's offsets.
   *
   * `starting_after` is an object id, so the page it starts from has to be
   * found by scanning. Bounded by the same page ceiling the repositories use;
   * docs/stripe.md records that a cursor beyond that window is not honoured.
   */
  async function paginate<T extends { id: string }>(
    query: { limit: number; starting_after?: string | undefined; ending_before?: string | undefined },
    fetch: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>,
    idOf: (row: T) => string,
  ): Promise<{ page: T[]; hasMore: boolean }> {
    const all: T[] = [];
    const PAGE = 500;
    for (let offset = 0; offset < 10_000; offset += PAGE) {
      const { items } = await fetch(PAGE, offset);
      all.push(...items);
      if (items.length < PAGE) break;
    }

    let start = 0;
    let end = all.length;
    if (query.starting_after) {
      const at = all.findIndex((row) => idOf(row) === query.starting_after);
      if (at >= 0) start = at + 1;
    }
    if (query.ending_before) {
      const at = all.findIndex((row) => idOf(row) === query.ending_before);
      if (at >= 0) end = at;
    }

    const window = all.slice(start, end);
    return { page: window.slice(0, query.limit), hasMore: window.length > query.limit };
  }

  /** Schedule the outcome a test card implies, as a real authorization would. */
  async function scheduleOutcome(payment: Payment, number: string | null): Promise<void> {
    if (!autoAdvance) return;
    const { outcome } = resolveInstrument(number, payment.paymentMethod, {
      resolver: stripeInstrumentResolver,
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

  /** Masked card detail from inline `payment_method_data`, or a stored method. */
  function cardDetailsFrom(card: {
    number: string;
    exp_month?: unknown;
    exp_year?: unknown;
  }): Record<string, unknown> {
    const masked = maskInstrument(card.number);
    return {
      ...masked,
      // Kept only long enough to resolve the documented test outcome and the
      // decline code it implies; never persisted beyond this object, which
      // holds no PAN (spec §29).
      exp_month: card.exp_month != null ? String(card.exp_month) : '12',
      exp_year: card.exp_year != null ? String(card.exp_year) : '2034',
      brand: 'visa',
      country: 'US',
    };
  }

  /* ---------------------------------------------------------------- *
   * PaymentIntents
   * ---------------------------------------------------------------- */

  fastify.post('/v1/payment_intents', async (request, reply) => {
    authenticate(request);
    const body = paymentIntentCreateSchema.parse(request.body);
    const currency = body.currency.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `The currency ${body.currency} is not supported.`,
      );
    }

    const customer = body.customer ? await loadCustomer(body.customer) : null;
    const inlineCard = body.payment_method_data?.card;

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      customerId: customer?.id ?? null,
      callbackUrl: body.return_url ?? null,
      ...(inlineCard
        ? { paymentMethod: 'card' as PaymentMethod, paymentMethodDetails: cardDetailsFrom(inlineCard) }
        : {}),
      metadata: {
        ...(body.metadata ?? {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.receipt_email ? { receipt_email: body.receipt_email } : {}),
        ...(body.capture_method ? { capture_method: body.capture_method } : {}),
      },
      status: inlineCard ? 'pending' : 'created',
    });

    if (body.confirm && inlineCard) {
      const confirmed = await confirmPayment(payment, inlineCard.number);
      return reply.send(await decorate(confirmed));
    }
    return reply.send(await decorate(payment));
  });

  /**
   * Move an intent into flight.
   *
   * A manual-capture intent stops at `authorized`; everything else settles
   * according to the card. Both paths go through the ordinary state machine.
   */
  async function confirmPayment(payment: Payment, number: string | null): Promise<Payment> {
    const started =
      payment.status === 'failed'
        ? // Stripe's declined intent is alive: confirming again is a retry, not
          // a new intent. This is the one place the engine's `retry` flag is used.
          await engine.transitionPayment(payment.id, 'processing', { retry: true })
        : await engine.transitionPayment(payment.id, 'processing');

    // Card authorization is synchronous at Stripe: confirming a manual-capture
    // intent comes back `requires_capture` rather than settling later. Only the
    // capture is deferred, so an authorising card stops here and a declining
    // one still plays its failure out.
    if (started.metadata.capture_method === 'manual') {
      const { outcome } = resolveInstrument(number, started.paymentMethod, {
        resolver: stripeInstrumentResolver,
      });
      if (outcome === 'success') {
        return engine.transitionPayment(started.id, 'authorized');
      }
    }

    await scheduleOutcome(started, number);
    return started;
  }

  fastify.post<{ Params: { intent: string } }>(
    '/v1/payment_intents/:intent/confirm',
    async (request, reply) => {
      authenticate(request);
      const body = paymentIntentConfirmSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.intent);

      const inlineCard = body.payment_method_data?.card;
      let number: string | null = inlineCard?.number ?? null;
      let details = inlineCard ? cardDetailsFrom(inlineCard) : null;

      if (!inlineCard && body.payment_method) {
        const authorization = await loadAuthorization(body.payment_method);
        engine.assertChargeable(authorization);
        number = authorization.last4;
        details = {
          bin: authorization.bin,
          last4: authorization.last4,
          exp_month: authorization.expMonth,
          exp_year: authorization.expYear,
          brand: authorization.brand,
          country: authorization.countryCode,
        };
      }

      if (details) {
        await engine.transitionPayment(payment.id, 'pending', {
          paymentMethod: 'card',
          paymentMethodDetails: details,
          ...(payment.status === 'failed' ? { retry: true } : {}),
        });
      } else if (!payment.paymentMethod) {
        throw new PayboxError(
          'validation_failed',
          'You must provide a `payment_method` or `payment_method_data` to confirm this ' +
            'PaymentIntent.',
        );
      }

      const fresh = await loadPayment(request.params.intent);
      const confirmed = await confirmPayment(fresh, number ?? (fresh.paymentMethodDetails.last4 as string | null));
      return reply.send(await decorate(confirmed));
    },
  );

  fastify.post<{ Params: { intent: string } }>(
    '/v1/payment_intents/:intent/capture',
    async (request, reply) => {
      authenticate(request);
      paymentIntentCaptureSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.intent);
      if (payment.status !== 'authorized') {
        throw new PayboxError(
          'invalid_state_transition',
          `This PaymentIntent could not be captured because it has a status of ` +
            `${payment.status}.`,
        );
      }
      const captured = await simulator.capture(payment.id);
      return reply.send(await decorate(captured));
    },
  );

  fastify.post<{ Params: { intent: string } }>(
    '/v1/payment_intents/:intent/cancel',
    async (request, reply) => {
      authenticate(request);
      paymentIntentCancelSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.intent);
      const cancelled = await engine.transitionPayment(payment.id, 'cancelled');
      return reply.send(await decorate(cancelled));
    },
  );

  fastify.get<{ Params: { intent: string } }>(
    '/v1/payment_intents/:intent',
    async (request, reply) => {
      authenticate(request);
      return reply.send(await decorate(await loadPayment(request.params.intent)));
    },
  );

  fastify.post<{ Params: { intent: string } }>(
    '/v1/payment_intents/:intent',
    async (request, reply) => {
      authenticate(request);
      const body = paymentIntentUpdateSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.intent);
      // Only metadata-ish fields are updatable here; amount and currency are
      // deliberately not, since changing them after confirmation would let a
      // test construct a state Stripe refuses.
      const updated = await storage.payments.update(payment.id, {
        metadata: {
          ...payment.metadata,
          ...(body.metadata ?? {}),
          ...(body.description ? { description: body.description } : {}),
          ...(body.receipt_email ? { receipt_email: body.receipt_email } : {}),
        },
        updatedAt: clock.nowISO(),
      });
      return reply.send(await decorate(updated));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>(
    '/v1/payment_intents',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query);
      const { page, hasMore } = await paginate(
        query,
        (limit, offset) => storage.payments.list({ provider: PROVIDER, limit, offset }),
        (payment) => stripeId('pi', payment.id),
      );
      const data = await Promise.all(page.map((payment) => decorate(payment)));
      return reply.send(list(data, '/v1/payment_intents', hasMore));
    },
  );

  /* ---------------------------------------------------------------- *
   * Charges
   * ---------------------------------------------------------------- */

  async function decorateCharge(payment: Payment) {
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    return serializeCharge(payment, { customer });
  }

  fastify.get<{ Params: { charge: string } }>('/v1/charges/:charge', async (request, reply) => {
    authenticate(request);
    return reply.send(await decorateCharge(await loadPayment(request.params.charge)));
  });

  fastify.get<{ Querystring: Record<string, string> }>('/v1/charges', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.payments.list({ provider: PROVIDER, limit, offset }),
      (payment) => stripeId('ch', payment.id),
    );
    const data = await Promise.all(page.map((p) => decorateCharge(p)));
    return reply.send(list(data, '/v1/charges', hasMore));
  });

  /* ---------------------------------------------------------------- *
   * Refunds
   * ---------------------------------------------------------------- */

  fastify.post('/v1/refunds', async (request, reply) => {
    authenticate(request);
    const body = refundCreateSchema.parse(request.body);
    const handle = body.payment_intent ?? body.charge;
    if (!handle) {
      throw new PayboxError(
        'validation_failed',
        'One of `payment_intent` or `charge` is required.',
      );
    }

    const payment = await loadPayment(handle);
    const refund = await engine.createRefund({
      paymentId: payment.id,
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      reason: body.reason ?? null,
      metadata: body.metadata ?? {},
    });
    // Stripe settles card refunds immediately in test mode; the asynchronous
    // path is modelled for bank-backed methods only, which this slice omits.
    const settled = await engine.transitionRefund(refund.id, 'successful');
    return reply.send(serializeRefund(settled, payment));
  });

  fastify.get<{ Params: { refund: string } }>('/v1/refunds/:refund', async (request, reply) => {
    authenticate(request);
    const canonical = request.params.refund.replace(/^re_/, 'ref_');
    const refund =
      (await storage.refunds.byId(canonical)) ??
      (await storage.refunds.byId(request.params.refund));
    if (!refund) {
      throw new PayboxError('not_found', `No such refund: '${request.params.refund}'.`);
    }
    const payment = await storage.payments.byId(refund.paymentId);
    return reply.send(serializeRefund(refund, payment));
  });

  fastify.get<{ Querystring: Record<string, string> }>('/v1/refunds', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.refunds.list({ limit, offset }),
      (refund) => stripeId('re', refund.id),
    );
    const data = await Promise.all(
      page.map(async (refund) =>
        serializeRefund(refund, await storage.payments.byId(refund.paymentId)),
      ),
    );
    return reply.send(list(data, '/v1/refunds', hasMore));
  });

  /* ---------------------------------------------------------------- *
   * Customers
   * ---------------------------------------------------------------- */

  fastify.post('/v1/customers', async (request, reply) => {
    authenticate(request);
    const body = customerCreateSchema.parse(request.body ?? {});
    const [firstName, ...rest] = (body.name ?? '').split(' ');
    const customer = await engine.createCustomer({
      provider: PROVIDER,
      // Stripe allows a customer with no email; paybox keys on it, so fall
      // back to a synthetic local address rather than rejecting the request.
      email: body.email ?? `${ids.token(10)}@customer.stripe.local`,
      firstName: firstName || null,
      lastName: rest.join(' ') || null,
      phone: body.phone ?? null,
      metadata: body.metadata ?? {},
    });
    return reply.send(serializeCustomer(customer));
  });

  fastify.get<{ Params: { customer: string } }>(
    '/v1/customers/:customer',
    async (request, reply) => {
      authenticate(request);
      return reply.send(serializeCustomer(await loadCustomer(request.params.customer)));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>('/v1/customers', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.customers.list({ provider: PROVIDER, limit, offset }),
      (customer) => stripeId('cus', customer.id),
    );
    return reply.send(list(page.map(serializeCustomer), '/v1/customers', hasMore));
  });

  /* ---------------------------------------------------------------- *
   * PaymentMethods
   * ---------------------------------------------------------------- */

  fastify.post('/v1/payment_methods', async (request, reply) => {
    authenticate(request);
    const body = paymentMethodCreateSchema.parse(request.body);
    if (body.type !== 'card' || !body.card) {
      throw new PayboxError(
        'unsupported_operation',
        `paybox only implements card PaymentMethods; received type "${body.type}".`,
      );
    }

    const masked = maskInstrument(body.card.number);
    const created = await engine.createAuthorizationRecord({
      provider: PROVIDER,
      channel: 'card',
      reusable: true,
      bin: masked.bin,
      last4: masked.last4,
      expMonth: body.card.exp_month != null ? String(body.card.exp_month) : null,
      expYear: body.card.exp_year != null ? String(body.card.exp_year) : null,
      brand: 'visa',
      cardType: 'visa',
      countryCode: 'US',
      metadata: body.metadata ?? {},
    });
    return reply.send(serializePaymentMethod(created));
  });

  fastify.get<{ Params: { paymentMethod: string } }>(
    '/v1/payment_methods/:paymentMethod',
    async (request, reply) => {
      authenticate(request);
      const authorization = await loadAuthorization(request.params.paymentMethod);
      const customer = authorization.customerId
        ? await storage.customers.byId(authorization.customerId)
        : null;
      return reply.send(serializePaymentMethod(authorization, customer));
    },
  );

  fastify.post<{ Params: { paymentMethod: string } }>(
    '/v1/payment_methods/:paymentMethod/attach',
    async (request, reply) => {
      authenticate(request);
      const body = paymentMethodAttachSchema.parse(request.body);
      const authorization = await loadAuthorization(request.params.paymentMethod);
      const customer = await loadCustomer(body.customer);
      const attached = await storage.authorizations.update(authorization.id, {
        customerId: customer.id,
        updatedAt: clock.nowISO(),
      });
      return reply.send(serializePaymentMethod(attached, customer));
    },
  );

  fastify.post<{ Params: { paymentMethod: string } }>(
    '/v1/payment_methods/:paymentMethod/detach',
    async (request, reply) => {
      authenticate(request);
      const authorization = await loadAuthorization(request.params.paymentMethod);
      const detached = await storage.authorizations.update(authorization.id, {
        customerId: null,
        updatedAt: clock.nowISO(),
      });
      return reply.send(serializePaymentMethod(detached));
    },
  );

  void fromStripeStatus;
};

/** Convenience for tests that want the plugin on a bare Fastify. */
export async function registerStripe(
  fastify: FastifyInstance,
  options: StripePluginOptions,
): Promise<void> {
  await fastify.register(stripePlugin, { ...options, prefix: options.basePath });
}

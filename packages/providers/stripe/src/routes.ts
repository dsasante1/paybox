import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type IdFactory,
  type Payment,
  type PaymentMethod,
} from '@paybox/shared';
import { addInterval, type PaymentEngine, type Storage } from '@paybox/core';
import {
  maskInstrument,
  resolveInstrument,
  type PaymentSimulator,
  type SubscriptionRunner,
} from '@paybox/simulator';
import { expandFormBody } from './form.js';
import { applyExpansions, assertExpandDepth, expandPaths } from './expand.js';
import { assertStripeCredentials } from './auth.js';
import { toStripeError } from './errors.js';
import { stripeInstrumentResolver } from './instruments.js';
import { stripeAuthorizationMinter } from './authorization.js';
import { fromStripeRecurring, fromStripeStatus } from './status.js';
import {
  checkoutPaySchema,
  checkoutSessionCreateSchema,
  customerCreateSchema,
  listQuerySchema,
  paymentIntentCancelSchema,
  paymentIntentCaptureSchema,
  paymentIntentConfirmSchema,
  paymentIntentCreateSchema,
  paymentIntentUpdateSchema,
  paymentMethodAttachSchema,
  paymentMethodCreateSchema,
  priceCreateSchema,
  productCreateSchema,
  refundCreateSchema,
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
} from './schemas.js';
import { renderCheckoutPage, renderCheckoutResult } from './checkout.js';
import {
  list,
  serializeCharge,
  serializeCheckoutSession,
  serializeInvoice,
  serializeLineItems,
  serializePrice,
  serializeProduct,
  serializeSubscription,
  serializeCustomer,
  serializePaymentIntent,
  serializePaymentMethod,
  serializeRefund,
  stripeId,
} from './serializers.js';

export interface StripePluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  /** Drives recurring billing; renewals are scheduled through it. */
  subscriptions: SubscriptionRunner;
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
  const { engine, simulator, subscriptions, storage, clock, ids } = options;
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
   * expand[]
   * ---------------------------------------------------------------- */

  /**
   * Resolve one Stripe id to the object it names.
   *
   * Prefix-dispatched, because that is genuinely how Stripe ids work: the
   * prefix is the type. A handle that does not resolve returns null and the
   * caller leaves the string alone -- see `ExpandLoader`.
   */
  async function loadExpandable(handle: string): Promise<unknown | null> {
    try {
      if (handle.startsWith('cus_')) return serializeCustomer(await loadCustomer(handle));
      if (handle.startsWith('pi_')) return await decorate(await loadPayment(handle));
      if (handle.startsWith('ch_')) return await decorateCharge(await loadPayment(handle));
      if (handle.startsWith('pm_')) return serializePaymentMethod(await loadAuthorization(handle));
      if (handle.startsWith('prod_')) return serializeProduct(await loadProduct(handle));
      if (handle.startsWith('price_')) {
        const plan = await loadPrice(handle);
        return serializePrice(plan, plan.productId ? await storage.products.byId(plan.productId) : null);
      }
      if (handle.startsWith('sub_')) return await decorateSubscription(await loadSubscription(handle));
      if (handle.startsWith('in_')) return await decorateInvoice(await loadInvoice(handle));
      if (handle.startsWith('re_')) {
        const canonical = handle.replace(/^re_/, 'ref_');
        const refund = (await storage.refunds.byId(canonical)) ?? (await storage.refunds.byId(handle));
        if (!refund) return null;
        return serializeRefund(refund, await storage.payments.byId(refund.paymentId));
      }
      return null;
    } catch {
      // An unresolvable id is not an error: expansion asks for more detail,
      // and failing to supply it must never turn a 200 into a 404.
      return null;
    }
  }

  const requestedExpansions = (request: FastifyRequest): string[] => [
    ...expandPaths(request.body),
    ...expandPaths(request.query),
  ];

  /**
   * Reject an over-deep `expand[]` before the handler does any work.
   *
   * The check has to happen here rather than at serialisation time: an error
   * thrown from `preSerialization` runs after the handler has already produced
   * a payload, and Fastify answers it from its default serialiser rather than
   * this plugin's -- which would hand a Stripe client a Fastify-shaped error.
   * Validating a bad request up front is what a real API does anyway.
   */
  fastify.addHook('preValidation', async (request) => {
    assertExpandDepth(requestedExpansions(request));
  });

  /**
   * Apply `expand[]` to every JSON response this plugin produces.
   *
   * A `preSerialization` hook rather than a call in each of forty handlers:
   * the payload is still a plain object at this point, so one walk covers the
   * whole surface and no route can forget to honour the parameter. Hooks added
   * inside a plugin apply to that plugin's routes only, which is exactly the
   * encapsulation this adapter is registered for.
   */
  fastify.addHook('preSerialization', async (request, reply, payload) => {
    if (payload === null || typeof payload !== 'object') return payload;
    // An error envelope has no ids worth expanding, and walking it would only
    // risk turning a clean 400 into something else.
    if (reply.statusCode >= 400) return payload;
    const paths = requestedExpansions(request);
    if (paths.length === 0) return payload;
    return applyExpansions(payload, paths, loadExpandable);
  });

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
   * Products and Prices
   *
   * A canonical Plan is a Stripe Price: an amount plus how often. Stripe's
   * Product -- what the thing is -- is a separate row, because one product can
   * carry several prices.
   * ---------------------------------------------------------------- */

  async function loadProduct(handle: string) {
    const canonical = handle.replace(/^prod_/, 'prd_');
    const product = await storage.products.byId(canonical);
    if (product && product.provider === PROVIDER) return product;
    throw new PayboxError('not_found', `No such product: '${handle}'.`);
  }

  async function loadPrice(handle: string) {
    const canonical = handle.replace(/^price_/, 'pln_');
    const plan = await storage.plans.byId(canonical);
    if (plan && plan.provider === PROVIDER) return plan;
    throw new PayboxError('not_found', `No such price: '${handle}'.`);
  }

  fastify.post('/v1/products', async (request, reply) => {
    authenticate(request);
    const body = productCreateSchema.parse(request.body);
    const product = await engine.createProduct({
      provider: PROVIDER,
      name: body.name,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
    });
    return reply.send(serializeProduct(product));
  });

  fastify.get<{ Params: { id: string } }>('/v1/products/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(serializeProduct(await loadProduct(request.params.id)));
  });

  fastify.get<{ Querystring: Record<string, string> }>('/v1/products', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.products.list({ provider: PROVIDER, limit, offset }),
      (product) => stripeId('prod', product.id),
    );
    return reply.send(list(page.map(serializeProduct), '/v1/products', hasMore));
  });

  fastify.post('/v1/prices', async (request, reply) => {
    authenticate(request);
    const body = priceCreateSchema.parse(request.body);
    const currency = body.currency.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `The currency ${body.currency} is not supported.`,
      );
    }
    if (!body.recurring) {
      throw new PayboxError(
        'unsupported_operation',
        'paybox implements recurring prices only; a one-off price has no plan to model.',
      );
    }

    const product = body.product
      ? await loadProduct(body.product)
      : body.product_data
        ? await engine.createProduct({
            provider: PROVIDER,
            name: body.product_data.name,
            description: body.product_data.description ?? null,
          })
        : null;
    if (!product) {
      throw new PayboxError(
        'validation_failed',
        'One of `product` or `product_data` is required.',
      );
    }

    const { interval, intervalCount } = fromStripeRecurring(
      body.recurring.interval,
      body.recurring.interval_count,
    );
    const plan = await engine.createPlan({
      provider: PROVIDER,
      name: body.nickname ?? product.name,
      amount: body.unit_amount,
      currency,
      interval,
      intervalCount,
      productId: product.id,
      metadata: body.metadata ?? {},
    });
    return reply.send(serializePrice(plan, product));
  });

  fastify.get<{ Params: { price: string } }>('/v1/prices/:price', async (request, reply) => {
    authenticate(request);
    const plan = await loadPrice(request.params.price);
    const product = plan.productId ? await storage.products.byId(plan.productId) : null;
    return reply.send(serializePrice(plan, product));
  });

  fastify.get<{ Querystring: Record<string, string> }>('/v1/prices', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.plans.list({ provider: PROVIDER, limit, offset }),
      (plan) => stripeId('price', plan.id),
    );
    const data = await Promise.all(
      page.map(async (plan) =>
        serializePrice(plan, plan.productId ? await storage.products.byId(plan.productId) : null),
      ),
    );
    return reply.send(list(data, '/v1/prices', hasMore));
  });

  /* ---------------------------------------------------------------- *
   * Subscriptions and Invoices
   * ---------------------------------------------------------------- */

  async function loadSubscription(handle: string) {
    const canonical = handle.replace(/^sub_/, 'sub_');
    const subscription = await storage.subscriptions.byId(canonical);
    if (subscription && subscription.provider === PROVIDER) return subscription;
    throw new PayboxError('not_found', `No such subscription: '${handle}'.`);
  }

  async function decorateSubscription(
    subscription: Awaited<ReturnType<typeof loadSubscription>>,
  ) {
    const plan = await storage.plans.byId(subscription.planId);
    const invoices = await storage.invoices.listBySubscription(subscription.id);
    return serializeSubscription(subscription, {
      plan,
      product: plan?.productId ? await storage.products.byId(plan.productId) : null,
      customer: await storage.customers.byId(subscription.customerId),
      latestInvoice: invoices.at(-1) ?? null,
    });
  }

  fastify.post('/v1/subscriptions', async (request, reply) => {
    authenticate(request);
    const body = subscriptionCreateSchema.parse(request.body);
    const customer = await loadCustomer(body.customer);

    if (body.items.length > 1) {
      throw new PayboxError(
        'unsupported_operation',
        'paybox models one price per subscription; multi-item subscriptions are not ' +
          'implemented.',
      );
    }
    const item = body.items[0]!;
    const plan = await loadPrice(item.price);

    const authorization = body.default_payment_method
      ? await loadAuthorization(body.default_payment_method)
      : (await storage.authorizations.listByCustomer(customer.id)).find((a) => a.reusable);
    if (!authorization) {
      throw new PayboxError(
        'validation_failed',
        `No default payment method for ${body.customer}. Attach a PaymentMethod first.`,
      );
    }

    const subscription = await engine.createSubscription({
      provider: PROVIDER,
      customerId: customer.id,
      planId: plan.id,
      authorizationId: authorization.id,
      ...(item.quantity != null ? { quantity: Number(item.quantity) } : {}),
      metadata: body.metadata ?? {},
    });
    await subscriptions.start(subscription);

    return reply.send(await decorateSubscription(subscription));
  });

  fastify.get<{ Params: { id: string } }>('/v1/subscriptions/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(await decorateSubscription(await loadSubscription(request.params.id)));
  });

  fastify.get<{ Querystring: Record<string, string> }>(
    '/v1/subscriptions',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query);
      const { page, hasMore } = await paginate(
        query,
        (limit, offset) => storage.subscriptions.list({ provider: PROVIDER, limit, offset }),
        (subscription) => stripeId('sub', subscription.id),
      );
      const data = await Promise.all(page.map((s) => decorateSubscription(s)));
      return reply.send(list(data, '/v1/subscriptions', hasMore));
    },
  );

  /** `cancel_at_period_end` is Stripe's non-renewing flag, not a status. */
  fastify.post<{ Params: { id: string } }>('/v1/subscriptions/:id', async (request, reply) => {
    authenticate(request);
    const body = subscriptionUpdateSchema.parse(request.body ?? {});
    const subscription = await loadSubscription(request.params.id);

    if (body.cancel_at_period_end === true && subscription.status === 'active') {
      await engine.transitionSubscription(subscription.id, 'non_renewing', {
        // Keep billing the current period; only future renewals stop.
        nextPaymentDate: subscription.nextPaymentDate,
      });
    } else if (body.cancel_at_period_end === false && subscription.status === 'non_renewing') {
      const resumed = await engine.transitionSubscription(subscription.id, 'active', {
        nextPaymentDate: subscription.nextPaymentDate ?? clock.nowISO(),
      });
      await subscriptions.start(resumed);
    }

    return reply.send(await decorateSubscription(await loadSubscription(request.params.id)));
  });

  /** Immediate cancellation. Stripe's DELETE, which its SDKs still use. */
  fastify.delete<{ Params: { id: string } }>('/v1/subscriptions/:id', async (request, reply) => {
    authenticate(request);
    subscriptionCancelSchema.parse(request.body ?? {});
    const subscription = await loadSubscription(request.params.id);
    await engine.transitionSubscription(subscription.id, 'cancelled');
    return reply.send(await decorateSubscription(await loadSubscription(request.params.id)));
  });

  async function decorateInvoice(invoice: Awaited<ReturnType<typeof loadInvoice>>) {
    const subscription = await storage.subscriptions.byId(invoice.subscriptionId);
    return serializeInvoice(invoice, {
      subscription,
      customer: await storage.customers.byId(invoice.customerId),
      payment: invoice.paymentId ? await storage.payments.byId(invoice.paymentId) : null,
      plan: subscription ? await storage.plans.byId(subscription.planId) : null,
    });
  }

  async function loadInvoice(handle: string) {
    const canonical = handle.replace(/^in_/, 'inv_');
    const invoice = await storage.invoices.byId(canonical);
    if (invoice && invoice.provider === PROVIDER) return invoice;
    throw new PayboxError('not_found', `No such invoice: '${handle}'.`);
  }

  fastify.get<{ Params: { invoice: string } }>('/v1/invoices/:invoice', async (request, reply) => {
    authenticate(request);
    return reply.send(await decorateInvoice(await loadInvoice(request.params.invoice)));
  });

  fastify.get<{ Querystring: Record<string, string> }>('/v1/invoices', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const { page, hasMore } = await paginate(
      query,
      (limit, offset) => storage.invoices.list({ provider: PROVIDER, limit, offset }),
      (invoice) => stripeId('in', invoice.id),
    );
    const data = await Promise.all(page.map((i) => decorateInvoice(i)));
    return reply.send(list(data, '/v1/invoices', hasMore));
  });

  /* ---------------------------------------------------------------- *
   * Checkout Sessions
   *
   * A `mode: payment` session and the payment it collects are one lifecycle,
   * so paybox stores the session on the payment with its own fields in
   * metadata rather than as a separate row. `expires_at` and `status:
   * expired` map onto the canonical `expiresAt` and `expired` directly.
   * ---------------------------------------------------------------- */

  /** Stripe expires an unpaid Checkout Session 24 hours after creation. */
  const SESSION_LIFETIME_MS = 24 * 60 * 60_000;

  async function loadSession(handle: string): Promise<Payment> {
    const canonical = handle.replace(/^cs_/, 'pay_');
    const payment =
      (await storage.payments.byId(canonical)) ?? (await storage.payments.byId(handle));
    if (payment && payment.provider === PROVIDER && payment.metadata.mode) return payment;
    throw new PayboxError('not_found', `No such checkout.session: '${handle}'.`);
  }

  async function decorateSession(payment: Payment) {
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    return serializeCheckoutSession(payment, {
      customer,
      baseUrl: options.baseUrl,
      basePath: options.basePath,
    });
  }

  fastify.post('/v1/checkout/sessions', async (request, reply) => {
    authenticate(request);
    const body = checkoutSessionCreateSchema.parse(request.body);

    if (body.mode === 'setup') {
      throw new PayboxError(
        'unsupported_operation',
        'paybox does not implement Checkout in mode=setup; SetupIntents are not modelled.',
      );
    }

    // A line item prices itself with `price_data`, or points at a Price.
    const priced = await Promise.all(
      body.line_items.map(async (item) => {
        if (item.price_data) {
          return {
            name: item.price_data.product_data?.name ?? 'Item',
            unit_amount: item.price_data.unit_amount,
            quantity: item.quantity,
            currency: item.price_data.currency,
            priceId: null as string | null,
          };
        }
        if (!item.price) {
          throw new PayboxError(
            'validation_failed',
            'Each line item needs one of `price` or `price_data`.',
          );
        }
        const plan = await loadPrice(item.price);
        const product = plan.productId ? await storage.products.byId(plan.productId) : null;
        return {
          name: product?.name ?? plan.name,
          unit_amount: plan.amount,
          quantity: item.quantity,
          currency: plan.currency,
          priceId: plan.id,
        };
      }),
    );

    const currency = (body.currency ?? priced[0]!.currency).toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `The currency ${currency.toLowerCase()} is not supported.`,
      );
    }
    if (priced.some((item) => item.currency.toUpperCase() !== currency)) {
      throw new PayboxError(
        'validation_failed',
        'All line items in a session must share one currency.',
      );
    }

    const total = priced.reduce((sum, item) => sum + item.unit_amount * item.quantity, 0);
    const customer = body.customer ? await loadCustomer(body.customer) : null;

    // A subscription session must point at a real Price: there is nothing to
    // renew against an inline one-off amount.
    if (body.mode === 'subscription') {
      const recurring = priced.find((item) => item.priceId);
      if (!recurring) {
        throw new PayboxError(
          'validation_failed',
          'A subscription Checkout Session needs a line item with a recurring `price`.',
        );
      }
    }

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: total,
      currency,
      customerId: customer?.id ?? null,
      callbackUrl: body.success_url ?? null,
      metadata: {
        ...(body.metadata ?? {}),
        mode: body.mode,
        line_items: priced,
        ...(body.mode === 'subscription'
          ? { subscription_price_id: priced.find((i) => i.priceId)?.priceId }
          : {}),
        ...(body.success_url ? { success_url: body.success_url } : {}),
        ...(body.cancel_url ? { cancel_url: body.cancel_url } : {}),
        ...(body.customer_email ? { customer_email: body.customer_email } : {}),
        ...(body.client_reference_id ? { client_reference_id: body.client_reference_id } : {}),
      },
      status: 'created',
      // Stripe expires an unpaid session; modelling it is what lets
      // `paybox time advance 25h` reproduce an abandoned checkout.
      expiresInMs: SESSION_LIFETIME_MS,
    });

    return reply.send(await decorateSession(payment));
  });

  fastify.get<{ Params: { session: string } }>(
    '/v1/checkout/sessions/:session',
    async (request, reply) => {
      authenticate(request);
      return reply.send(await decorateSession(await loadSession(request.params.session)));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>(
    '/v1/checkout/sessions',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query);
      const { page, hasMore } = await paginate(
        query,
        (limit, offset) => storage.payments.list({ provider: PROVIDER, limit, offset }),
        (payment) => stripeId('cs', payment.id),
      );
      const sessions = page.filter((payment) => Boolean(payment.metadata.mode));
      const data = await Promise.all(sessions.map((p) => decorateSession(p)));
      return reply.send(list(data, '/v1/checkout/sessions', hasMore));
    },
  );

  fastify.get<{ Params: { session: string } }>(
    '/v1/checkout/sessions/:session/line_items',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadSession(request.params.session);
      return reply.send(
        list(
          serializeLineItems(payment),
          `/v1/checkout/sessions/${request.params.session}/line_items`,
          false,
        ),
      );
    },
  );

  fastify.post<{ Params: { session: string } }>(
    '/v1/checkout/sessions/:session/expire',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadSession(request.params.session);
      if (payment.status === 'successful') {
        throw new PayboxError(
          'invalid_state_transition',
          'You cannot expire a Checkout Session that has already been paid.',
        );
      }
      const expired = await simulator.expire(payment.id);
      return reply.send(await decorateSession(expired));
    },
  );

  /**
   * Turn a subscription session into a real subscription.
   *
   * The card is minted into a PaymentMethod up front rather than waiting for
   * the session's payment to settle: the subscription needs something to
   * charge, and the payment is still in flight at this point. The mint uses
   * the same fingerprint the engine's minter does, so when the payment does
   * succeed it finds this row and does not create a second.
   *
   * The session's own payment covers the first period, so the subscription is
   * anchored one interval ahead rather than billing immediately -- otherwise
   * the payer would be charged twice for the same period.
   */
  async function startSubscriptionFromSession(payment: Payment): Promise<void> {
    const priceId = payment.metadata.subscription_price_id;
    if (typeof priceId !== 'string' || !payment.customerId) return;

    const plan = await storage.plans.byId(priceId);
    if (!plan) return;

    const existing = (await storage.authorizations.listByCustomer(payment.customerId)).find(
      (a) => a.reusable,
    );
    const draft = stripeAuthorizationMinter(payment);
    if (!existing && !draft) return;

    const authorization =
      existing ??
      (await engine.createAuthorizationRecord({
        provider: PROVIDER,
        customerId: payment.customerId,
        paymentId: payment.id,
        channel: draft!.channel,
        reusable: draft!.reusable,
        ...(draft!.providerAuthorizationCode
          ? { providerAuthorizationCode: draft!.providerAuthorizationCode }
          : {}),
        signature: draft!.signature ?? null,
        bin: draft!.bin ?? null,
        last4: draft!.last4 ?? null,
        expMonth: draft!.expMonth ?? null,
        expYear: draft!.expYear ?? null,
        cardType: draft!.cardType ?? null,
        brand: draft!.brand ?? null,
        countryCode: draft!.countryCode ?? null,
      }));

    const subscription = await engine.createSubscription({
      provider: PROVIDER,
      customerId: payment.customerId,
      planId: plan.id,
      authorizationId: authorization.id,
      startDate: addInterval(clock.nowISO(), plan.interval, plan.intervalCount),
      metadata: { checkout_session: stripeId('cs', payment.id) },
    });
    await subscriptions.start(subscription);
  }

  /* -------------------- the hosted page -------------------- */

  /**
   * Deliberately unauthenticated: this is the page the *payer* visits, not an
   * API call the merchant makes. Stripe's hosted Checkout is public too.
   */
  fastify.get<{ Params: { session: string } }>(
    '/checkout/:session',
    async (request, reply) => {
      const payment = await storage.payments
        .byId(request.params.session.replace(/^cs_/, 'pay_'))
        .catch(() => null);
      if (!payment || payment.provider !== PROVIDER || !payment.metadata.mode) {
        return reply.status(404).type('text/html').send('<h1>Checkout session not found</h1>');
      }
      if (payment.status === 'expired' || payment.status === 'cancelled') {
        return reply
          .status(410)
          .type('text/html')
          .send('<h1>This checkout session has expired</h1>');
      }

      const items = Array.isArray(payment.metadata.line_items)
        ? (payment.metadata.line_items as { name?: string }[])
        : [];
      return reply.type('text/html').send(
        renderCheckoutPage({
          payment,
          sessionId: stripeId('cs', payment.id),
          basePath: options.basePath,
          productName: items[0]?.name ?? 'Payment',
        }),
      );
    },
  );

  fastify.post<{ Params: { session: string } }>(
    '/checkout/:session/pay',
    async (request, reply) => {
      const payment = await storage.payments
        .byId(request.params.session.replace(/^cs_/, 'pay_'))
        .catch(() => null);
      if (!payment || payment.provider !== PROVIDER || !payment.metadata.mode) {
        return reply.status(404).type('text/html').send('<h1>Checkout session not found</h1>');
      }

      const form = checkoutPaySchema.parse(request.body);
      const details = cardDetailsFrom({
        number: form.card_number,
        exp_month: form.exp_month,
        exp_year: form.exp_year,
      });

      await engine.transitionPayment(payment.id, 'pending', {
        paymentMethod: 'card',
        paymentMethodDetails: details,
      });
      const fresh = await loadSession(request.params.session);
      const started = await confirmPayment(fresh, form.card_number);

      // A subscription session starts the subscription once the first payment
      // is on its way, which is what makes `mode: subscription` more than a
      // one-off charge.
      if (fresh.metadata.mode === 'subscription') {
        await startSubscriptionFromSession(fresh);
      }

      const successUrl = payment.metadata.success_url;
      return reply.type('text/html').send(
        renderCheckoutResult({
          payment: started,
          redirectUrl: typeof successUrl === 'string' ? successUrl : null,
          message: 'Your payment is being processed.',
        }),
      );
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

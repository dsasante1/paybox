import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type ErrorCode,
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
import { stripeAuthorizationMinter, stripeInstrumentDraft } from './authorization.js';
import { fromStripeRecurring, fromStripeStatus } from './status.js';
import {
  chargeCaptureSchema,
  chargeCreateSchema,
  chargeUpdateSchema,
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
  setupIntentCancelSchema,
  setupIntentConfirmSchema,
  setupIntentCreateSchema,
  setupIntentUpdateSchema,
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
} from './schemas.js';
import {
  renderCheckoutPage,
  renderCheckoutResult,
  renderSetupAuthenticationPage,
  renderSetupResult,
} from './checkout.js';
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
  serializeSetupIntent,
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

  /** Masked card detail carried by a stored instrument. */
  function authorizationDetails(authorization: {
    bin: string | null;
    last4: string | null;
    expMonth: string | null;
    expYear: string | null;
    brand: string | null;
    countryCode: string | null;
  }): Record<string, unknown> {
    return {
      bin: authorization.bin,
      last4: authorization.last4,
      exp_month: authorization.expMonth,
      exp_year: authorization.expYear,
      brand: authorization.brand,
      country: authorization.countryCode,
    };
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
      if (handle.startsWith('seti_')) return await decorateSetup(await loadSetup(handle));
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
        details = authorizationDetails(authorization);
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
   * SetupIntents
   *
   * Storing an instrument without charging for it. Deliberately *not* a
   * zero-amount payment: a row that never moves money would pollute every
   * total, list and balance with things that are not transactions. The
   * canonical resource is an InstrumentSetup, and it ends in the same stored
   * authorization a successful charge would leave behind -- with the same
   * fingerprint, so a card saved here and the same card charged directly are
   * one PaymentMethod rather than two.
   * ---------------------------------------------------------------- */

  async function loadSetup(handle: string) {
    const canonical = handle.replace(/^seti_/, 'set_');
    const setup =
      (await storage.instrumentSetups.byId(canonical)) ??
      (await storage.instrumentSetups.byId(handle));
    if (setup && setup.provider === PROVIDER) return setup;
    throw new PayboxError('not_found', `No such setup_intent: '${handle}'.`);
  }

  async function decorateSetup(setup: Awaited<ReturnType<typeof loadSetup>>) {
    return serializeSetupIntent(setup, {
      customer: setup.customerId ? await storage.customers.byId(setup.customerId) : null,
      authorization: setup.authorizationId
        ? await storage.authorizations.byId(setup.authorizationId)
        : null,
      baseUrl: options.baseUrl,
      basePath: options.basePath,
    });
  }

  /**
   * Run a setup to its outcome.
   *
   * Uses the same published-card table as a charge, so `4000002500003155`
   * demands a step-up here exactly as it does on a payment -- a developer
   * should not have to learn a second set of test numbers for the setup flow.
   */
  async function confirmSetup(
    setup: Awaited<ReturnType<typeof loadSetup>>,
    number: string | null,
  ) {
    const retry = setup.status === 'failed' ? { retry: true } : {};
    const { outcome } = resolveInstrument(number, setup.channel ?? 'card', {
      resolver: stripeInstrumentResolver,
    });

    if (outcome === 'authentication_required' || outcome === 'timeout') {
      return engine.transitionInstrumentSetup(setup.id, 'requires_action', retry);
    }

    const started = await engine.transitionInstrumentSetup(setup.id, 'processing', retry);
    if (outcome === 'success') {
      return engine.transitionInstrumentSetup(started.id, 'successful');
    }

    const failure = setupFailure(outcome);
    return engine.transitionInstrumentSetup(started.id, 'failed', failure);
  }

  /** The decline a failed setup reports in `last_setup_error`. */
  function setupFailure(outcome: string): { failureCode: string; failureMessage: string } {
    switch (outcome) {
      case 'insufficient_funds':
        return { failureCode: 'insufficient_funds', failureMessage: 'Insufficient funds.' };
      case 'expired_card':
        return { failureCode: 'expired_card', failureMessage: 'The card has expired.' };
      case 'authentication_failed':
      case 'customer_rejected':
        return {
          failureCode: 'authentication_required',
          failureMessage: 'The customer did not complete authentication.',
        };
      default:
        return {
          failureCode: 'card_declined',
          failureMessage: 'The card was declined by the issuer.',
        };
    }
  }

  /** The instrument a setup is being run against, from a body or a stored id. */
  async function setupInstrument(body: {
    payment_method?: string | undefined;
    payment_method_data?: { card?: { number: string; exp_month?: unknown; exp_year?: unknown } } | undefined;
  }): Promise<{ number: string | null; details: Record<string, unknown> } | null> {
    const inline = body.payment_method_data?.card;
    if (inline) return { number: inline.number, details: cardDetailsFrom(inline) };
    if (body.payment_method) {
      const authorization = await loadAuthorization(body.payment_method);
      engine.assertChargeable(authorization);
      return { number: authorization.last4, details: authorizationDetails(authorization) };
    }
    return null;
  }

  fastify.post('/v1/setup_intents', async (request, reply) => {
    authenticate(request);
    const body = setupIntentCreateSchema.parse(request.body ?? {});
    const customer = body.customer ? await loadCustomer(body.customer) : null;
    const instrument = await setupInstrument(body);

    const setup = await engine.createInstrumentSetup({
      provider: PROVIDER,
      customerId: customer?.id ?? null,
      usage: body.usage ?? 'off_session',
      channel: 'card',
      ...(instrument ? { instrument: instrument.details } : {}),
      status: instrument ? 'pending' : 'created',
      metadata: {
        ...(body.metadata ?? {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.return_url ? { return_url: body.return_url } : {}),
      },
    });

    if (body.confirm && instrument) {
      return reply.send(await decorateSetup(await confirmSetup(setup, instrument.number)));
    }
    return reply.send(await decorateSetup(setup));
  });

  fastify.post<{ Params: { intent: string } }>(
    '/v1/setup_intents/:intent/confirm',
    async (request, reply) => {
      authenticate(request);
      const body = setupIntentConfirmSchema.parse(request.body ?? {});
      let setup = await loadSetup(request.params.intent);
      const instrument = await setupInstrument(body);

      if (instrument) {
        setup = await engine.transitionInstrumentSetup(setup.id, 'pending', {
          instrument: instrument.details,
          channel: 'card',
          ...(setup.status === 'failed' ? { retry: true } : {}),
        });
      } else if (Object.keys(setup.instrument).length === 0) {
        throw new PayboxError(
          'validation_failed',
          'You must provide a `payment_method` or `payment_method_data` to confirm this ' +
            'SetupIntent.',
        );
      }

      const number =
        instrument?.number ?? (setup.instrument.last4 as string | undefined) ?? null;
      return reply.send(await decorateSetup(await confirmSetup(setup, number)));
    },
  );

  fastify.post<{ Params: { intent: string } }>(
    '/v1/setup_intents/:intent/cancel',
    async (request, reply) => {
      authenticate(request);
      const body = setupIntentCancelSchema.parse(request.body ?? {});
      const setup = await loadSetup(request.params.intent);
      const cancelled = await engine.transitionInstrumentSetup(setup.id, 'cancelled', {
        cancellationReason: body.cancellation_reason ?? 'requested_by_customer',
      });
      return reply.send(await decorateSetup(cancelled));
    },
  );

  fastify.get<{ Params: { intent: string } }>(
    '/v1/setup_intents/:intent',
    async (request, reply) => {
      authenticate(request);
      return reply.send(await decorateSetup(await loadSetup(request.params.intent)));
    },
  );

  fastify.post<{ Params: { intent: string } }>(
    '/v1/setup_intents/:intent',
    async (request, reply) => {
      authenticate(request);
      const body = setupIntentUpdateSchema.parse(request.body ?? {});
      const setup = await loadSetup(request.params.intent);
      const updated = await storage.instrumentSetups.update(setup.id, {
        metadata: {
          ...setup.metadata,
          ...(body.metadata ?? {}),
          ...(body.description ? { description: body.description } : {}),
        },
        ...(body.customer ? { customerId: (await loadCustomer(body.customer)).id } : {}),
        updatedAt: clock.nowISO(),
      });
      return reply.send(await decorateSetup(updated));
    },
  );

  fastify.get<{ Querystring: Record<string, string> }>(
    '/v1/setup_intents',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query);
      const customer = query.customer ? await loadCustomer(query.customer) : null;
      const { page, hasMore } = await paginate(
        query,
        (limit, offset) =>
          storage.instrumentSetups.list({
            provider: PROVIDER,
            limit,
            offset,
            ...(customer ? { customerId: customer.id } : {}),
          }),
        (setup) => stripeId('seti', setup.id),
      );
      const data = await Promise.all(page.map((setup) => decorateSetup(setup)));
      return reply.send(list(data, '/v1/setup_intents', hasMore));
    },
  );

  /**
   * The step-up page `next_action.redirect_to_url` points at.
   *
   * Served because advertising a URL and answering it with a 404 would be
   * worse than omitting `next_action` altogether.
   */
  fastify.get<{ Params: { setup: string } }>('/setup/:setup', async (request, reply) => {
    const setup = await loadSetup(request.params.setup);
    if (setup.status !== 'requires_action') {
      return reply.type('text/html').send(
        renderSetupResult({
          approved: setup.status === 'successful',
          redirectUrl: (setup.metadata.return_url as string | undefined) ?? null,
        }),
      );
    }
    return reply.type('text/html').send(
      renderSetupAuthenticationPage({
        setupId: stripeId('seti', setup.id),
        basePath: options.basePath,
        last4: (setup.instrument.last4 as string | undefined) ?? null,
      }),
    );
  });

  fastify.post<{ Params: { setup: string }; Body: { outcome?: string } }>(
    '/setup/:setup/complete',
    async (request, reply) => {
      const setup = await loadSetup(request.params.setup);
      if (setup.status !== 'requires_action') {
        throw new PayboxError(
          'invalid_state_transition',
          `This SetupIntent is not awaiting authentication; it is ${setup.status}.`,
        );
      }

      const approved = (request.body?.outcome ?? 'approve') !== 'reject';
      const settled = approved
        ? await engine.transitionInstrumentSetup(setup.id, 'successful')
        : await engine.transitionInstrumentSetup(setup.id, 'failed', {
            failureCode: 'authentication_required',
            failureMessage: 'The customer did not complete authentication.',
          });

      return reply.type('text/html').send(
        renderSetupResult({
          approved: settled.status === 'successful',
          redirectUrl: (setup.metadata.return_url as string | undefined) ?? null,
        }),
      );
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

  /**
   * `POST /v1/charges` -- the legacy direct charge (`PostCharges`).
   *
   * Deprecated at Stripe but still widely deployed, and it behaves differently
   * enough from PaymentIntents to be worth modelling rather than aliasing:
   *
   *   - It is **synchronous**. The response says whether the money moved, so a
   *     decline is HTTP 402 with a `card_error`, not a 200 carrying an object
   *     you are meant to retry.
   *   - It cannot do SCA. A card that needs a step-up fails with
   *     `authentication_required` instead of parking at `requires_action` --
   *     which is the whole reason Stripe moved everyone to PaymentIntents, and
   *     exactly the wall a developer on this API needs to hit locally.
   *
   * The underlying row is the same canonical payment a PaymentIntent creates,
   * so `pi_` and `ch_` still address one resource (docs/stripe.md).
   */
  fastify.post('/v1/charges', async (request, reply) => {
    authenticate(request);
    const body = chargeCreateSchema.parse(request.body);
    const currency = body.currency.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `The currency ${body.currency} is not supported.`,
      );
    }

    const customer = body.customer ? await loadCustomer(body.customer) : null;

    // Where the instrument comes from, in Stripe's own order of precedence:
    // an explicit source, then inline card details, then the customer's
    // stored default.
    let number: string | null = null;
    let details: Record<string, unknown> | null = null;

    if (body.source) {
      const authorization = await loadAuthorization(body.source);
      engine.assertChargeable(authorization);
      number = authorization.last4;
      details = authorizationDetails(authorization);
    } else if (body.card) {
      number = body.card.number;
      details = cardDetailsFrom(body.card);
    } else if (customer) {
      const stored = (await storage.authorizations.listByCustomer(customer.id)).find(
        (candidate) => candidate.reusable && candidate.active,
      );
      if (!stored) {
        throw new PayboxError(
          'validation_failed',
          `Customer ${body.customer} has no attached payment source.`,
        );
      }
      number = stored.last4;
      details = authorizationDetails(stored);
    } else {
      throw new PayboxError(
        'validation_failed',
        'Must provide source or customer.',
      );
    }

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      customerId: customer?.id ?? null,
      paymentMethod: 'card',
      paymentMethodDetails: details,
      metadata: {
        ...(body.metadata ?? {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.receipt_email ? { receipt_email: body.receipt_email } : {}),
        ...(body.transfer_group ? { transfer_group: body.transfer_group } : {}),
        ...(body.capture === false ? { capture_method: 'manual' } : {}),
      },
      status: 'pending',
    });

    const { outcome } = resolveInstrument(number, 'card', {
      resolver: stripeInstrumentResolver,
    });

    // `capture: false` authorizes and stops, which is the legacy spelling of a
    // manual-capture intent.
    let settled: Payment;
    if (body.capture === false && outcome === 'success') {
      await engine.transitionPayment(payment.id, 'processing');
      settled = await engine.transitionPayment(payment.id, 'authorized');
    } else {
      settled = await simulator.apply(payment.id, outcome);
    }

    if (settled.status === 'requires_action') {
      // The Charges API has no way to present a step-up, so Stripe fails the
      // charge outright rather than leaving it in limbo.
      const failed = await simulator.apply(settled.id, 'authentication_failed');
      throw new PayboxError(
        'authentication_required',
        'This card requires authentication, which the Charges API cannot perform. ' +
          'Use the PaymentIntents API.',
        { details: { stripeCharge: stripeId('ch', failed.id), stripePaymentIntent: stripeId('pi', failed.id) } },
      );
    }

    if (settled.status === 'failed') {
      throw new PayboxError(
        (settled.failureCode ?? 'card_declined') as ErrorCode,
        settled.failureMessage ?? 'Your card was declined.',
        {
          details: {
            stripeCharge: stripeId('ch', settled.id),
            stripePaymentIntent: stripeId('pi', settled.id),
          },
        },
      );
    }

    return reply.send(await decorateCharge(settled));
  });

  fastify.post<{ Params: { charge: string } }>(
    '/v1/charges/:charge/capture',
    async (request, reply) => {
      authenticate(request);
      chargeCaptureSchema.parse(request.body ?? {});
      const payment = await loadPayment(request.params.charge);
      if (payment.status !== 'authorized') {
        throw new PayboxError(
          'invalid_state_transition',
          `Charge ${request.params.charge} has already been captured.`,
        );
      }
      // Partial capture would have to shrink the charge amount, and paybox
      // stores one amount per payment; docs/stripe.md records the omission
      // rather than silently capturing the full amount as if it were partial.
      return reply.send(await decorateCharge(await simulator.capture(payment.id)));
    },
  );

  fastify.post<{ Params: { charge: string } }>('/v1/charges/:charge', async (request, reply) => {
    authenticate(request);
    const body = chargeUpdateSchema.parse(request.body ?? {});
    const payment = await loadPayment(request.params.charge);
    const updated = await storage.payments.update(payment.id, {
      metadata: {
        ...payment.metadata,
        ...(body.metadata ?? {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.receipt_email ? { receipt_email: body.receipt_email } : {}),
        ...(body.transfer_group ? { transfer_group: body.transfer_group } : {}),
      },
      ...(body.customer ? { customerId: (await loadCustomer(body.customer)).id } : {}),
      updatedAt: clock.nowISO(),
    });
    return reply.send(await decorateCharge(updated));
  });

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

    // Through the same draft builder the charge and setup paths use, so one
    // card is one PaymentMethod whichever door it came in by.
    const draft = stripeInstrumentDraft('card', cardDetailsFrom(body.card), body.card.number);
    const created = await engine.createAuthorizationRecord({
      provider: PROVIDER,
      channel: 'card',
      reusable: true,
      bin: draft.bin ?? null,
      last4: draft.last4 ?? null,
      expMonth: draft.expMonth ?? null,
      expYear: draft.expYear ?? null,
      brand: draft.brand ?? null,
      cardType: draft.cardType ?? null,
      countryCode: draft.countryCode ?? null,
      signature: draft.signature ?? null,
      ...(draft.providerAuthorizationCode
        ? { providerAuthorizationCode: draft.providerAuthorizationCode }
        : {}),
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
      const attached = await engine.attachAuthorization(authorization.id, customer.id);
      return reply.send(serializePaymentMethod(attached, customer));
    },
  );

  fastify.post<{ Params: { paymentMethod: string } }>(
    '/v1/payment_methods/:paymentMethod/detach',
    async (request, reply) => {
      authenticate(request);
      const authorization = await loadAuthorization(request.params.paymentMethod);
      const detached = await engine.detachAuthorization(authorization.id);
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

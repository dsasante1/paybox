import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PayboxError,
  isSupportedCurrency,
  type Clock,
  type IdFactory,
  type Payment,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { maskInstrument, type PaymentSimulator } from '@paybox/simulator';
import {
  assertV4AccessToken,
  assertV4TokenRequest,
  mintAccessToken,
  V4_TOKEN_LIFETIME_SECONDS,
  type V4Credentials,
} from './auth.js';
import { toV4Error } from './errors.js';
import {
  fallsOverTo3ds,
  nextActionFor,
  outcomeForIssuer,
  parseScenarioKey,
  V4_MOCK_PIN,
} from './scenarios.js';
import {
  serializeV4Charge,
  serializeV4Customer,
  serializeV4PaymentMethod,
  serializeV4Refund,
  serializeV4Transfer,
  v4Ok,
  type V4NextAction,
} from './serializers.js';
import { markV4 } from './version.js';

export interface FlutterwaveV4PluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  credentials: V4Credentials;
  allowAnyKey?: boolean;
}

const PROVIDER = 'flutterwave' as const;

/* ------------------------------- schemas ------------------------------- */

const tokenSchema = z.object({
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  grant_type: z.string().optional(),
});

const nameSchema = z.object({
  first: z.string().optional(),
  middle: z.string().optional(),
  last: z.string().optional(),
});

const customerSchema = z.object({
  email: z.string().email(),
  name: nameSchema.optional(),
  phone: z.object({ country_code: z.string().optional(), number: z.string().optional() }).optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const paymentMethodSchema = z.object({
  type: z.string().default('card'),
  card: z
    .object({
      encrypted_card_number: z.string().optional(),
      card_number: z.string().optional(),
      expiry_month: z.union([z.number(), z.string()]).optional(),
      expiry_year: z.union([z.number(), z.string()]).optional(),
      encrypted_cvv: z.string().optional(),
      cvv: z.string().optional(),
      nonce: z.string().optional(),
    })
    .optional(),
  customer_id: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** v4 amounts are plain major-unit numbers, not v3's decimal strings. */
const v4Amount = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Amount must be a positive number.' });
    return z.NEVER;
  }
  return Math.round(parsed * 100);
});

const chargeSchema = z.object({
  reference: z.string().min(1),
  currency: z.string().min(3).max(3),
  amount: v4Amount,
  customer_id: z.string().min(1),
  payment_method_id: z.string().optional(),
  redirect_url: z.string().optional(),
  recurring: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const authorizeSchema = z.object({
  authorization: z
    .object({
      type: z.string(),
      pin: z.object({ nonce: z.string().optional(), encrypted_pin: z.string().optional() }).optional(),
      avs: z.record(z.string(), z.unknown()).optional(),
      otp: z.object({ code: z.string().optional() }).optional(),
    })
    .optional(),
});

const refundSchema = z.object({ amount: v4Amount.optional(), meta: z.record(z.string(), z.unknown()).optional() });

const transferSchema = z.object({
  reference: z.string().min(1),
  amount: v4Amount,
  currency: z.string().min(3).max(3),
  narration: z.string().optional(),
  destination: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Flutterwave v4-compatible HTTP surface.
 *
 * A second, genuinely different API from the same provider: OAuth 2.0 instead
 * of API keys, `{status:"failed", error:{type,code}}` instead of
 * `{status:"error", message, data}`, prefixed string ids instead of integers,
 * and an `X-Scenario-Key` header instead of a test-card table. Registered as
 * its own encapsulated plugin so none of that can leak into v3's routes.
 *
 * Shapes verified at developer.flutterwave.com/docs, read 2026-08-29.
 */
export const flutterwaveV4Plugin: FastifyPluginAsync<FlutterwaveV4PluginOptions> = async (
  fastify,
  options,
) => {
  const { engine, simulator, storage, clock, ids } = options;

  /**
   * Tokens this plugin has issued, with their expiry.
   *
   * In memory rather than in the database: a token is a session, not a record,
   * and it must not survive a restart -- an emulator that honoured a token
   * from a previous run would hide the expiry behaviour this exists to model.
   */
  const tokens = new Map<string, number>();

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toV4Error(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      status: 'failed',
      error: {
        type: 'NOT_FOUND',
        code: '10404',
        message: `Unknown endpoint (${request.method} ${request.url}).`,
      },
    }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertV4AccessToken(request.headers.authorization, tokens, clock.now());
  };

  const scenarioOf = (request: FastifyRequest) =>
    parseScenarioKey(
      Array.isArray(request.headers['x-scenario-key'])
        ? request.headers['x-scenario-key'][0]
        : request.headers['x-scenario-key'],
    );

  function assertCurrency(code: string): string {
    const currency = code.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PayboxError('unsupported_currency', `The currency ${code} is not supported.`);
    }
    return currency;
  }

  /* ------------------------------ oauth ------------------------------ */

  /**
   * The token endpoint.
   *
   * Flutterwave's lives on a separate IdP host; paybox serves it under the
   * same base so a client only has to change one URL. docs/flutterwave.md
   * records the difference.
   */
  fastify.post('/oauth/token', async (request, reply) => {
    const body = tokenSchema.parse(request.body ?? {});
    assertV4TokenRequest(body, options.credentials, {
      allowAnyKey: options.allowAnyKey ?? false,
    });

    const { accessToken, expiresAtMs } = mintAccessToken(options.credentials, clock.now());
    tokens.set(accessToken, expiresAtMs);

    return reply.send({
      access_token: accessToken,
      expires_in: V4_TOKEN_LIFETIME_SECONDS,
      refresh_expires_in: 0,
      token_type: 'Bearer',
      'not-before-policy': 0,
      scope: 'profile email',
    });
  });

  /* ----------------------------- customers ----------------------------- */

  async function loadCustomerById(handle: string) {
    const { items } = await storage.customers.list({ provider: PROVIDER, limit: 1000 });
    const match = items.find(
      (customer) =>
        serializeV4Customer(customer).id === handle || customer.id === handle,
    );
    if (!match) throw new PayboxError('not_found', `No customer with id ${handle}.`);
    return match;
  }

  fastify.post('/customers', async (request, reply) => {
    authenticate(request);
    const body = customerSchema.parse(request.body);

    const existing = await storage.customers.byEmail(PROVIDER, body.email);
    const customer =
      existing ??
      (await engine.createCustomer({
        provider: PROVIDER,
        email: body.email,
        firstName: body.name?.first ?? null,
        lastName: body.name?.last ?? null,
        phone: body.phone?.number ?? null,
        metadata: body.meta ?? {},
      }));

    return reply.send(v4Ok('success', 'Customer created', serializeV4Customer(customer)));
  });

  fastify.get<{ Params: { id: string } }>('/customers/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(
      v4Ok('success', 'Customer fetched', serializeV4Customer(await loadCustomerById(request.params.id))),
    );
  });

  /* -------------------------- payment methods -------------------------- */

  async function loadPaymentMethod(handle: string) {
    const { items } = await storage.authorizations.list({ provider: PROVIDER, limit: 1000 });
    const match = items.find(
      (row) => serializeV4PaymentMethod(row).id === handle || row.id === handle,
    );
    if (!match) throw new PayboxError('not_found', `No payment method with id ${handle}.`);
    return match;
  }

  fastify.post('/payment-methods', async (request, reply) => {
    authenticate(request);
    const body = paymentMethodSchema.parse(request.body);
    if (body.type !== 'card' || !body.card) {
      throw new PayboxError(
        'unsupported_operation',
        `paybox implements card payment methods only; received type "${body.type}".`,
      );
    }

    // v4 sends card numbers encrypted per-field with a nonce. paybox accepts
    // the plain field too, so a developer exploring with curl need not
    // hand-encrypt; docs/flutterwave.md records that as an emulator
    // convenience. Either way only masked fragments are stored (spec §29).
    const number = body.card.card_number ?? body.card.encrypted_card_number ?? '';
    if (number.length < 12) {
      throw new PayboxError(
        'validation_failed',
        'A card number is required, as `card_number` or `encrypted_card_number`.',
      );
    }
    const masked = maskInstrument(number);

    const authorization = await engine.createAuthorizationRecord({
      provider: PROVIDER,
      channel: 'card',
      reusable: true,
      ...(body.customer_id ? { customerId: (await loadCustomerById(body.customer_id)).id } : {}),
      bin: masked.bin,
      last4: masked.last4,
      expMonth: body.card.expiry_month != null ? String(body.card.expiry_month) : null,
      expYear: body.card.expiry_year != null ? String(body.card.expiry_year) : null,
      brand: 'mastercard',
      metadata: body.meta ?? {},
    });

    return reply.send(
      v4Ok('success', 'Payment method created', serializeV4PaymentMethod(authorization)),
    );
  });

  fastify.get<{ Params: { id: string } }>('/payment-methods/:id', async (request, reply) => {
    authenticate(request);
    return reply.send(
      v4Ok(
        'success',
        'Payment method fetched',
        serializeV4PaymentMethod(await loadPaymentMethod(request.params.id)),
      ),
    );
  });

  /* ------------------------------- charges ------------------------------- */

  async function loadCharge(handle: string): Promise<Payment> {
    const { items } = await storage.payments.list({ provider: PROVIDER, limit: 1000 });
    const match = items.find(
      (payment) => serializeV4Charge(payment).id === handle || payment.id === handle,
    );
    if (!match) throw new PayboxError('not_found', `No charge with id ${handle}.`);
    return match;
  }

  function redirectFor(payment: Payment): V4NextAction {
    return {
      type: 'redirect_url',
      redirect_url: {
        url: `${options.baseUrl}${options.basePath}/redirect/${encodeURIComponent(
          payment.reference,
        )}`,
      },
    };
  }

  fastify.post('/charges', async (request, reply) => {
    authenticate(request);
    const body = chargeSchema.parse(request.body);
    const currency = assertCurrency(body.currency);
    const key = scenarioOf(request);

    if (await storage.payments.byReference(PROVIDER, body.reference)) {
      throw new PayboxError(
        'duplicate_reference',
        `Reference "${body.reference}" has already been used.`,
      );
    }

    const customer = await loadCustomerById(body.customer_id);
    const method = body.payment_method_id
      ? await loadPaymentMethod(body.payment_method_id)
      : null;

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      customerId: customer.id,
      callbackUrl: body.redirect_url ?? null,
      ...(method
        ? {
            paymentMethod: 'card' as const,
            paymentMethodDetails: {
              bin: method.bin,
              last4: method.last4,
              exp_month: method.expMonth,
              exp_year: method.expYear,
              brand: method.brand,
            },
          }
        : {}),
      metadata: markV4({
        ...(body.meta ?? {}),
        v4_scenario: key.scenario,
        v4_issuer: key.issuer,
        // Which stored instrument paid, so the webhook's `payment_method.id`
        // is the same `pmd_` id the API handed out for it.
        ...(method ? { v4_payment_method: method.id } : {}),
      }),
      status: 'pending',
    });

    // Flutterwave documents that an unrecognised scenario key defaults to a
    // pending charge rather than an error. Reproduced: silently treating a
    // typo as `approved` would turn a failure test into a false pass.
    if (key.invalid) {
      return reply.send(
        v4Ok('pending', 'Charge pending', serializeV4Charge(payment, { customer })),
      );
    }

    const action = nextActionFor(key.scenario);
    if (action) {
      const parked = await engine.transitionPayment(payment.id, 'requires_action');
      const nextAction: V4NextAction =
        action.type === 'redirect_url' ? redirectFor(parked) : action;
      return reply.send(
        v4Ok('pending', 'Charge requires authorization', serializeV4Charge(parked, {
          customer,
          nextAction,
          processorResponse: key.issuer,
        })),
      );
    }

    // `noauth`: the issuer answers immediately.
    const settled = await simulator.apply(payment.id, outcomeForIssuer(key.issuer));
    return reply.send(
      v4Ok(
        settled.status === 'successful' ? 'success' : 'failed',
        settled.status === 'successful' ? 'Charge created' : 'Charge failed',
        serializeV4Charge(settled, { customer, processorResponse: key.issuer }),
      ),
    );
  });

  /**
   * Supply the authorization a charge asked for.
   *
   * v4 uses `PUT /charges/{id}` for this, where v3 had a second POST to
   * `/charges` and a separate `/validate-charge`.
   */
  fastify.put<{ Params: { id: string } }>('/charges/:id', async (request, reply) => {
    authenticate(request);
    const body = authorizeSchema.parse(request.body ?? {});
    const key = scenarioOf(request);
    const payment = await loadCharge(request.params.id);

    if (payment.status !== 'requires_action') {
      throw new PayboxError(
        'invalid_state_transition',
        `This charge is not awaiting authorization; it is ${payment.status}.`,
      );
    }

    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    const scenario = (payment.metadata.v4_scenario as typeof key.scenario) ?? key.scenario;
    const issuer = (payment.metadata.v4_issuer as string) ?? key.issuer;

    // `auth_pin_3ds` is the documented failover: a PIN, then a redirect to
    // 3-D Secure. Collapsing it into one step would hide the exact case the
    // scenario exists to test, so the second step-up is returned here.
    const suppliedPin = body.authorization?.pin?.encrypted_pin ?? body.authorization?.type === 'pin';
    if (fallsOverTo3ds(scenario) && suppliedPin && payment.metadata.v4_pin_done !== true) {
      await storage.payments.update(payment.id, {
        metadata: { ...payment.metadata, v4_pin_done: true },
        updatedAt: clock.nowISO(),
      });
      const fresh = await loadCharge(request.params.id);
      return reply.send(
        v4Ok('pending', 'Charge requires authorization', serializeV4Charge(fresh, {
          customer,
          nextAction: redirectFor(fresh),
          processorResponse: issuer,
        })),
      );
    }

    const settled = await simulator.apply(payment.id, outcomeForIssuer(issuer));
    return reply.send(
      v4Ok(
        settled.status === 'successful' ? 'success' : 'failed',
        settled.status === 'successful' ? 'Charge created' : 'Charge failed',
        serializeV4Charge(settled, { customer, processorResponse: issuer }),
      ),
    );
  });

  fastify.get<{ Params: { id: string } }>('/charges/:id', async (request, reply) => {
    authenticate(request);
    const payment = await loadCharge(request.params.id);
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    return reply.send(
      v4Ok('success', 'Charge fetched', serializeV4Charge(payment, {
        customer,
        processorResponse: (payment.metadata.v4_issuer as string | undefined) ?? 'approved',
      })),
    );
  });

  /**
   * The page `next_action.redirect_url` points at.
   *
   * Advertising a URL and answering it with a 404 would be worse than omitting
   * `next_action` entirely.
   */
  fastify.get<{ Params: { ref: string } }>('/redirect/:ref', async (request, reply) => {
    const payment = await storage.payments.byReference(PROVIDER, request.params.ref);
    if (!payment) throw new PayboxError('not_found', `No charge for "${request.params.ref}".`);

    if (payment.status === 'requires_action') {
      await simulator.apply(
        payment.id,
        outcomeForIssuer((payment.metadata.v4_issuer as string | undefined) ?? 'approved'),
      );
    }
    const settled = await storage.payments.byId(payment.id);
    const target = settled?.callbackUrl;
    if (target) {
      const separator = target.includes('?') ? '&' : '?';
      return reply.redirect(
        `${target}${separator}reference=${encodeURIComponent(payment.reference)}&status=${
          settled?.status === 'successful' ? 'successful' : 'failed'
        }`,
      );
    }
    return reply.send(
      v4Ok('success', 'Authorization complete', serializeV4Charge(settled ?? payment)),
    );
  });

  /* ------------------------------- refunds ------------------------------- */

  fastify.post<{ Params: { id: string } }>('/charges/:id/refund', async (request, reply) => {
    authenticate(request);
    const body = refundSchema.parse(request.body ?? {});
    const payment = await loadCharge(request.params.id);

    const refund = await engine.createRefund({
      paymentId: payment.id,
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      metadata: markV4(body.meta ?? {}),
    });
    const settled = await engine.transitionRefund(refund.id, 'successful');
    return reply.send(v4Ok('success', 'Refund created', serializeV4Refund(settled, payment)));
  });

  /* ------------------------------ transfers ------------------------------ */

  fastify.post('/transfers', async (request, reply) => {
    authenticate(request);
    const body = transferSchema.parse(request.body);
    const currency = assertCurrency(body.currency);
    const key = scenarioOf(request);

    // Transfer scenarios name an outcome directly rather than a flow.
    if (key.transfer === 'transfer_amount_below_limit') {
      throw new PayboxError('validation_failed', 'Transfer amount is below the allowed limit.');
    }
    if (key.transfer === 'account_verification_failed') {
      throw new PayboxError('validation_failed', 'Could not verify the destination account.');
    }

    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: body.amount,
      currency,
      reference: body.reference,
      reason: body.narration ?? null,
      status: 'pending',
      metadata: markV4(body.meta ?? {}),
    });

    if (key.transfer === 'successful') {
      const settled = await engine.transitionTransfer(transfer.id, 'successful');
      return reply.send(v4Ok('success', 'Transfer completed', serializeV4Transfer(settled)));
    }
    if (key.transfer === 'failed') {
      const failed = await engine.transitionTransfer(transfer.id, 'failed', {
        failureReason: 'Mocked failure via X-Scenario-Key',
      });
      return reply.send(v4Ok('failed', 'Transfer failed', serializeV4Transfer(failed)));
    }
    if (key.transfer === 'reversed') {
      await engine.transitionTransfer(transfer.id, 'processing');
      const reversed = await engine.transitionTransfer(transfer.id, 'reversed');
      return reply.send(v4Ok('failed', 'Transfer reversed', serializeV4Transfer(reversed)));
    }

    return reply.send(v4Ok('pending', 'Transfer queued', serializeV4Transfer(transfer)));
  });

  void ids;
  void V4_MOCK_PIN;
};

/** Convenience for tests that want the plugin on a bare Fastify. */
export async function registerFlutterwaveV4(
  fastify: FastifyInstance,
  options: FlutterwaveV4PluginOptions,
): Promise<void> {
  await fastify.register(flutterwaveV4Plugin, { ...options, prefix: options.basePath });
}

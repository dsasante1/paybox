import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * The shared surface, now that there are two adapters.
 *
 * Coverage honesty is a product requirement (spec §31): the emulator must
 * never announce a capability it has not implemented, and must announce the
 * ones it has.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'surface';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

describe('provider listing', () => {
  it('reports both implemented adapters as partial', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const byId = Object.fromEntries(
      (res.json().providers as { id: string; status: string }[]).map((p) => [p.id, p.status]),
    );

    expect(byId.paystack).toBe('partial');
    expect(byId.stripe).toBe('partial');
  });

  it('never reports an unimplemented adapter as available', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const providers = res.json().providers as { id: string; status: string }[];
    for (const provider of providers) {
      if (provider.id === 'paystack' || provider.id === 'stripe') continue;
      expect(provider.status).toBe('not_implemented');
    }
  });

  it('gives each implemented provider its own test key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const providers = res.json().providers as {
      id: string;
      keys?: { secretKey: string };
    }[];

    const paystack = providers.find((p) => p.id === 'paystack')!;
    const stripe = providers.find((p) => p.id === 'stripe')!;

    expect(paystack.keys?.secretKey).toMatch(/^sk_test_/);
    expect(stripe.keys?.secretKey).toMatch(/^sk_test_/);
    // Different keys: one provider's should not work on the other by
    // accident, because a real integration would never have them shared.
    expect(stripe.keys?.secretKey).not.toBe(paystack.keys?.secretKey);
  });
});

describe('the shared control plane', () => {
  async function paystackPayment() {
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: { authorization: 'Bearer sk_test_local_suite' },
      payload: {
        email: 'p@example.com',
        amount: 50_000,
        currency: 'NGN',
        card: { number: '4000000000000000' },
      },
    });
  }

  async function stripePayment() {
    await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: {
        authorization: 'Bearer sk_test_local_suite',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        amount: '2000',
        currency: 'usd',
        confirm: 'true',
        'payment_method_data[card][number]': '4242424242424242',
      }).toString(),
    });
  }

  it('lists payments from both providers together', async () => {
    await paystackPayment();
    await stripePayment();

    const res = await app.inject({ method: 'GET', url: '/api/payments?limit=10' });
    const providers = (res.json().items as { provider: string }[]).map((p) => p.provider);
    expect(providers).toContain('paystack');
    expect(providers).toContain('stripe');
  });

  it('filters payments by provider', async () => {
    await paystackPayment();
    await stripePayment();

    const res = await app.inject({ method: 'GET', url: '/api/payments?provider=stripe' });
    const items = res.json().items as { provider: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((p) => p.provider === 'stripe')).toBe(true);
  });

  it('keeps each provider in its own error envelope', async () => {
    const paystack = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/verify/nope',
      headers: { authorization: 'Bearer sk_test_local_suite' },
    });
    const stripe = await app.inject({
      method: 'GET',
      url: '/stripe/v1/payment_intents/pi_nope',
      headers: { authorization: 'Bearer sk_test_local_suite' },
    });

    // Paystack: {status:false,message}. Stripe: {error:{type,...}}.
    expect(paystack.json()).toHaveProperty('status', false);
    expect(paystack.json()).not.toHaveProperty('error');
    expect(stripe.json()).toHaveProperty('error');
    expect(stripe.json()).not.toHaveProperty('status');
  });
});

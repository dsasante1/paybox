import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { wewireSigningKey } from '@paybox/wewire';
import { WISE_UNUSED_SECRET } from '@paybox/wise';

/**
 * The secret an endpoint gets when the caller supplies none (spec §9, §31).
 *
 * Every provider used to default to the Paystack key -- a value that verified
 * nowhere but Paystack. What a verifier expects is provider knowledge: Stripe's
 * `constructEvent` and WeWire's Standard Webhooks libraries are handed a
 * `whsec_` secret, and the latter base64-decode whatever follows the prefix.
 */
let app: FastifyInstance;
let context: PayboxContext;

async function boot() {
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
}

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'endpoint-defaults';
  await boot();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

interface EndpointBody {
  provider?: string;
  secret?: string;
  error?: string;
  message?: string;
}

async function register(payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/api/webhooks/endpoints', payload });
  return { status: response.statusCode, body: response.json() as EndpointBody };
}

describe('POST /api/webhooks/endpoints without a secret', () => {
  it('signs Paystack endpoints with the local secret key, as Paystack does', async () => {
    const { status, body } = await register({ url: 'http://localhost:9999/hook' });
    expect(status).toBe(201);
    expect(body.provider).toBe('paystack');
    expect(body.secret).toBe(context.keys.secretKey);
  });

  it('issues Stripe a whsec_ endpoint secret, distinct per endpoint', async () => {
    const first = await register({ url: 'http://localhost:9999/a', provider: 'stripe' });
    const second = await register({ url: 'http://localhost:9999/b', provider: 'stripe' });
    expect(first.body.secret).toMatch(/^whsec_local[0-9a-z]+$/);
    expect(second.body.secret).toMatch(/^whsec_local[0-9a-z]+$/);
    expect(first.body.secret).not.toBe(second.body.secret);
    // Stripe's endpoint secret is not its API key, and neither is ours.
    expect(first.body.secret).not.toBe(context.stripeKeys.secretKey);
  });

  it('issues WeWire a Standard Webhooks secret whose key derivation yields real bytes', async () => {
    const { body } = await register({ url: 'http://localhost:9999/hook', provider: 'wewire' });
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    // The reference libraries base64-decode after the prefix. A raw
    // `sk_test_` key is not valid base64 and would not survive that.
    expect(wewireSigningKey(body.secret!)).toHaveLength(24);
  });

  it("uses the provider's own key for Flutterwave and Kora", async () => {
    const flw = await register({ url: 'http://localhost:9999/f', provider: 'flutterwave' });
    expect(flw.body.secret).toBe(context.flutterwaveKeys.secretKey);
    const kora = await register({ url: 'http://localhost:9999/k', provider: 'kora' });
    expect(kora.body.secret).toBe(context.koraKeys.secretKey);
  });

  it('records the unused placeholder for Wise, which signs with RSA', async () => {
    const { body } = await register({ url: 'http://localhost:9999/hook', provider: 'wise' });
    expect(body.secret).toBe(WISE_UNUSED_SECRET);
  });

  it('keeps a secret the caller supplies', async () => {
    const { body } = await register({
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_mine',
    });
    expect(body.secret).toBe('whsec_mine');
  });

  it('is reproducible under a fixed seed', async () => {
    const first = (await register({ url: 'http://localhost:9999/hook', provider: 'stripe' })).body
      .secret;
    await app.close();
    await context.shutdown();
    await boot();
    const again = (await register({ url: 'http://localhost:9999/hook', provider: 'stripe' })).body
      .secret;
    expect(again).toBe(first);
  });
});

describe('POST /api/webhooks/endpoints with an unknown provider', () => {
  it('is refused rather than creating an endpoint nothing can ever match', async () => {
    const { status, body } = await register({ url: 'http://localhost:9999/hook', provider: 'stripr' });
    expect(status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(body.message).toContain('stripr');
    const listed = (
      await app.inject({ method: 'GET', url: '/api/webhooks/endpoints' })
    ).json() as { endpoints: unknown[] };
    expect(listed.endpoints).toHaveLength(0);
  });
});

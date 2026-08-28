import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * One canonical event, several provider events.
 *
 * Stripe reports a settlement on both `payment_intent.succeeded` and
 * `charge.succeeded`, each carrying its own object. Verified against
 * `stripe/openapi`, read 2026-08-28.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'fanout';
  transport = new RecordingTransport();
  const { config } = loadConfig();
  context = await buildContext({ config, transport, logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  return params.toString();
}

async function endpointFor(eventTypes: string[] = []) {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: {
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_x',
      eventTypes,
    },
  });
}

async function settleIntent(number = '4242424242424242') {
  const res = await app.inject({
    method: 'POST',
    url: '/stripe/v1/payment_intents',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      amount: 2000,
      currency: 'usd',
      confirm: 'true',
      'payment_method_data[card][number]': number,
    }),
  });
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value: '30s' },
  });
  return res.json().id as string;
}

function received() {
  return transport.sent.map((r) => JSON.parse(r.body) as { id: string; type: string; data: { object: Record<string, unknown> } });
}

describe('a settlement fans out', () => {
  it('sends both the intent event and the charge event', async () => {
    await endpointFor();
    await settleIntent();

    const types = received().map((e) => e.type);
    expect(types).toContain('payment_intent.succeeded');
    expect(types).toContain('charge.succeeded');
  });

  it('carries the matching object in each', async () => {
    await endpointFor();
    await settleIntent();

    const intent = received().find((e) => e.type === 'payment_intent.succeeded')!;
    const charge = received().find((e) => e.type === 'charge.succeeded')!;

    expect(intent.data.object.object).toBe('payment_intent');
    expect(intent.data.object.id).toMatch(/^pi_/);
    expect(charge.data.object.object).toBe('charge');
    expect(charge.data.object.id).toMatch(/^ch_/);
  });

  it('gives each event its own id', async () => {
    await endpointFor();
    await settleIntent();

    const events = received().filter((e) =>
      ['payment_intent.succeeded', 'charge.succeeded'].includes(e.type),
    );
    const ids = new Set(events.map((e) => e.id));
    // A subscriber deduplicating on event.id must not drop the second as a
    // repeat of the first.
    expect(ids.size).toBe(events.length);
  });

  it('fans a failure out to both objects too', async () => {
    await endpointFor();
    await settleIntent('4000000000000002');

    const types = received().map((e) => e.type);
    expect(types).toContain('payment_intent.payment_failed');
    expect(types).toContain('charge.failed');
  });
});

describe('endpoint subscriptions are honoured per event type', () => {
  it('delivers only the type an endpoint subscribed to', async () => {
    await endpointFor(['charge.succeeded']);
    await settleIntent();

    const types = received().map((e) => e.type);
    expect(types).toContain('charge.succeeded');
    expect(types).not.toContain('payment_intent.succeeded');
  });

  it('delivers nothing when no endpoint matches either type', async () => {
    await endpointFor(['invoice.paid']);
    await settleIntent();
    expect(transport.sent).toHaveLength(0);
  });
});

describe('providers that emit one event are unchanged', () => {
  it('still sends exactly one webhook for a Paystack charge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/paystack', provider: 'paystack' },
    });

    const charge = await app.inject({
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
    expect(charge.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/api/time',
      payload: { action: 'advance', value: '30s' },
    });

    const events = transport.sent.map((r) => JSON.parse(r.body) as { event: string });
    expect(events.filter((e) => e.event === 'charge.success')).toHaveLength(1);
  });
});

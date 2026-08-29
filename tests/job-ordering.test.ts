import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Due-job ordering under a frozen clock.
 *
 * Regression. `claimDue` ordered by `run_at` alone, and its second select --
 * the one that fetches the leased rows -- had no tiebreak at all. Under the
 * frozen clock every job scheduled in the same instant shares a `run_at`, so
 * the batch came back in SQLite's arbitrary row order and shifted whenever
 * unrelated ids changed.
 *
 * The visible symptom was **webhook delivery order**: a settlement webhook
 * could be delivered before the creation webhook for the same resource, and
 * the order could differ between two runs at the same seed. That breaks the
 * project's core promise, so this pins it.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

async function boot(seed: string) {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-04T12:00:00.000Z';
  process.env.PAYBOX_SEED = seed;
  transport = new RecordingTransport();
  const { config } = loadConfig();
  context = await buildContext({ config, transport, logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
}

beforeEach(async () => {
  await boot('ordering');
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

async function endpoint() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: {
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_x',
      eventTypes: [],
    },
  });
}

async function settleAnIntent() {
  const headers = {
    authorization: 'Bearer sk_test_local_suite',
    'content-type': 'application/x-www-form-urlencoded',
  };
  // Created first, then confirmed, so both a creation and a settlement event
  // fire for the same resource -- which is the pair whose order matters.
  const intent = (
    await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers,
      payload: 'amount=5000&currency=usd',
    })
  ).json();

  await app.inject({
    method: 'POST',
    url: `/stripe/v1/payment_intents/${intent.id}/confirm`,
    headers,
    payload:
      'payment_method_data[type]=card&payment_method_data[card][number]=4242424242424242',
  });
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });
}

const sentTypes = () => transport.sent.map((r) => JSON.parse(r.body).type as string);

describe('webhook delivery order', () => {
  it('follows the order the events happened in', async () => {
    await endpoint();
    await settleAnIntent();

    const types = sentTypes();
    const created = types.indexOf('payment_intent.created');
    const succeeded = types.indexOf('payment_intent.succeeded');

    expect(created).toBeGreaterThanOrEqual(0);
    expect(succeeded).toBeGreaterThanOrEqual(0);
    // A settlement webhook must never arrive before the creation webhook for
    // the same resource.
    expect(created).toBeLessThan(succeeded);
  });

  it('is identical across two runs at the same seed', async () => {
    await endpoint();
    await settleAnIntent();
    const first = sentTypes();

    await app.close();
    await context.shutdown();
    await boot('ordering');
    await endpoint();
    await settleAnIntent();
    const second = sentTypes();

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
  });
});

describe('due jobs', () => {
  it('are claimed in enqueue order when they share an instant', async () => {
    const now = context.clock.nowISO();
    const kinds = ['first', 'second', 'third', 'fourth', 'fifth'];

    for (const kind of kinds) {
      await context.storage.jobs.enqueue({
        id: context.ids.next('job'),
        kind,
        payload: {},
        status: 'ready',
        runAt: now,
        attempt: 0,
        maxAttempts: 1,
        leaseExpiresAt: null,
        lastError: null,
        groupKey: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const claimed = await context.storage.jobs.claimDue(now, now, 10);
    // Every one of these shares a run_at; only the enqueue sequence
    // distinguishes them.
    expect(claimed.map((job) => job.kind)).toEqual(kinds);
  });
});

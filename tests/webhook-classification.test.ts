import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayboxEvent, ProviderId } from '@paybox/shared';
import {
  RecordingTransport,
  WebhookDispatcher,
  createRetryPolicy,
  WEBHOOK_DELIVERY_JOB,
  type AttemptRecord,
  type FormattedWebhook,
  type ResponseClassification,
  type RetryPolicy,
  type SigningContext,
  type TransportResult,
  type WebhookFormatter,
} from '@paybox/webhooks';
import { createHarness, type Harness } from './helpers.js';

/**
 * The opt-in seams Bachs needed in @paybox/webhooks, pinned independently of
 * any adapter:
 *
 *  - `classifyResponse` sees every attempt and may *stop* a delivery, which
 *    is recorded as `failed` and never sent again;
 *  - `SigningContext.secrets` carries rotated-out secrets until they expire;
 *  - `ResendOptions` caps a replay at a single try.
 *
 * And the guarantee that makes them safe to add: a formatter that declares
 * none of them is delivered exactly as before.
 */

const LADDER = [60_000, 300_000, 900_000, 3_600_000];
const ladder: RetryPolicy = {
  enabled: true,
  maxAttempts: 5,
  backoff: (attempt) => LADDER[attempt] ?? LADDER[LADDER.length - 1]!,
};

/** Bachs' published reading of a response. */
function bachsReading(result: TransportResult): ResponseClassification {
  const status = result.status;
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 500 || status === 408 || status === 429) return 'retry';
  return 'stop';
}

class TestFormatter implements WebhookFormatter {
  readonly contexts: SigningContext[] = [];
  readonly retry = ladder;
  readonly resignsPerAttempt = true;
  classifyResponse?: (result: TransportResult) => ResponseClassification;

  constructor(
    readonly provider: ProviderId,
    classify: boolean,
  ) {
    if (classify) this.classifyResponse = bachsReading;
  }

  async format(event: PayboxEvent): Promise<FormattedWebhook | null> {
    if (event.type !== 'payment.successful') return null;
    return { eventType: 'collection.succeeded', body: { id: event.id } };
  }

  sign(_rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    this.contexts.push(context);
    return {
      'x-test-signature': (context.secrets ?? [secret]).join(','),
      'x-test-timestamp': String(context.timestamp),
    };
  }
}

let harness: Harness;
let transport: RecordingTransport;
let dispatcher: WebhookDispatcher;
let classifying: TestFormatter;
let plain: TestFormatter;

async function setup(retryEnabled = true) {
  harness = await createHarness();
  transport = new RecordingTransport();
  dispatcher = new WebhookDispatcher({
    storage: harness.storage,
    clock: harness.clock,
    ids: harness.ids,
    random: harness.random,
    baseUrl: 'http://localhost:8080',
    transport,
    retry: createRetryPolicy({ enabled: retryEnabled }),
  });
  classifying = new TestFormatter('bachs' as ProviderId, true);
  plain = new TestFormatter('paystack', false);
  dispatcher.register(classifying);
  dispatcher.register(plain);
  dispatcher.attachTo(harness.bus);
  harness.scheduler.register(WEBHOOK_DELIVERY_JOB, dispatcher.handleJob);
  for (const provider of ['bachs', 'paystack'] as ProviderId[]) {
    const now = harness.clock.nowISO();
    await harness.storage.webhooks.createEndpoint({
      id: `whe_${provider}`,
      provider,
      url: `http://localhost:9999/${provider}`,
      secret: `secret-${provider}`,
      enabled: true,
      eventTypes: [],
      description: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

afterEach(async () => {
  await harness.close();
});

function respond(status: number | null, error: string | null = null) {
  transport.respondWith(() => ({ status, body: status === null ? null : 'x', durationMs: 1, error }));
}

async function settle(provider: ProviderId, reference = `ref-${provider}`) {
  const payment = await harness.engine.createPayment({
    provider,
    amount: 1000,
    currency: 'NGN',
    reference,
    status: 'pending',
  });
  await harness.engine.transitionPayment(payment.id, 'successful');
  await harness.scheduler.drain();
}

async function onlyDelivery(provider: ProviderId) {
  const page = await harness.storage.webhooks.listDeliveries({ limit: 50, offset: 0 });
  const rows = page.items.filter((d) => d.provider === provider);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function advance(ms: number) {
  harness.clock.advance(ms);
  await harness.scheduler.drain();
}

describe('classifyResponse', () => {
  beforeEach(async () => setup());

  it.each([400, 401, 404, 422, 301, 302])('stops on %i after one attempt, recorded as failed', async (status) => {
    respond(status);
    await settle('bachs' as ProviderId);
    const delivery = await onlyDelivery('bachs' as ProviderId);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt).toBe(1);
    expect(delivery.nextRetryAt).toBeNull();
    expect(delivery.errorMessage).toBe(`Endpoint responded ${status}.`);
    // Nothing is waiting to send it again, however far time moves.
    await advance(24 * 3_600_000);
    expect(transport.sent).toHaveLength(1);
  });

  it.each([
    [408, null],
    [429, null],
    [500, null],
    [503, null],
    [null, 'Request timed out.'],
  ])('retries %s on the 1m/5m/15m/1h ladder, five tries in all', async (status, error) => {
    respond(status, error);
    await settle('bachs' as ProviderId);
    const firstAt = harness.clock.now();
    for (const step of LADDER) await advance(step);
    const delivery = await onlyDelivery('bachs' as ProviderId);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempt).toBe(5);
    expect(transport.sent).toHaveLength(5);
    // Each try re-signed at its own instant: 0, +1m, +6m, +21m, +81m.
    const stamps = transport.sent.map((r) => Number(r.headers['x-test-timestamp']) - firstAt);
    expect(stamps).toEqual([0, 60_000, 360_000, 1_260_000, 4_860_000]);
  });

  it('a retry that later gets a 400 stops there', async () => {
    respond(503);
    await settle('bachs' as ProviderId);
    respond(400);
    await advance(60_000);
    const delivery = await onlyDelivery('bachs' as ProviderId);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt).toBe(2);
    await advance(3_600_000);
    expect(transport.sent).toHaveLength(2);
  });

  it('a failed delivery is never re-sent by a job left in the queue', async () => {
    respond(400);
    await settle('bachs' as ProviderId);
    const delivery = await onlyDelivery('bachs' as ProviderId);
    const again = await dispatcher.deliver(delivery.id);
    expect(again.status).toBe('failed');
    expect(transport.sent).toHaveLength(1);
  });

  it('classifies forced chaos outcomes like real responses', async () => {
    dispatcher.setChaos({ forceOutcome: 'http_400' });
    await settle('bachs' as ProviderId, 'chaos-400');
    dispatcher.setChaos({ forceOutcome: 'http_429' });
    await settle('bachs' as ProviderId, 'chaos-429');
    const page = await harness.storage.webhooks.listDeliveries({ limit: 50, offset: 0 });
    const statuses = page.items
      .filter((d) => d.provider === ('bachs' as ProviderId))
      .map((d) => d.status)
      .sort();
    expect(statuses).toEqual(['failed', 'pending']);
  });

  it('leaves a formatter that does not declare it exactly as before: a 400 is retried', async () => {
    respond(400);
    await settle('paystack');
    for (const step of LADDER) await advance(step);
    const delivery = await onlyDelivery('paystack');
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempt).toBe(5);
  });
});

describe('classifyResponse with retries switched off', () => {
  beforeEach(async () => setup(false));

  it('still records a refusal as failed', async () => {
    respond(400);
    await settle('bachs' as ProviderId);
    expect((await onlyDelivery('bachs' as ProviderId)).status).toBe('failed');
  });

  it('records a retryable failure as exhausted after the single try', async () => {
    respond(503);
    await settle('bachs' as ProviderId);
    const delivery = await onlyDelivery('bachs' as ProviderId);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempt).toBe(1);
  });
});

describe('SigningContext.secrets', () => {
  beforeEach(async () => setup());

  it('carries a rotated-out secret until it expires, current one first', async () => {
    const expiresAt = new Date(harness.clock.now() + 3_600_000).toISOString();
    await harness.storage.webhooks.updateEndpoint('whe_bachs', {
      secret: 'secret-new',
      previousSecrets: [{ secret: 'secret-bachs', expiresAt }],
    });
    respond(503);
    await settle('bachs' as ProviderId);
    // Within the hour both sign; the 1h retry lands after expiry.
    for (const step of LADDER) await advance(step);
    const signed = transport.sent.map((r) => r.headers['x-test-signature']);
    expect(signed.slice(0, 4)).toEqual(Array(4).fill('secret-new,secret-bachs'));
    expect(signed[4]).toBe('secret-new');
  });

  it('round-trips previousSecrets through storage', async () => {
    const entry = { secret: 'old', expiresAt: '2030-01-01T00:00:00.000Z' };
    await harness.storage.webhooks.updateEndpoint('whe_bachs', { previousSecrets: [entry] });
    const endpoint = await harness.storage.webhooks.endpointById('whe_bachs');
    expect(endpoint?.previousSecrets).toEqual([entry]);
    const fresh = await harness.storage.webhooks.endpointById('whe_paystack');
    expect(fresh?.previousSecrets).toEqual([]);
  });
});

describe('ResendOptions', () => {
  beforeEach(async () => setup());

  it('replay with maxAttempts 1 makes a single try', async () => {
    respond(503);
    await settle('bachs' as ProviderId);
    const original = await onlyDelivery('bachs' as ProviderId);
    const replay = await dispatcher.replay(original.id, { maxAttempts: 1 });
    expect(replay.maxAttempts).toBe(1);
    await harness.scheduler.drain();
    const after = await harness.storage.webhooks.deliveryById(replay.id);
    expect(after?.status).toBe('exhausted');
    expect(after?.attempt).toBe(1);
  });

  it('replay without options keeps the full ladder, as paybox tooling always has', async () => {
    respond(200);
    await settle('bachs' as ProviderId);
    const original = await onlyDelivery('bachs' as ProviderId);
    const replay = await dispatcher.replay(original.id);
    expect(replay.maxAttempts).toBe(5);
  });

  it('replayEvent narrows to the named endpoints and caps the attempts', async () => {
    const now = harness.clock.nowISO();
    await harness.storage.webhooks.createEndpoint({
      id: 'whe_bachs_two',
      provider: 'bachs' as ProviderId,
      url: 'http://localhost:9999/two',
      secret: 'two',
      enabled: true,
      eventTypes: [],
      description: null,
      createdAt: now,
      updatedAt: now,
    });
    await settle('bachs' as ProviderId);
    const events = await harness.storage.events.list({ limit: 50, offset: 0 });
    const event = events.items.find((e) => e.type === 'payment.successful')!;
    const resent = await dispatcher.replayEvent(event.id, {
      endpointIds: ['whe_bachs_two'],
      maxAttempts: 1,
    });
    expect(resent.map((d) => [d.endpointId, d.maxAttempts])).toEqual([['whe_bachs_two', 1]]);
  });
});

/* ------------------------------------------------------------------ *
 * followsEndpointChanges, afterAttempt, ResendOptions.eventTypes
 * ------------------------------------------------------------------ */

const BACHS_ID = 'bachs' as ProviderId;

/**
 * Bachs' reading of an endpoint that changes under a queued retry:
 * "Events already queued for the old URL are retried against the new one",
 * and while an endpoint is off "Retries that were already waiting stop"
 * (docs.bachs.io/guides/webhooks/overview, read 2026-10-10).
 */
class FollowingFormatter extends TestFormatter {
  readonly followsEndpointChanges = true;
  readonly seen: AttemptRecord[] = [];
  throwInHook = false;

  constructor() {
    super(BACHS_ID, true);
  }

  async afterAttempt(attempt: AttemptRecord): Promise<void> {
    this.seen.push(attempt);
    if (this.throwInHook) throw new Error('bookkeeping exploded');
  }
}

describe('followsEndpointChanges', () => {
  let following: FollowingFormatter;

  beforeEach(async () => {
    await setup();
    following = new FollowingFormatter();
    dispatcher.register(following);
  });

  it('stops a queued retry without sending once the endpoint is disabled', async () => {
    respond(503);
    await settle(BACHS_ID);
    expect(transport.sent).toHaveLength(1);
    await harness.storage.webhooks.updateEndpoint('whe_bachs', { enabled: false });
    await advance(2 * 3_600_000);
    expect(transport.sent).toHaveLength(1);
    const delivery = await onlyDelivery(BACHS_ID);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt).toBe(1);
    expect(delivery.nextRetryAt).toBeNull();
    expect(delivery.errorMessage).toMatch(/disabled/);
  });

  it('stops a queued retry without sending once the endpoint is deleted', async () => {
    respond(503);
    await settle(BACHS_ID);
    await harness.storage.webhooks.deleteEndpoint('whe_bachs');
    await advance(2 * 3_600_000);
    expect(transport.sent).toHaveLength(1);
    // Deleting an endpoint cascades to its delivery rows in storage; whatever
    // remains must be final, never pending.
    const page = await harness.storage.webhooks.listDeliveries({ limit: 50, offset: 0 });
    for (const row of page.items.filter((d) => d.provider === BACHS_ID)) {
      expect(row.status).toBe('failed');
    }
  });

  it('sends a queued retry to the endpoint URL as it is now', async () => {
    respond(503);
    await settle(BACHS_ID);
    await harness.storage.webhooks.updateEndpoint('whe_bachs', { url: 'http://localhost:9999/moved' });
    respond(200);
    await advance(60_000);
    expect(transport.sent.map((r) => r.url)).toEqual([
      'http://localhost:9999/bachs',
      'http://localhost:9999/moved',
    ]);
    expect((await onlyDelivery(BACHS_ID)).status).toBe('succeeded');
  });

  it('does not call afterAttempt for a delivery stopped without sending', async () => {
    respond(503);
    await settle(BACHS_ID);
    await harness.storage.webhooks.updateEndpoint('whe_bachs', { enabled: false });
    await advance(2 * 3_600_000);
    expect(following.seen.map((a) => a.attemptNo)).toEqual([1]);
  });
});

describe('afterAttempt', () => {
  let following: FollowingFormatter;

  beforeEach(async () => {
    await setup();
    following = new FollowingFormatter();
    dispatcher.register(following);
  });

  it('is called once per attempt with its number, classification and URL', async () => {
    respond(503);
    await settle(BACHS_ID);
    await advance(60_000);
    respond(200);
    await advance(300_000);
    const seen = following.seen.map((a) => ({
      attemptNo: a.attemptNo,
      classification: a.classification,
      url: a.url,
      status: a.result.status,
      deliveryStatus: a.delivery.status,
      deliveryAttempt: a.delivery.attempt,
    }));
    expect(seen).toEqual([
      { attemptNo: 1, classification: 'retry', url: 'http://localhost:9999/bachs', status: 503, deliveryStatus: 'pending', deliveryAttempt: 1 },
      { attemptNo: 2, classification: 'retry', url: 'http://localhost:9999/bachs', status: 503, deliveryStatus: 'pending', deliveryAttempt: 2 },
      { attemptNo: 3, classification: 'delivered', url: 'http://localhost:9999/bachs', status: 200, deliveryStatus: 'succeeded', deliveryAttempt: 3 },
    ]);
    // Each attempt is stamped at its own virtual instant.
    const start = Date.parse(following.seen[0]!.at);
    expect(following.seen.map((a) => Date.parse(a.at) - start)).toEqual([0, 60_000, 360_000]);
  });

  it('reports a refusal as stop', async () => {
    respond(401);
    await settle(BACHS_ID);
    expect(following.seen.map((a) => [a.attemptNo, a.classification, a.delivery.status])).toEqual([
      [1, 'stop', 'failed'],
    ]);
  });

  it('a throwing hook neither breaks the attempt nor the retry ladder', async () => {
    following.throwInHook = true;
    respond(503);
    await settle(BACHS_ID);
    for (const step of LADDER) await advance(step);
    expect(transport.sent).toHaveLength(5);
    expect(following.seen).toHaveLength(5);
    const delivery = await onlyDelivery(BACHS_ID);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempt).toBe(5);
  });
});

/** One canonical event that is two provider events, like Bachs' paid checkout. */
class FanOutFormatter implements WebhookFormatter {
  readonly provider = BACHS_ID;
  readonly retry = ladder;
  readonly classifyResponse = bachsReading;

  sign(_rawBody: string, secret: string): Record<string, string> {
    return { 'x-test-signature': secret };
  }

  async format(event: PayboxEvent): Promise<FormattedWebhook[] | null> {
    if (event.type !== 'payment.successful') return null;
    return [
      { eventType: 'collection.succeeded', body: { id: `${event.id}:collection` } },
      { eventType: 'checkout.completed', body: { id: `${event.id}:checkout` } },
    ];
  }
}

describe('ResendOptions.eventTypes', () => {
  beforeEach(async () => {
    await setup();
    dispatcher.register(new FanOutFormatter());
  });

  it('narrows replayEvent to the named provider event types', async () => {
    respond(200);
    await settle(BACHS_ID);
    expect(transport.sent).toHaveLength(2);
    const events = await harness.storage.events.list({ limit: 50, offset: 0 });
    const event = events.items.find((e) => e.provider === BACHS_ID && e.type === 'payment.successful')!;

    const resent = await dispatcher.replayEvent(event.id, { eventTypes: ['checkout.completed'] });
    expect(resent.map((d) => d.eventType)).toEqual(['checkout.completed']);
    await harness.scheduler.drain();
    expect(transport.sent.map((r) => JSON.parse(r.body).id)).toEqual([
      `${event.id}:collection`,
      `${event.id}:checkout`,
      `${event.id}:checkout`,
    ]);

    const all = await dispatcher.replayEvent(event.id);
    expect(all.map((d) => d.eventType)).toEqual(['collection.succeeded', 'checkout.completed']);
  });
});

describe('a formatter without the new flags keeps today\'s behaviour', () => {
  beforeEach(async () => setup());

  it('sends a queued retry to the URL the delivery was created with, even after the endpoint moves', async () => {
    respond(503);
    await settle('paystack');
    await harness.storage.webhooks.updateEndpoint('whe_paystack', { url: 'http://localhost:9999/moved' });
    await advance(LADDER[0]!);
    expect(transport.sent.map((r) => r.url)).toEqual([
      'http://localhost:9999/paystack',
      'http://localhost:9999/paystack',
    ]);
  });

  it('still sends a queued retry to an endpoint that was disabled', async () => {
    respond(503);
    await settle('paystack');
    await harness.storage.webhooks.updateEndpoint('whe_paystack', { enabled: false });
    for (const step of LADDER) await advance(step);
    expect(transport.sent).toHaveLength(5);
    expect((await onlyDelivery('paystack')).status).toBe('exhausted');
  });
});

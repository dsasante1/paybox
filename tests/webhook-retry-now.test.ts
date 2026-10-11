import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayboxEvent } from '@paybox/shared';
import {
  RecordingTransport,
  WebhookDispatcher,
  WEBHOOK_DELIVERY_JOB,
  type FormattedWebhook,
  type RetryPolicy,
  type WebhookFormatter,
} from '@paybox/webhooks';
import { createHarness, type Harness } from './helpers.js';

/**
 * `retryNow` -- paybox's "try that delivery again" (control API
 * `POST /api/webhooks/deliveries/:id/retry`, the dashboard's Retry button).
 *
 * It re-opens a finished delivery and grants it one more attempt by raising
 * `maxAttempts`. That grant has to reach storage: the delivery log is what
 * the dashboard and `paybox webhook list` show, and a row reading "attempt 3
 * of 2" is a log that contradicts itself.
 */
const twoTries: RetryPolicy = { enabled: true, maxAttempts: 2, backoff: () => 1_000 };

class Formatter implements WebhookFormatter {
  readonly provider = 'paystack' as const;
  readonly retry = twoTries;
  async format(event: PayboxEvent): Promise<FormattedWebhook | null> {
    return event.type === 'payment.successful' ? { eventType: 'charge.success', body: { id: event.id } } : null;
  }
  sign(): Record<string, string> {
    return {};
  }
}

let harness: Harness;
let transport: RecordingTransport;
let dispatcher: WebhookDispatcher;

beforeEach(async () => {
  harness = await createHarness();
  transport = new RecordingTransport(() => ({ status: 500, body: 'down', durationMs: 1, error: null }));
  dispatcher = new WebhookDispatcher({
    storage: harness.storage,
    clock: harness.clock,
    ids: harness.ids,
    random: harness.random,
    baseUrl: 'http://localhost:8080',
    transport,
  });
  dispatcher.register(new Formatter());
  dispatcher.attachTo(harness.bus);
  harness.scheduler.register(WEBHOOK_DELIVERY_JOB, dispatcher.handleJob);
  const now = harness.clock.nowISO();
  await harness.storage.webhooks.createEndpoint({
    id: 'whe_retry',
    provider: 'paystack',
    url: 'http://localhost:9999/hook',
    secret: 's',
    enabled: true,
    eventTypes: [],
    description: null,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(async () => {
  await harness.close();
});

async function exhaustedDelivery() {
  const payment = await harness.engine.createPayment({
    provider: 'paystack',
    amount: 1000,
    currency: 'NGN',
    reference: 'retry-now',
    status: 'pending',
  });
  await harness.engine.transitionPayment(payment.id, 'successful');
  await harness.scheduler.drain();
  harness.clock.advance(1_000);
  await harness.scheduler.drain();
  const { items } = await harness.storage.webhooks.listDeliveries({ limit: 10, offset: 0 });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ status: 'exhausted', attempt: 2, maxAttempts: 2 });
  return items[0]!;
}

describe('retryNow', () => {
  it('sends one more attempt and stores the attempt it granted', async () => {
    const delivery = await exhaustedDelivery();
    const sentBefore = transport.sent.length;

    const after = await dispatcher.retryNow(delivery.id);

    expect(transport.sent.length).toBe(sentBefore + 1);
    expect(after).toMatchObject({ status: 'exhausted', attempt: 3, maxAttempts: 3 });
    // Read back: the row, not the in-memory return value, is what the
    // dashboard and the CLI show.
    const stored = await harness.storage.webhooks.deliveryById(delivery.id);
    expect(stored).toMatchObject({ attempt: 3, maxAttempts: 3 });
  });

  it('a second manual retry grants another, and never reads as more attempts than allowed', async () => {
    const delivery = await exhaustedDelivery();
    await dispatcher.retryNow(delivery.id);
    const second = await dispatcher.retryNow(delivery.id);
    expect(second).toMatchObject({ attempt: 4, maxAttempts: 4 });
    expect(second.attempt).toBeLessThanOrEqual(second.maxAttempts);
  });

  it('delivers when the endpoint has recovered', async () => {
    const delivery = await exhaustedDelivery();
    transport.respondWith(() => ({ status: 200, body: 'ok', durationMs: 1, error: null }));
    const after = await dispatcher.retryNow(delivery.id);
    expect(after).toMatchObject({ status: 'succeeded', attempt: 3, maxAttempts: 3 });
  });
});

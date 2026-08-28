import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PayboxEvent, ProviderId } from '@paybox/shared';
import {
  RecordingTransport,
  WebhookDispatcher,
  createRetryPolicy,
  WEBHOOK_DELIVERY_JOB,
  type FormattedWebhook,
  type SigningContext,
  type WebhookFormatter,
} from '@paybox/webhooks';
import { verifyPaystackSignature } from '@paybox/paystack';
import { createHarness, type Harness } from './helpers.js';

/**
 * The webhook-signing contract, exercised by a formatter whose signature
 * covers a timestamp.
 *
 * Stripe signs `${timestamp}.${payload}` and regenerates both on every
 * delivery attempt -- "If Stripe retries an event... we generate a new
 * signature and timestamp for the new delivery attempt"
 * (docs.stripe.com/webhooks, read 2026-08-28). These tests pin the two things
 * that has to be true of the dispatcher for that to work, without depending on
 * the Stripe adapter existing yet.
 */

/** A minimal formatter that signs over the attempt's timestamp. */
class TimestampedFormatter implements WebhookFormatter {
  readonly provider: ProviderId = 'stripe';
  readonly resignsPerAttempt = true;
  /** Every signing context this formatter was handed, in order. */
  readonly contexts: SigningContext[] = [];

  async format(event: PayboxEvent): Promise<FormattedWebhook | null> {
    if (!event.type.startsWith('payment.')) return null;
    return { eventType: event.type, body: { id: event.id, type: event.type } };
  }

  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    this.contexts.push(context);
    const seconds = Math.floor(context.timestamp / 1000);
    const signature = createHmac('sha256', secret)
      .update(`${seconds}.${rawBody}`)
      .digest('hex');
    return { 'test-signature': `t=${seconds},v1=${signature}` };
  }
}

/** A body-only formatter, like Paystack's. */
class BodyOnlyFormatter implements WebhookFormatter {
  readonly provider: ProviderId = 'paystack';
  async format(event: PayboxEvent): Promise<FormattedWebhook | null> {
    if (!event.type.startsWith('payment.')) return null;
    return { eventType: event.type, body: { id: event.id } };
  }
  sign(rawBody: string, secret: string): Record<string, string> {
    return {
      'test-signature': createHmac('sha512', secret).update(rawBody).digest('hex'),
    };
  }
}

let harness: Harness;
let transport: RecordingTransport;

beforeEach(async () => {
  harness = await createHarness();
  transport = new RecordingTransport();
});

afterEach(async () => {
  await harness.close();
});

function dispatcherFor(formatter: WebhookFormatter, maxAttempts = 3) {
  const dispatcher = new WebhookDispatcher({
    storage: harness.storage,
    clock: harness.clock,
    ids: harness.ids,
    random: harness.random,
    baseUrl: 'http://localhost:8080',
    transport,
    retry: createRetryPolicy({ enabled: true, maxAttempts, backoff: () => 60_000 }),
    timeoutMs: 1_000,
  });
  dispatcher.register(formatter);
  dispatcher.attachTo(harness.bus);
  // The harness scheduler has no handlers of its own; deliveries are jobs.
  harness.scheduler.register(WEBHOOK_DELIVERY_JOB, dispatcher.handleJob);
  return dispatcher;
}

/** Fail the first `count` attempts, then succeed. */
function failFirst(count: number): void {
  let seen = 0;
  transport.respondWith(() => {
    seen += 1;
    return seen <= count
      ? { status: 500, body: 'nope', durationMs: 1, error: null }
      : { status: 200, body: '{"ok":true}', durationMs: 1, error: null };
  });
}

async function endpoint(provider: ProviderId) {
  const now = harness.clock.nowISO();
  return harness.storage.webhooks.createEndpoint({
    id: harness.ids.next('whe'),
    provider,
    url: 'http://localhost:9999/hook',
    secret: 'whsec_test',
    enabled: true,
    eventTypes: [],
    description: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function settledPayment(provider: ProviderId) {
  const payment = await harness.engine.createPayment({
    provider,
    amount: 10_000,
    currency: 'NGN',
    reference: `sig-${provider}`,
    status: 'pending',
  });
  return harness.engine.transitionPayment(payment.id, 'successful');
}

describe('the signing context', () => {
  it('carries virtual time, not the wall clock', async () => {
    const formatter = new TimestampedFormatter();
    dispatcherFor(formatter);
    await endpoint('stripe');
    await settledPayment('stripe');
    await harness.scheduler.drain();

    expect(formatter.contexts.length).toBeGreaterThan(0);
    // The harness clock is frozen at a fixed instant well in the past.
    expect(formatter.contexts[0]!.timestamp).toBe(harness.clock.now());
    expect(formatter.contexts[0]!.timestamp).toBeLessThan(Date.now());
  });

  it('reports the attempt number', async () => {
    const formatter = new TimestampedFormatter();
    dispatcherFor(formatter);
    await endpoint('stripe');
    failFirst(1);
    await settledPayment('stripe');
    await harness.scheduler.drain();
    await harness.clock.advance(120_000);
    await harness.scheduler.drain();

    const attempts = formatter.contexts.map((c) => c.attempt);
    expect(attempts).toContain(0);
    expect(Math.max(...attempts)).toBeGreaterThan(0);
  });
});

describe('re-signing per attempt', () => {
  it('gives a retry a fresh timestamp and signature', async () => {
    const formatter = new TimestampedFormatter();
    dispatcherFor(formatter);
    await endpoint('stripe');
    failFirst(1);

    await settledPayment('stripe');
    await harness.scheduler.drain();
    // Move virtual time well past any tolerance window before the retry.
    await harness.clock.advance(10 * 60_000);
    await harness.scheduler.drain();

    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    const first = transport.sent[0]!.headers['test-signature'];
    const retry = transport.sent.at(-1)!.headers['test-signature'];

    // Replaying the original would fail a receiver's recency check.
    expect(retry).not.toBe(first);
    expect(first?.split(',')[0]).not.toBe(retry?.split(',')[0]);
    // Same bytes, though: only the signature moved.
    expect(transport.sent.at(-1)!.body).toBe(transport.sent[0]!.body);
  });

  it('signs the timestamp it actually sent', async () => {
    const formatter = new TimestampedFormatter();
    dispatcherFor(formatter);
    await endpoint('stripe');
    await settledPayment('stripe');
    await harness.scheduler.drain();

    const sent = transport.sent[0]!;
    const header = sent.headers['test-signature']!;
    const [tPart, vPart] = header.split(',');
    const seconds = tPart!.replace('t=', '');
    const expected = createHmac('sha256', 'whsec_test')
      .update(`${seconds}.${sent.body}`)
      .digest('hex');

    expect(vPart).toBe(`v1=${expected}`);
  });

  it('leaves a body-only signature identical across attempts', async () => {
    // The default. Replaying stored headers is what keeps a Paystack retry
    // byte-identical, and that must not change.
    dispatcherFor(new BodyOnlyFormatter());
    await endpoint('paystack');
    failFirst(1);

    await settledPayment('paystack');
    await harness.scheduler.drain();
    await harness.clock.advance(10 * 60_000);
    await harness.scheduler.drain();

    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    expect(transport.sent.at(-1)!.headers['test-signature']).toBe(
      transport.sent[0]!.headers['test-signature'],
    );
  });
});

describe('the real Paystack formatter is unaffected', () => {
  it('still produces a verifiable body-only signature', async () => {
    const { PaystackWebhookFormatter } = await import('@paybox/paystack');
    dispatcherFor(new PaystackWebhookFormatter());
    await endpoint('paystack');
    await settledPayment('paystack');
    await harness.scheduler.drain();

    const sent = transport.sent[0]!;
    const signature = sent.headers['x-paystack-signature']!;
    expect(verifyPaystackSignature(sent.body, 'whsec_test', signature)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createHarness, type Harness } from './helpers.js';

/**
 * One provider, two wire formats.
 *
 * A formatter may build different envelopes for different resources -- a
 * Flutterwave v4 charge and a v3 charge share a provider id -- and each
 * needs the signature that matches. `format()` names the format it built
 * (`variant`); the dispatcher hands that back to `sign()`. These tests pin
 * the seam itself, independently of any adapter.
 */
class TwoFormatFormatter implements WebhookFormatter {
  readonly provider: ProviderId = 'flutterwave';
  readonly contexts: SigningContext[] = [];

  async format(event: PayboxEvent): Promise<FormattedWebhook | null> {
    if (!event.type.startsWith('payment.')) return null;
    // Odd amounts are "v4", so one run exercises both paths.
    const v4 = Number(event.data.amount) % 2 === 1;
    return v4
      ? { eventType: 'charge.completed', body: { type: 'charge.completed', id: event.id }, variant: 'v4' }
      : { eventType: 'charge.completed', body: { event: 'charge.completed', id: event.id } };
  }

  sign(_rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    this.contexts.push(context);
    return context.variant === 'v4'
      ? { 'new-signature': `signed:${secret}` }
      : { 'old-signature': secret };
  }
}

let harness: Harness;
let transport: RecordingTransport;
let formatter: TwoFormatFormatter;

beforeEach(async () => {
  harness = await createHarness();
  transport = new RecordingTransport();
  formatter = new TwoFormatFormatter();
  const dispatcher = new WebhookDispatcher({
    storage: harness.storage,
    clock: harness.clock,
    ids: harness.ids,
    random: harness.random,
    baseUrl: 'http://localhost:8080',
    transport,
    retry: createRetryPolicy({ enabled: false }),
  });
  dispatcher.register(formatter);
  dispatcher.attachTo(harness.bus);
  harness.scheduler.register(WEBHOOK_DELIVERY_JOB, dispatcher.handleJob);

  const now = harness.clock.nowISO();
  await harness.storage.webhooks.createEndpoint({
    id: harness.ids.next('whe'),
    provider: 'flutterwave',
    url: 'http://localhost:9999/hook',
    secret: 'hash',
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

async function settle(amount: number) {
  const payment = await harness.engine.createPayment({
    provider: 'flutterwave',
    amount,
    currency: 'NGN',
    reference: `variant-${amount}`,
    status: 'pending',
  });
  await harness.engine.transitionPayment(payment.id, 'successful');
  await harness.scheduler.drain();
}

describe('FormattedWebhook.variant', () => {
  it('reaches sign() as SigningContext.variant', async () => {
    await settle(1001);
    expect(formatter.contexts.map((c) => c.variant)).toContain('v4');
    const sent = transport.sent.find((r) => JSON.parse(r.body).type === 'charge.completed');
    expect(sent?.headers['new-signature']).toBe('signed:hash');
    expect(sent?.headers['old-signature']).toBeUndefined();
  });

  it('is absent when the formatter returned none', async () => {
    await settle(1000);
    const bodyOnly = formatter.contexts.filter((c) => c.variant === undefined);
    expect(bodyOnly.length).toBeGreaterThan(0);
    const sent = transport.sent.find((r) => JSON.parse(r.body).event === 'charge.completed');
    expect(sent?.headers['old-signature']).toBe('hash');
    expect(sent?.headers['new-signature']).toBeUndefined();
  });

  it('lets one endpoint carry both formats, each signed its own way', async () => {
    await settle(2000);
    await settle(2001);
    const headers = transport.sent.map((r) => Object.keys(r.headers).sort().join(','));
    expect(headers.some((h) => h.includes('old-signature') && !h.includes('new-signature'))).toBe(true);
    expect(headers.some((h) => h.includes('new-signature') && !h.includes('old-signature'))).toBe(true);
  });
});

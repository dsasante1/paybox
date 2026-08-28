import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPaymentTransition } from '@paybox/core';
import { PayboxError } from '@paybox/shared';
import { createHarness, type Harness } from './helpers.js';

/**
 * Retrying a failed payment on the same resource.
 *
 * Stripe's PaymentIntent has no terminal failure: a decline returns it to
 * `requires_payment_method` "so that the payment can be retried"
 * (docs.stripe.com/payments/paymentintents/lifecycle, read 2026-08-28).
 * Paystack has no equivalent, so this is opt-in per adapter and `failed` stays
 * terminal for everyone who does not ask.
 */
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

async function failedPayment() {
  const payment = await harness.engine.createPayment({
    provider: 'stripe',
    amount: 50_000,
    currency: 'USD',
    reference: `retry-${harness.ids.token(6)}`,
    status: 'pending',
  });
  await harness.engine.transitionPayment(payment.id, 'processing');
  return harness.engine.transitionPayment(payment.id, 'failed', {
    failureCode: 'card_declined',
    failureMessage: 'Your card was declined.',
  });
}

describe('the state machine', () => {
  it('permits failed -> the in-flight states only with the flag', () => {
    for (const to of ['pending', 'processing', 'requires_action'] as const) {
      expect(() => assertPaymentTransition('failed', to, { retry: true })).not.toThrow();
      expect(() => assertPaymentTransition('failed', to)).toThrow(PayboxError);
    }
  });

  it('does not let a retry skip straight to successful', () => {
    // Claiming a failed payment succeeded is a *reversal*, a different claim
    // with its own flag. A retry only resumes the attempt.
    expect(() => assertPaymentTransition('failed', 'successful', { retry: true })).toThrow(
      /Cannot move a payment from failed to successful/,
    );
    expect(() =>
      assertPaymentTransition('failed', 'successful', { reversal: true }),
    ).not.toThrow();
  });

  it('does not make other terminal states retryable', () => {
    for (const from of ['cancelled', 'expired', 'refunded'] as const) {
      expect(() => assertPaymentTransition(from, 'processing', { retry: true })).toThrow(
        PayboxError,
      );
    }
  });

  it('mentions the retry escape hatch when refusing a failed transition', () => {
    expect(() => assertPaymentTransition('failed', 'processing')).toThrow(/or a retry/);
    // Only for `failed` -- the other terminal states have no retry path.
    expect(() => assertPaymentTransition('cancelled', 'processing')).toThrow(
      /reversal simulation to override\./,
    );
  });
});

describe('through the engine', () => {
  it('resumes a failed payment and can then settle it', async () => {
    const failed = await failedPayment();
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('card_declined');

    const resumed = await harness.engine.transitionPayment(failed.id, 'processing', {
      retry: true,
    });
    expect(resumed.status).toBe('processing');

    const settled = await harness.engine.transitionPayment(failed.id, 'successful');
    expect(settled.status).toBe('successful');
    // The stale decline must not survive onto a payment that then succeeded.
    expect(settled.failureCode).toBeNull();
  });

  it('refuses without the flag, so Paystack semantics are unchanged', async () => {
    const failed = await failedPayment();
    await expect(
      harness.engine.transitionPayment(failed.id, 'processing'),
    ).rejects.toThrow(/Cannot move a payment from failed to processing/);
  });

  it('records every attempt in the timeline', async () => {
    const failed = await failedPayment();
    await harness.engine.transitionPayment(failed.id, 'processing', { retry: true });
    await harness.engine.transitionPayment(failed.id, 'failed', {
      failureCode: 'insufficient_funds',
      failureMessage: 'Insufficient funds.',
    });
    await harness.engine.transitionPayment(failed.id, 'processing', { retry: true });
    await harness.engine.transitionPayment(failed.id, 'successful');

    const timeline = await harness.engine.getTimeline(failed.id);
    const types = timeline.map((e) => e.type);
    // Two failures and a success on one payment: the attempt history is the
    // event log, which is what makes a retryable payment auditable.
    expect(types.filter((t) => t === 'payment.failed')).toHaveLength(2);
    expect(types.filter((t) => t === 'payment.successful')).toHaveLength(1);
    expect(timeline.map((e) => e.sequence)).toEqual(timeline.map((_, i) => i + 1));
  });

  it('credits the balance once, on the attempt that actually succeeded', async () => {
    const failed = await failedPayment();
    await harness.engine.transitionPayment(failed.id, 'processing', { retry: true });
    await harness.engine.transitionPayment(failed.id, 'successful');

    const entries = await harness.storage.ledger.list({ provider: 'stripe' });
    const credits = entries.items.filter((e) => e.direction === 'credit');
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amount).toBe(50_000);
  });
});

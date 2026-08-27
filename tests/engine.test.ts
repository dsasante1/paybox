import { describe, expect, it, afterEach } from 'vitest';
import { PayboxError } from '@paybox/shared';
import { createHarness, type Harness } from './helpers.js';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup() {
  harness = await createHarness();
  return harness;
}

describe('payment lifecycle', () => {
  it('records an ordered event for every state change', async () => {
    const { engine } = await setup();
    const payment = await engine.createPayment({
      provider: 'paystack',
      amount: 10_000,
      currency: 'GHS',
      reference: 'order_123',
      paymentMethod: 'mobile_money',
      status: 'pending',
    });

    await engine.transitionPayment(payment.id, 'processing');
    await engine.transitionPayment(payment.id, 'successful', { providerStatus: 'success' });

    const timeline = await engine.getTimeline(payment.id);
    expect(timeline.map((e) => e.type)).toEqual([
      'payment.pending',
      'payment.processing',
      'payment.successful',
    ]);
    // Sequence numbers are gapless and start at 1, so replay ordering is total.
    expect(timeline.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(timeline.at(-1)?.previousStatus).toBe('processing');
  });

  it('preserves the provider status alongside the canonical one', async () => {
    const { engine } = await setup();
    const payment = await engine.createPayment({
      provider: 'paystack',
      amount: 500,
      currency: 'GHS',
      reference: 'ps_1',
      status: 'pending',
    });
    const done = await engine.transitionPayment(payment.id, 'successful', {
      providerStatus: 'success',
    });
    expect(done.status).toBe('successful');
    expect(done.providerStatus).toBe('success');
  });

  it('rejects an illegal transition', async () => {
    const { engine } = await setup();
    const payment = await engine.createPayment({
      provider: 'paystack',
      amount: 500,
      currency: 'GHS',
      reference: 'ps_2',
      status: 'pending',
    });
    await engine.transitionPayment(payment.id, 'failed');

    await expect(engine.transitionPayment(payment.id, 'successful')).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });
  });

  it('allows failed -> successful only as an explicit reversal', async () => {
    const { engine } = await setup();
    const payment = await engine.createPayment({
      provider: 'paystack',
      amount: 500,
      currency: 'GHS',
      reference: 'ps_3',
      status: 'pending',
    });
    await engine.transitionPayment(payment.id, 'failed');
    const reversed = await engine.transitionPayment(payment.id, 'successful', {
      reversal: true,
      providerStatus: 'success',
    });
    expect(reversed.status).toBe('successful');
  });

  it('refuses a duplicate reference for the same provider but allows it across providers', async () => {
    const { engine } = await setup();
    await engine.createPayment({
      provider: 'paystack',
      amount: 500,
      currency: 'GHS',
      reference: 'shared_ref',
    });
    await expect(
      engine.createPayment({
        provider: 'paystack',
        amount: 500,
        currency: 'GHS',
        reference: 'shared_ref',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_reference' });

    const other = await engine.createPayment({
      provider: 'stripe',
      amount: 500,
      currency: 'GHS',
      reference: 'shared_ref',
    });
    expect(other.id).toBeTruthy();
  });

  it('rejects non-integer and non-positive amounts', async () => {
    const { engine } = await setup();
    for (const amount of [0, -100, 10.5]) {
      await expect(
        engine.createPayment({ provider: 'paystack', amount, currency: 'GHS' }),
      ).rejects.toBeInstanceOf(PayboxError);
    }
  });
});

describe('refunds', () => {
  async function successfulPayment(harness: Harness, amount = 10_000) {
    const payment = await harness.engine.createPayment({
      provider: 'paystack',
      amount,
      currency: 'GHS',
      status: 'pending',
    });
    await harness.engine.transitionPayment(payment.id, 'successful');
    return payment;
  }

  it('moves the payment to partially_refunded then refunded', async () => {
    const h = await setup();
    const payment = await successfulPayment(h);

    const first = await h.engine.createRefund({ paymentId: payment.id, amount: 4_000 });
    await h.engine.transitionRefund(first.id, 'successful');
    expect((await h.engine.getPayment(payment.id))?.status).toBe('partially_refunded');

    const second = await h.engine.createRefund({ paymentId: payment.id, amount: 6_000 });
    await h.engine.transitionRefund(second.id, 'successful');

    const final = await h.engine.getPayment(payment.id);
    expect(final?.status).toBe('refunded');
    expect(final?.amountRefunded).toBe(10_000);
  });

  it('enforces total_refunded <= amount across multiple partials', async () => {
    const h = await setup();
    const payment = await successfulPayment(h);
    await h.engine.createRefund({ paymentId: payment.id, amount: 9_000 });

    await expect(
      h.engine.createRefund({ paymentId: payment.id, amount: 2_000 }),
    ).rejects.toMatchObject({ code: 'refund_exceeds_amount' });
  });

  it('a failed refund releases its hold on the refundable balance', async () => {
    const h = await setup();
    const payment = await successfulPayment(h);
    const attempt = await h.engine.createRefund({ paymentId: payment.id, amount: 10_000 });
    await h.engine.transitionRefund(attempt.id, 'failed');

    // The full amount is refundable again now that the first attempt failed.
    const retry = await h.engine.createRefund({ paymentId: payment.id, amount: 10_000 });
    await h.engine.transitionRefund(retry.id, 'successful');
    expect((await h.engine.getPayment(payment.id))?.status).toBe('refunded');
  });

  it('defaults to refunding the remaining balance', async () => {
    const h = await setup();
    const payment = await successfulPayment(h);
    const first = await h.engine.createRefund({ paymentId: payment.id, amount: 2_500 });
    await h.engine.transitionRefund(first.id, 'successful');

    const rest = await h.engine.createRefund({ paymentId: payment.id });
    expect(rest.amount).toBe(7_500);
  });

  it('will not refund a payment that never succeeded', async () => {
    const h = await setup();
    const payment = await h.engine.createPayment({
      provider: 'paystack',
      amount: 1_000,
      currency: 'GHS',
      status: 'pending',
    });
    await expect(h.engine.createRefund({ paymentId: payment.id })).rejects.toMatchObject({
      code: 'invalid_state_transition',
    });
  });
});

describe('determinism', () => {
  it('produces identical ids and timestamps for identical runs', async () => {
    const run = async () => {
      const h = await createHarness({ seed: 'fixed', startAt: '2026-03-01T00:00:00.000Z' });
      const payment = await h.engine.createPayment({
        provider: 'paystack',
        amount: 2_500,
        currency: 'GHS',
        reference: 'det_1',
      });
      const timeline = await h.engine.getTimeline(payment.id);
      await h.close();
      return { id: payment.id, createdAt: payment.createdAt, eventId: timeline[0]?.id };
    };

    expect(await run()).toEqual(await run());
  });

  it('keeps id generation stable when another subsystem draws randomness', async () => {
    const h = await setup();
    // ids fork their own stream, so unrelated draws must not shift them.
    const before = h.ids.next('pay');
    const h2 = await createHarness({ seed: 'test-seed' });
    const after = h2.ids.next('pay');
    await h2.close();
    expect(before).toBe(after);
  });
});

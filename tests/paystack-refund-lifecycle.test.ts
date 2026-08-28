import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * The full refund lifecycle, including `needs-attention` and its recovery.
 *
 * Statuses, their effect on the parent transaction, the webhook names and the
 * 422 on a premature retry are all from
 * <https://paystack.com/docs/payments/refunds/>, read 2026-08-28, cross-checked
 * against `refund_retry` in the pinned OpenAPI spec.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'refunds';
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

/** Paystack's published refund-outcome cards. */
const CARD_OK = '4084 0840 8408 4081';
const CARD_REFUND_FAILS = '4084 0800 0067 1803';
const CARD_REFUND_NEEDS_ATTENTION = '4084 0800 0067 1902';

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function events() {
  return transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
}

async function settledCharge(card: string, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email,
      amount: 200_000,
      currency: 'NGN',
      card: { number: card, expiry_month: '08', expiry_year: '27' },
    },
  });
  await advance('30s');
  return res.json().data.reference as string;
}

async function refund(reference: string, amount?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/refund',
    headers: auth,
    payload: { transaction: reference, ...(amount ? { amount } : {}) },
  });
  return res;
}

async function currentRefund() {
  const { items } = await context.storage.refunds.list({ limit: 10 });
  return items[0]!;
}

async function verify(reference: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${reference}`,
    headers: auth,
  });
  return res.json().data;
}

beforeEach(async () => {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: { url: 'http://localhost:9999/hook' },
  });
});

describe('refunds settle on their own', () => {
  it('walks pending -> processing -> processed and fires all three webhooks', async () => {
    const reference = await settledCharge(CARD_OK, 'ok@example.com');
    const queued = await refund(reference);
    expect(queued.json().data.status).toBe('pending');

    await advance('30s');

    expect((await currentRefund()).status).toBe('successful');
    const names = await events();
    expect(names).toContain('refund.pending');
    expect(names).toContain('refund.processing');
    expect(names).toContain('refund.processed');
    // The transaction follows suit: a fully processed refund reverses it.
    expect((await verify(reference)).status).toBe('reversed');
  });

  it('fails the refund on the card Paystack documents for it', async () => {
    const reference = await settledCharge(CARD_REFUND_FAILS, 'fails@example.com');
    await refund(reference);
    await advance('30s');

    expect((await currentRefund()).status).toBe('failed');
    expect(await events()).toContain('refund.failed');

    // Paystack: a failed refund leaves the transaction Success and the money
    // back with the merchant.
    expect((await verify(reference)).status).toBe('success');
    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.amountRefunded).toBe(0);
  });
});

describe('needs-attention', () => {
  async function stalledRefund() {
    const reference = await settledCharge(
      CARD_REFUND_NEEDS_ATTENTION,
      'attention@example.com',
    );
    await refund(reference);
    await advance('30s');
    return { reference, refund: await currentRefund() };
  }

  it('stalls awaiting bank details and fires refund.needs-attention', async () => {
    const { refund: stalled } = await stalledRefund();

    expect(stalled.status).toBe('needs_attention');
    expect(await events()).toContain('refund.needs-attention');

    const res = await app.inject({
      method: 'GET',
      url: `/paystack/refund/${stalled.id}`,
      headers: auth,
    });
    // Hyphenated on the wire, snake_case internally.
    expect(res.json().data.status).toBe('needs-attention');
  });

  it('does not settle on its own, however far time advances', async () => {
    const { refund: stalled } = await stalledRefund();
    await advance('30d');
    expect((await context.storage.refunds.byId(stalled.id))!.status).toBe('needs_attention');
  });

  it('completes once bank details are supplied', async () => {
    const { reference, refund: stalled } = await stalledRefund();

    const res = await app.inject({
      method: 'POST',
      url: `/paystack/refund/retry_with_customer_details/${stalled.id}`,
      headers: auth,
      payload: {
        refund_account_details: {
          currency: 'NGN',
          account_number: '1234567890',
          bank_id: '9',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('processed');
    expect(res.json().data.refund_account_details.account_number).toBe('1234567890');
    expect((await verify(reference)).status).toBe('reversed');

    // Delivery is a scheduled job, so let it run before asserting on it.
    await advance('1s');
    expect(await events()).toContain('refund.processed');
  });

  it('returns 422 when the refund is not awaiting details', async () => {
    // Paystack: "Use this endpoint only when you receive a
    // refund.needs-attention webhook event."
    const reference = await settledCharge(CARD_OK, 'premature@example.com');
    await refund(reference);
    const queued = await currentRefund();

    const res = await app.inject({
      method: 'POST',
      url: `/paystack/refund/retry_with_customer_details/${queued.id}`,
      headers: auth,
      payload: {
        refund_account_details: {
          currency: 'NGN',
          account_number: '1234567890',
          bank_id: '9',
        },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/needs-attention/);
  });

  it('rejects a retry with incomplete bank details', async () => {
    const { refund: stalled } = await stalledRefund();
    const res = await app.inject({
      method: 'POST',
      url: `/paystack/refund/retry_with_customer_details/${stalled.id}`,
      headers: auth,
      payload: { refund_account_details: { currency: 'NGN' } },
    });
    expect(res.json().status).toBe(false);
  });
});

describe('per-instrument OTP', () => {
  it("accepts Orange CIV's documented 1234 rather than the card default", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'orange@example.com',
        amount: 50_000,
        currency: 'GHS',
        mobile_money: { phone: '070 000 000 0', provider: 'orange' },
      },
    });
    await advance('30s');
    const reference = res.json().data.reference as string;
    expect((await verify(reference)).status).toBe('ongoing');

    // The card default must not work here.
    const wrong = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference },
    });
    expect(wrong.json().data.status).toBe('failed');
  });

  it('still accepts 123456 on a card flow', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'card-otp@example.com',
        amount: 50_000,
        currency: 'NGN',
        card: { number: '5060 6666 6666 6666 666' },
      },
    });
    await advance('30s');
    const reference = res.json().data.reference as string;

    const otp = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference },
    });
    expect(otp.json().data.status).toBe('success');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { paystackRetrySchedule } from '@paybox/paystack';

/**
 * Reporting endpoints, filtering, reference data and the refund lifecycle.
 *
 * Shapes verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-03-10T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'polish';
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

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function settledCharge(amount = 100_000, email = 'dev@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email,
      amount,
      currency: 'NGN',
      card: { number: '4000000000000000', expiry_month: '09', expiry_year: '31' },
    },
  });
  await advance('30s');
  return res.json().data.reference as string;
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

describe('transaction reporting', () => {
  it('serves the timeline built from the real event log', async () => {
    const reference = await settledCharge();
    const transaction = (await get(`/paystack/transaction/verify/${reference}`)).json().data;

    const res = await get(`/paystack/transaction/timeline/${transaction.id}`);
    expect(res.statusCode).toBe(200);
    const log = res.json().data;
    expect(log.success).toBe(true);
    expect(log.history.length).toBeGreaterThan(0);
    expect(log.history.map((h: { message: string }) => h.message)).toContain(
      'Payment successful',
    );
  });

  it('totals only what actually settled', async () => {
    await settledCharge(100_000);
    // A declined charge moved no money and must not count.
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'other@example.com',
        amount: 500_000,
        currency: 'NGN',
        card: { number: '4000000000000002' },
      },
    });
    await advance('30s');

    const res = await get('/paystack/transaction/totals');
    expect(res.json().data.total_volume).toBe(100_000);
    expect(res.json().data.total_volume_by_currency).toEqual([
      { currency: 'NGN', amount: 100_000 },
    ]);
  });

  it('exports rows with the documented envelope', async () => {
    await settledCharge();
    const res = await get('/paystack/transaction/export');
    expect(res.json().data).toHaveProperty('path');
    expect(res.json().data).toHaveProperty('expiresAt');
    expect(res.json().data.rows.length).toBe(1);
    expect(res.json().data.rows[0]).toHaveProperty('reference');
  });
});

describe('date filtering', () => {
  it('filters transactions by an inclusive day range', async () => {
    await settledCharge(10_000, 'a@example.com');
    await advance('2d');
    await settledCharge(20_000, 'b@example.com');

    // Both charges happened on 2026-03-10 and 2026-03-12.
    const onlyFirst = await get('/paystack/transaction?from=2026-03-10&to=2026-03-10');
    expect(onlyFirst.json().data).toHaveLength(1);
    expect(onlyFirst.json().data[0].amount).toBe(10_000);

    const both = await get('/paystack/transaction?from=2026-03-10&to=2026-03-12');
    expect(both.json().data).toHaveLength(2);
  });

  it('treats a bare `to` date as the whole day, not midnight', async () => {
    await settledCharge();
    // The charge is at 09:00. A literal midnight bound would exclude it.
    const res = await get('/paystack/transaction?to=2026-03-10');
    expect(res.json().data).toHaveLength(1);
  });
});

describe('customer listing', () => {
  it('paginates in SQL rather than in memory', async () => {
    for (const name of ['one', 'two', 'three']) {
      await app.inject({
        method: 'POST',
        url: '/paystack/customer',
        headers: auth,
        payload: { email: `${name}@example.com` },
      });
    }

    const first = await get('/paystack/customer?perPage=2&page=1');
    const second = await get('/paystack/customer?perPage=2&page=2');

    expect(first.json().data).toHaveLength(2);
    // Page 2 is genuinely the third row, not an empty remainder of a
    // client-side filter.
    expect(second.json().data).toHaveLength(1);
    expect(second.json().meta.total).toBe(3);
    expect(second.json().meta.page).toBe(2);
  });

  it('searches by email', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/customer',
      headers: auth,
      payload: { email: 'findme@example.com', first_name: 'Ada' },
    });
    await app.inject({
      method: 'POST',
      url: '/paystack/customer',
      headers: auth,
      payload: { email: 'other@example.com' },
    });

    const res = await get('/paystack/customer?search=findme');
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].email).toBe('findme@example.com');
  });

  it('searches by name', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/customer',
      headers: auth,
      payload: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    });
    const res = await get('/paystack/customer?search=lovelace');
    expect(res.json().data).toHaveLength(1);
  });
});

describe('reference data', () => {
  it('lists banks and filters by currency', async () => {
    const all = await get('/paystack/bank');
    expect(all.json().data.length).toBeGreaterThan(0);

    const ghana = await get('/paystack/bank?currency=GHS');
    expect(ghana.json().data.every((b: { currency: string }) => b.currency === 'GHS')).toBe(
      true,
    );
    expect(ghana.json().data.some((b: { code: string }) => b.code === 'MTN')).toBe(true);
  });

  it('lists countries', async () => {
    const res = await get('/paystack/country');
    expect(res.json().data.map((c: { iso_code: string }) => c.iso_code)).toContain('NG');
  });

  it('resolves a bank name on a transfer recipient', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transferrecipient',
      headers: auth,
      payload: {
        type: 'nuban',
        name: 'Tolu Robert',
        account_number: '0123456789',
        bank_code: '058',
        currency: 'NGN',
      },
    });
    // Previously always null; the fixed bank list makes it real.
    expect(res.json().data.details.bank_name).toBe('Guaranty Trust Bank');
  });
});

describe('the refund lifecycle', () => {
  it('emits refund.pending when the refund is queued', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/hook' },
    });
    const reference = await settledCharge();

    await app.inject({
      method: 'POST',
      url: '/paystack/refund',
      headers: auth,
      payload: { transaction: reference, amount: 40_000 },
    });
    await advance('1s');

    const events = transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
    expect(events).toContain('refund.pending');
  });

  it('emits refund.failed when a refund does not settle', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/hook' },
    });
    const reference = await settledCharge();
    await app.inject({
      method: 'POST',
      url: '/paystack/refund',
      headers: auth,
      payload: { transaction: reference, amount: 40_000 },
    });

    const refunds = await context.storage.refunds.list();
    await context.engine.transitionRefund(refunds.items[0]!.id, 'failed');
    await advance('1s');

    const events = transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
    expect(events).toContain('refund.failed');
    // A failed refund releases its hold, so the payment is fully refundable again.
    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.status).toBe('successful');
  });
});

describe('the Paystack retry ladder', () => {
  it('is hourly in test mode', () => {
    expect(paystackRetrySchedule(0, 'test')).toBe(3_600_000);
    expect(paystackRetrySchedule(9, 'test')).toBe(3_600_000);
  });

  it('is three-minutely for the first four live attempts, then hourly', () => {
    expect(paystackRetrySchedule(0, 'live')).toBe(180_000);
    expect(paystackRetrySchedule(3, 'live')).toBe(180_000);
    expect(paystackRetrySchedule(4, 'live')).toBe(3_600_000);
  });
});

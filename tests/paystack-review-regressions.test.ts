import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { paystackRefundOutcome } from '@paybox/paystack';

/**
 * Regressions for defects found in code review.
 *
 * Each test here failed before its fix. They exist because the rest of the
 * suite works with a handful of rows, and several of these bugs only appear
 * past the repository's 500-row page.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'regressions';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

/** More than one repository page, which caps at 500. */
const OVER_A_PAGE = 520;
const UNIT = 1_000;

async function seedSettledPayments(count: number) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const payment = await context.engine.createPayment({
      provider: 'paystack',
      amount: UNIT,
      currency: 'NGN',
      reference: `seed-${i}`,
      status: 'pending',
    });
    created.push(await context.engine.transitionPayment(payment.id, 'successful'));
  }
  return created;
}

describe('aggregates cover every row, not just the first page', () => {
  it('totals the full volume past 500 transactions', async () => {
    await seedSettledPayments(OVER_A_PAGE);

    const res = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/totals',
      headers: auth,
    });
    const data = res.json().data;

    expect(data.total_transactions).toBe(OVER_A_PAGE);
    // Previously summed only the 500 fetched rows, silently disagreeing with
    // the count printed beside it.
    expect(data.total_volume).toBe(OVER_A_PAGE * UNIT);
    expect(data.total_volume_by_currency).toEqual([
      { currency: 'NGN', amount: OVER_A_PAGE * UNIT },
    ]);
  });

  it('counts only settled money in the volume', async () => {
    await seedSettledPayments(3);
    const failed = await context.engine.createPayment({
      provider: 'paystack',
      amount: 999_999,
      currency: 'NGN',
      reference: 'never-settled',
      status: 'pending',
    });
    await context.engine.transitionPayment(failed.id, 'failed');

    const res = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/totals',
      headers: auth,
    });
    expect(res.json().data.total_volume).toBe(3 * UNIT);
    expect(res.json().data.total_transactions).toBe(4);
  });

  it('exports every row rather than truncating at a page', async () => {
    await seedSettledPayments(OVER_A_PAGE);

    const res = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/export',
      headers: auth,
    });
    expect(res.json().data.rows).toHaveLength(OVER_A_PAGE);
    expect(res.json().data.total).toBe(OVER_A_PAGE);
  });
});

describe('numeric ids stay resolvable past the first page', () => {
  it('finds the oldest transaction by its numeric id', async () => {
    const payments = await seedSettledPayments(OVER_A_PAGE);
    // Listing is newest-first, so the first created is well outside page one.
    const oldest = payments[0]!;
    const numericId = (
      await app.inject({
        method: 'GET',
        url: `/paystack/transaction/verify/${oldest.reference}`,
        headers: auth,
      })
    ).json().data.id as number;

    const res = await app.inject({
      method: 'GET',
      url: `/paystack/transaction/${numericId}`,
      headers: auth,
    });

    // Previously 404: the lookup scanned only the newest 500 rows.
    expect(res.statusCode).toBe(200);
    expect(res.json().data.reference).toBe(oldest.reference);
  });
});

describe('resolving a dispute is atomic', () => {
  async function disputedPayment() {
    const charge = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'atomic@example.com',
        amount: 200_000,
        currency: 'NGN',
        card: { number: '4000000000000000' },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/time',
      payload: { action: 'advance', value: '30s' },
    });
    const reference = charge.json().data.reference as string;
    const dispute = await app.inject({
      method: 'POST',
      url: '/paystack/dispute',
      headers: auth,
      payload: { transaction: reference },
    });
    return { reference, disputeId: dispute.json().data.id as number };
  }

  it('does not refund twice when two partial resolutions race', async () => {
    const { reference, disputeId } = await disputedPayment();
    const payload = {
      resolution: 'merchant-accepted',
      message: 'Conceded',
      refund_amount: 100_000,
      uploaded_filename: 'e.pdf',
    };

    // Both requests read the dispute before either writes. Previously each
    // settled its own refund, fully refunding a partially-disputed payment.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: `/paystack/dispute/${disputeId}/resolve`,
        headers: auth,
        payload,
      }),
      app.inject({
        method: 'PUT',
        url: `/paystack/dispute/${disputeId}/resolve`,
        headers: auth,
        payload,
      }),
    ]);

    const outcomes = [first.json().status, second.json().status].sort();
    expect(outcomes).toEqual([false, true]);

    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.amountRefunded).toBe(100_000);
    expect(payment?.status).toBe('partially_refunded');

    const refunds = await context.storage.refunds.listByPayment(payment!.id);
    expect(refunds.filter((r) => r.status === 'successful')).toHaveLength(1);
  });

  it('leaves no refund behind when the resolution is rejected', async () => {
    const { reference, disputeId } = await disputedPayment();
    const payload = {
      resolution: 'merchant-accepted',
      message: 'Conceded',
      refund_amount: 50_000,
      uploaded_filename: 'e.pdf',
    };

    await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${disputeId}/resolve`,
      headers: auth,
      payload,
    });
    const again = await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${disputeId}/resolve`,
      headers: auth,
      payload,
    });

    expect(again.json().status).toBe(false);
    const payment = await context.storage.payments.byReference('paystack', reference);
    // The rejected second attempt must not have moved any money.
    expect(payment?.amountRefunded).toBe(50_000);
  });
});

describe('refund outcomes are keyed exactly, not by suffix scan', () => {
  it('maps only the two documented cards', () => {
    expect(paystackRefundOutcome('1803')).toBe('failed');
    expect(paystackRefundOutcome('1902')).toBe('needs_attention');
  });

  it('does not leak an outcome onto the shared 0000 suffix', () => {
    // 0000 is the last four of the M-PESA test number, the Orange CIV test
    // number, and paybox's own success card.
    expect(paystackRefundOutcome('0000')).toBe('successful');
  });

  it('treats an unknown suffix as an ordinary refund', () => {
    expect(paystackRefundOutcome('4081')).toBe('successful');
    expect(paystackRefundOutcome(null)).toBe('successful');
  });
});

describe('input validation', () => {
  it('rejects an unknown dispute status filter instead of returning empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/paystack/dispute?status=nonsense',
      headers: auth,
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/Unknown dispute status/);
  });

  it('accepts the documented hyphenated statuses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/paystack/dispute?status=awaiting-merchant-feedback',
      headers: auth,
    });
    expect(res.json().status).toBe(true);
  });
});

describe('batched listing matches per-row serialisation', () => {
  it('returns the same fields the single-transaction endpoint does', async () => {
    const charge = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'batch@example.com',
        amount: 120_000,
        currency: 'NGN',
        card: { number: '4000000000000000', expiry_month: '09', expiry_year: '31' },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/time',
      payload: { action: 'advance', value: '30s' },
    });
    const reference = charge.json().data.reference as string;

    const single = (
      await app.inject({
        method: 'GET',
        url: `/paystack/transaction/verify/${reference}`,
        headers: auth,
      })
    ).json().data;
    const listed = (
      await app.inject({ method: 'GET', url: '/paystack/transaction', headers: auth })
    ).json().data[0];

    // The batched path must not quietly drop the joins the single path makes.
    expect(listed.customer.email).toBe(single.customer.email);
    expect(listed.authorization.authorization_code).toBe(
      single.authorization.authorization_code,
    );
    expect(listed.log.history).toEqual(single.log.history);
    expect(listed.gateway_response_code).toBe(single.gateway_response_code);
  });
});

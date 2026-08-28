import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Subaccounts, splits and the balance ledger.
 *
 * Request shapes verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27
 * (`SubaccountCreate`, `SplitCreate`, `SplitSubaccounts`,
 * `BalanceCheckResponseArray`).
 */
let app: FastifyInstance;
let context: PayboxContext;

/** Small enough that a single transfer can drain it deliberately. */
const OPENING = '500000';
/** Emulated NGN transfer fee — Paystack holds this alongside the amount. */
const TRANSFER_FEE = 1_000;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'marketplace';
  process.env.PAYBOX_OPENING_BALANCE = OPENING;
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
  delete process.env.PAYBOX_OPENING_BALANCE;
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

async function createSubaccount(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/subaccount',
    headers: auth,
    payload: {
      business_name: 'Oasis',
      settlement_bank: '058',
      account_number: '0123456047',
      percentage_charge: 30,
      ...payload,
    },
  });
  return res;
}

async function createSplit(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/paystack/split',
    headers: auth,
    payload: { name: 'Halfsies', type: 'percentage', currency: 'NGN', ...payload },
  });
}

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function balance(currency = 'NGN') {
  const res = await app.inject({ method: 'GET', url: '/paystack/balance', headers: auth });
  const row = (res.json().data as Array<{ currency: string; balance: number }>).find(
    (b) => b.currency === currency,
  );
  return row?.balance ?? null;
}

/** A settled card charge, which credits the balance. */
async function chargeCard(amount: number, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email: 'dev@example.com',
      amount,
      currency: 'NGN',
      card: { number: '4000000000000000', expiry_month: '09', expiry_year: '31' },
      ...extra,
    },
  });
  await advance('30s');
  return res.json().data.reference as string;
}

async function verify(reference: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${reference}`,
    headers: auth,
  });
  return res.json().data;
}

describe('subaccounts', () => {
  it('creates a subaccount with an ACCT_ code', async () => {
    const res = await createSubaccount();
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.subaccount_code).toMatch(/^ACCT_/);
    expect(data.percentage_charge).toBe(30);
    expect(data.business_name).toBe('Oasis');
  });

  it('rejects a percentage charge outside 0-100', async () => {
    const res = await createSubaccount({ percentage_charge: 150 });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/between 0 and 100/);
  });

  it('updates a subaccount', async () => {
    const code = (await createSubaccount()).json().data.subaccount_code;
    const res = await app.inject({
      method: 'PUT',
      url: `/paystack/subaccount/${code}`,
      headers: auth,
      payload: { business_name: 'Oasis Renamed' },
    });
    expect(res.json().data.business_name).toBe('Oasis Renamed');
  });
});

describe('splits', () => {
  it('creates a percentage split', async () => {
    const sub = (await createSubaccount()).json().data.subaccount_code;
    const res = await createSplit({ subaccounts: [{ subaccount: sub, share: 50 }] });

    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.split_code).toMatch(/^SPL_/);
    expect(data.type).toBe('percentage');
    expect(data.total_subaccounts).toBe(1);
  });

  it('rejects percentage shares totalling more than 100', async () => {
    const a = (await createSubaccount()).json().data.subaccount_code;
    const b = (await createSubaccount({ business_name: 'Second' })).json().data.subaccount_code;

    const res = await createSplit({
      subaccounts: [
        { subaccount: a, share: 60 },
        { subaccount: b, share: 60 },
      ],
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/exceeds 100/);
  });

  it('refuses to push a split past 100% one subaccount at a time', async () => {
    const a = (await createSubaccount()).json().data.subaccount_code;
    const b = (await createSubaccount({ business_name: 'Second' })).json().data.subaccount_code;
    const split = (await createSplit({ subaccounts: [{ subaccount: a, share: 70 }] })).json().data;

    const res = await app.inject({
      method: 'POST',
      url: `/paystack/split/${split.split_code}/subaccount/add`,
      headers: auth,
      payload: { subaccount: b, share: 40 },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/exceeds 100/);
  });

  it('adds and removes subaccounts', async () => {
    const a = (await createSubaccount()).json().data.subaccount_code;
    const b = (await createSubaccount({ business_name: 'Second' })).json().data.subaccount_code;
    const split = (await createSplit({ subaccounts: [{ subaccount: a, share: 30 }] })).json().data;

    const added = await app.inject({
      method: 'POST',
      url: `/paystack/split/${split.split_code}/subaccount/add`,
      headers: auth,
      payload: { subaccount: b, share: 20 },
    });
    expect(added.json().data.total_subaccounts).toBe(2);

    const removed = await app.inject({
      method: 'POST',
      url: `/paystack/split/${split.split_code}/subaccount/remove`,
      headers: auth,
      payload: { subaccount: b },
    });
    expect(removed.json().data.total_subaccounts).toBe(1);
  });

  it('computes the documented percentage shares on a settled transaction', async () => {
    const sub = (await createSubaccount()).json().data.subaccount_code;
    const split = (
      await createSplit({ subaccounts: [{ subaccount: sub, share: 25 }] })
    ).json().data;

    const reference = await chargeCard(100_000, { split_code: split.split_code });
    const transaction = await verify(reference);

    expect(transaction.status).toBe('success');
    expect(transaction.split.split_code).toBe(split.split_code);
    expect(transaction.fees_split.subaccounts).toEqual([
      { subaccountCode: sub.replace(/^ACCT_/, ''), amount: 25_000 },
    ]);
    expect(transaction.fees_split.merchant).toBe(75_000);
  });

  it('computes flat shares and caps them at the amount', async () => {
    const sub = (await createSubaccount()).json().data.subaccount_code;
    const split = (
      await createSplit({
        type: 'flat',
        subaccounts: [{ subaccount: sub, share: 300_000 }],
      })
    ).json().data;

    const reference = await chargeCard(50_000, { split_code: split.split_code });
    const transaction = await verify(reference);

    // A flat share larger than the payment cannot pay out more than was taken.
    expect(transaction.fees_split.subaccounts[0].amount).toBe(50_000);
    expect(transaction.fees_split.merchant).toBe(0);
  });

  it('reports no breakdown for a transaction that never succeeded', async () => {
    const sub = (await createSubaccount()).json().data.subaccount_code;
    const split = (
      await createSplit({ subaccounts: [{ subaccount: sub, share: 25 }] })
    ).json().data;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'dev@example.com',
        amount: 90_000,
        currency: 'NGN',
        split_code: split.split_code,
        card: { number: '4000000000000002' },
      },
    });
    await advance('30s');

    const transaction = await verify(res.json().data.reference);
    expect(transaction.status).toBe('failed');
    expect(transaction.fees_split).toBeNull();
  });
});

describe('balance', () => {
  it('starts at the configured opening float', async () => {
    expect(await balance()).toBe(Number(OPENING));
  });

  it('credits a successful charge', async () => {
    await chargeCard(120_000);
    expect(await balance()).toBe(Number(OPENING) + 120_000);
  });

  it('debits a settled refund', async () => {
    const reference = await chargeCard(120_000);
    const transaction = await verify(reference);

    const refund = await app.inject({
      method: 'POST',
      url: '/paystack/refund',
      headers: auth,
      payload: { transaction: transaction.reference, amount: 20_000 },
    });
    const refundId = refund.json().data.id as number;
    expect(refundId).toBeTruthy();

    // Refunds are queued; settle it the way the dashboard would.
    const stored = await context.storage.refunds.list();
    await context.engine.transitionRefund(stored.items[0]!.id, 'successful');

    expect(await balance()).toBe(Number(OPENING) + 120_000 - 20_000);
  });

  it('lists ledger movements with signed differences', async () => {
    await chargeCard(70_000);
    const res = await app.inject({
      method: 'GET',
      url: '/paystack/balance/ledger',
      headers: auth,
    });
    const entries = res.json().data as Array<{ difference: number; reason: string }>;
    expect(entries.some((e) => e.reason === 'charge' && e.difference === 70_000)).toBe(true);
  });
});

describe('transfers against the balance', () => {
  async function createRecipient() {
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
    return res.json().data.recipient_code as string;
  }

  it('reserves the amount plus the fee when the transfer is queued', async () => {
    const recipient = await createRecipient();
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { source: 'balance', amount: 100_000, recipient, currency: 'NGN' },
    });

    expect(res.statusCode).toBe(200);
    // Paystack holds "the transfer amount plus the transfer fee", so a check
    // against the amount alone would pass transfers it would refuse.
    expect(await balance()).toBe(Number(OPENING) - 100_000 - TRANSFER_FEE);
  });

  it('refuses a transfer that only the fee puts out of reach', async () => {
    const recipient = await createRecipient();
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      // Exactly the balance: affordable on amount alone, not once the fee is
      // added. This is the case a naive check gets wrong.
      payload: { source: 'balance', amount: Number(OPENING), recipient, currency: 'NGN' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/plus a fee of/);
    expect(await balance()).toBe(Number(OPENING));
  });

  it('refuses a transfer the balance cannot cover', async () => {
    const recipient = await createRecipient();
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { source: 'balance', amount: 900_000, recipient, currency: 'NGN' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/exceeds the available balance/);
    // Nothing was reserved for a transfer that was never created.
    expect(await balance()).toBe(Number(OPENING));
  });

  it('stops two transfers from spending the same money', async () => {
    const recipient = await createRecipient();
    const payload = { source: 'balance', amount: 400_000, recipient, currency: 'NGN' };

    const first = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { ...payload, reference: 'payout-1' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { ...payload, reference: 'payout-2' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
  });

  it('returns the reserved funds when a transfer fails', async () => {
    const recipient = await createRecipient();
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { source: 'balance', amount: 100_000, recipient, currency: 'NGN' },
    });
    const code = res.json().data.transfer_code.replace(/^TRF_/, '');
    const transfer = await context.storage.transfers.byProviderTransferId('paystack', code);

    await context.engine.transitionTransfer(transfer!.id, 'failed', {
      failureReason: 'Bank rejected the payout',
    });

    // Releases exactly what was reserved: amount *and* fee.
    expect(await balance()).toBe(Number(OPENING));
  });

  it('lets the balance be drained and then refilled by a charge', async () => {
    const recipient = await createRecipient();
    await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      // Amount + fee lands exactly on the balance.
      payload: {
        source: 'balance',
        amount: Number(OPENING) - TRANSFER_FEE,
        recipient,
        currency: 'NGN',
      },
    });
    expect(await balance()).toBe(0);

    await chargeCard(80_000);
    expect(await balance()).toBe(80_000);
  });
});

describe('the transfer fee is configurable', () => {
  it('uses the rate from config rather than a hardcoded one', async () => {
    // A separate app so the override is in effect from boot.
    process.env.PAYBOX_DATABASE = ':memory:';
    process.env.PAYBOX_OPENING_BALANCE = '500000';
    const { config } = loadConfig();
    const scoped = await buildContext({
      config: { ...config, balance: { ...config.balance, transferFee: { NGN: 25_000 } } },
      transport: new RecordingTransport(),
      logSink: () => {},
    });
    const scopedApp = await buildApp(scoped);
    await scopedApp.ready();

    try {
      const recipient = await scopedApp.inject({
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

      await scopedApp.inject({
        method: 'POST',
        url: '/paystack/transfer',
        headers: auth,
        payload: {
          source: 'balance',
          amount: 100_000,
          recipient: recipient.json().data.recipient_code,
          currency: 'NGN',
        },
      });

      const res = await scopedApp.inject({
        method: 'GET',
        url: '/paystack/balance',
        headers: auth,
      });
      const ngn = (res.json().data as Array<{ currency: string; balance: number }>).find(
        (b) => b.currency === 'NGN',
      );
      // 500000 - 100000 - the configured 25000, not the default 1000.
      expect(ngn?.balance).toBe(375_000);
    } finally {
      await scopedApp.close();
      await scoped.shutdown();
    }
  });
});

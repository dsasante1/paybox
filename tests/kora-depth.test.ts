import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Kora depth: balances, cursor-paged listing, bulk payouts and lookups.
 *
 * Shapes transcribed from the Kora Public APIs Postman collection
 * (docs.korapay.com, collection 303979/SVzxXeSM), read 2026-08-29.
 *
 * The cursor tests are the interesting ones: Kora pages by an opaque `pointer`
 * on each row rather than by offset, so a client that stores one and comes
 * back later must find the same place.
 */
let app: FastifyInstance;
let context: PayboxContext;

const API = '/kora/merchant/api/v1';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-07-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'kora-depth';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = () => ({
  authorization: `Bearer ${context.koraKeys.secretKey}`,
  'content-type': 'application/json',
});
const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: body as object });
const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${context.koraKeys.secretKey}` } });

const customer = { name: 'Ada Lovelace', email: 'ada@example.com' };

async function charge(reference: string, amount = 1000) {
  return post(`${API}/charges/initialize`, { reference, amount, currency: 'NGN', customer });
}

async function payout(reference: string, amount = 500) {
  return post(`${API}/transactions/disburse`, {
    reference,
    destination: {
      type: 'bank_account',
      amount,
      currency: 'NGN',
      bank_account: { bank_code: '044', account_number: '0690000031' },
    },
  });
}

describe('balances', () => {
  it('reports available per currency, with pending always zero', async () => {
    const body = (await get(`${API}/balances`)).json();

    expect(body.status).toBe(true);
    expect(body.data.NGN).toBeDefined();
    // paybox settles instantly, so there is no window in which money is
    // collected but unavailable. Inventing a pending figure would invite a
    // developer to build a "wait for funds" flow around a wait that does not
    // exist here.
    expect(body.data.NGN.pending_balance).toBe(0);
    expect(body.data.NGN.available_balance).toBeGreaterThan(0);
  });

  it('moves when a payout reserves against it', async () => {
    const before = (await get(`${API}/balances`)).json().data.NGN.available_balance;
    await payout('bal-1', 2500);
    const after = (await get(`${API}/balances`)).json().data.NGN.available_balance;

    expect(after).toBe(before - 2500);
  });
});

describe('balance history', () => {
  it('folds forward from the opening balance', async () => {
    await payout('hist-1', 1000);
    await payout('hist-2', 500);

    const body = (await get(`${API}/balances/history`)).json();
    expect(body.data.history.length).toBeGreaterThanOrEqual(2);

    // Newest first, so the newest entry's `balance_after` is the balance now.
    const newest = body.data.history[0];
    const balance = (await get(`${API}/balances`)).json().data.NGN.available_balance;
    expect(Number(newest.balance_after)).toBe(balance);

    // And every row's arithmetic holds on its own.
    for (const row of body.data.history) {
      const delta = row.direction === 'credit' ? Number(row.amount) : -Number(row.amount);
      expect(Number(row.balance_after)).toBeCloseTo(Number(row.balance_before) + delta, 2);
    }
  });
});

describe('cursor pagination', () => {
  it('pages pay-ins by pointer, not offset', async () => {
    for (const n of [1, 2, 3, 4, 5]) await charge(`pg-${n}`);

    const first = (await get(`${API}/pay-ins?limit=2`)).json();
    expect(first.data.payins).toHaveLength(2);
    expect(first.data.has_more).toBe(true);
    expect(first.data.payins[0].pointer).toMatch(/^cur_/);

    const cursor = first.data.payins[1].pointer;
    const second = (await get(`${API}/pay-ins?limit=2&starting_after=${cursor}`)).json();

    expect(second.data.payins).toHaveLength(2);
    // No overlap: the second page genuinely resumes after the cursor.
    const firstRefs = first.data.payins.map((p: { reference: string }) => p.reference);
    const secondRefs = second.data.payins.map((p: { reference: string }) => p.reference);
    expect(secondRefs.some((r: string) => firstRefs.includes(r))).toBe(false);
  });

  it('gives a row the same pointer on every request', async () => {
    await charge('stable-1');
    const a = (await get(`${API}/pay-ins?limit=10`)).json().data.payins[0].pointer;
    const b = (await get(`${API}/pay-ins?limit=10`)).json().data.payins[0].pointer;

    // A client that stores a cursor and comes back later must find the same
    // place, so the pointer is derived from the row, not its position.
    expect(a).toBe(b);
  });

  it('degrades rather than breaking on a stale cursor', async () => {
    await charge('stale-1');
    const body = (await get(`${API}/pay-ins?limit=10&starting_after=cur_nolongerexists`)).json();

    // A stale pointer should not break a client's sync loop.
    expect(body.status).toBe(true);
    expect(body.data.payins.length).toBeGreaterThan(0);
  });

  it('reports has_more false on the last page', async () => {
    await charge('last-1');
    const body = (await get(`${API}/pay-ins?limit=10`)).json();
    expect(body.data.has_more).toBe(false);
  });

  it('pages payouts the same way', async () => {
    await payout('po-a', 100);
    await payout('po-b', 100);

    const body = (await get(`${API}/payouts?limit=1`)).json();
    expect(body.data.payouts).toHaveLength(1);
    expect(body.data.has_more).toBe(true);
    expect(body.data.payouts[0].payment_destination).toBe('bank_account');
  });
});

describe('bulk payouts', () => {
  const batch = {
    batch_reference: 'BULK-1',
    description: 'test bulk transfer',
    currency: 'NGN',
    merchant_bears_cost: true,
    payouts: [
      {
        reference: 'bulk-a',
        amount: 1500,
        type: 'bank_account',
        narration: 'One',
        bank_account: { bank_code: '044', account_number: '0690000031' },
        customer: { name: 'John', email: 'john@example.com' },
      },
      {
        reference: 'bulk-b',
        amount: 2500,
        type: 'bank_account',
        narration: 'Two',
        bank_account: { bank_code: '058', account_number: '0690000032' },
      },
    ],
  };

  it('creates one transfer per entry', async () => {
    const body = (await post(`${API}/transactions/disburse/bulk`, batch)).json();

    expect(body.message).toBe('Bulk payout initiated successfully');
    expect(body.data.total_chargeable_amount).toBe(4000);
    expect(body.data.reference).toBe('BULK-1');

    const stored = await context.storage.transfers.list({ limit: 100 });
    expect(stored.items.filter((t) => t.metadata.batch_reference === 'BULK-1')).toHaveLength(2);
  });

  it('reserves each entry against the balance individually', async () => {
    const before = (await get(`${API}/balances`)).json().data.NGN.available_balance;
    await post(`${API}/transactions/disburse/bulk`, batch);
    const after = (await get(`${API}/balances`)).json().data.NGN.available_balance;

    expect(after).toBe(before - 4000);
  });

  it('lists the payouts in a batch', async () => {
    await post(`${API}/transactions/disburse/bulk`, batch);
    const body = (await get(`${API}/transactions/bulk/BULK-1/payout`)).json();

    expect(body.data.data).toHaveLength(2);
    expect(body.data.data.map((p: { reference: string }) => p.reference).sort()).toEqual([
      'bulk-a',
      'bulk-b',
    ]);
    expect(body.data.data[0].batch_reference).toBe('BULK-1');
  });

  it('summarises the batch, and is not complete while any is in flight', async () => {
    await post(`${API}/transactions/disburse/bulk`, batch);
    const pending = (await get(`${API}/transactions/bulk/BULK-1`)).json();

    expect(pending.data.amount).toBe('4000.00');
    expect(pending.data.processing_transactions).toBe(2);
    expect(pending.data.status).toBe('pending');

    // Settle both, and the batch completes.
    const stored = await context.storage.transfers.list({ limit: 100 });
    for (const transfer of stored.items.filter((t) => t.metadata.batch_reference === 'BULK-1')) {
      await context.engine.transitionTransfer(transfer.id, 'successful');
    }

    const done = (await get(`${API}/transactions/bulk/BULK-1`)).json();
    expect(done.data.status).toBe('complete');
    expect(done.data.successful_transactions).toBe(2);
  });

  it('lets one entry fail without the others', async () => {
    await post(`${API}/transactions/disburse/bulk`, batch);
    const stored = await context.storage.transfers.list({ limit: 100 });
    const entries = stored.items.filter((t) => t.metadata.batch_reference === 'BULK-1');

    await context.engine.transitionTransfer(entries[0]!.id, 'failed', {
      failureReason: 'Account closed',
    });
    await context.engine.transitionTransfer(entries[1]!.id, 'successful');

    const body = (await get(`${API}/transactions/bulk/BULK-1`)).json();
    // A batch is not an atomic unit at Kora, and is not one here.
    expect(body.data.failed_transactions).toBe(1);
    expect(body.data.successful_transactions).toBe(1);
    expect(body.data.status).toBe('complete');
  });

  it('404s for an unknown batch', async () => {
    const response = await get(`${API}/transactions/bulk/NOPE`);
    expect(response.statusCode).toBe(404);
  });
});

describe('lookups', () => {
  it('lists banks by country with real codes', async () => {
    const body = (await get(`${API}/misc/banks?countryCode=NG`)).json();
    expect(body.data.map((b: { code: string }) => b.code)).toContain('044');
    expect(body.data[0]).toHaveProperty('slug');
  });

  it('lists mobile-money operators', async () => {
    const body = (await get(`${API}/misc/mobile-money?countryCode=KE`)).json();
    expect(body.data.map((o: { slug: string }) => o.slug)).toContain('safaricom-ke');
    expect(body.data[0]).toHaveProperty('min');
  });

  it('says which countries it has rather than returning nothing', async () => {
    const response = await get(`${API}/misc/banks?countryCode=ZZ`);
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('Available:');
  });
});

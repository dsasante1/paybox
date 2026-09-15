import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * List ordering under a frozen clock.
 *
 * `created_at` is not unique and cannot be: the clock is frozen throughout the
 * suite, so every row written in one operation shares a timestamp to the
 * millisecond. A query sorting on it alone leaves SQLite free to return tied
 * rows in whatever order it likes — and measured before the fix, it returned
 * an order that was neither insertion order nor id order, just an artefact of
 * the query plan.
 *
 * This surfaced for real. Adding the Quid Payments adapter drew one more token
 * from the seeded id stream, which shifted every id after it, which flipped the
 * tie-break between the two subaccounts the Wise adapter seeds as profiles:
 * `GET /v2/profiles` began answering in a different order on the second call
 * than the first. Nothing about that was Wise-specific. Every list query in the
 * storage layer had the same latent instability; that one merely had a test
 * sharp enough to catch it.
 *
 * So the order is now *specified* rather than left to the planner — tied rows
 * break on `id` (or on `sequence`, for the three append-only tables that have
 * one). The tests below assert that specified order, not merely that two calls
 * happen to agree: a query with no tiebreaker is perfectly capable of being
 * self-consistent and still wrong, which is exactly how this hid.
 */
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-04T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'list-ordering';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
});

afterEach(async () => {
  await context.shutdown();
});

/**
 * Six subaccounts written at one frozen instant.
 *
 * `subaccounts` is the table the Wise regression actually came through, and it
 * was one of the twenty-eight that had no tiebreaker. Returns them in creation
 * order.
 */
async function seedSubaccounts(count = 6): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i < count; i++) {
    const subaccount = await context.engine.createSubaccount({
      provider: 'wise',
      businessName: `Acct ${i}`,
      settlementBank: 'wise',
      accountNumber: `100000000${i}`,
      percentageCharge: 0,
      currency: 'GBP',
      countryCode: 'GB',
      metadata: { n: i },
    });
    created.push(subaccount.id);
  }
  return created;
}

describe('a list query whose sort column ties', () => {
  it('really does tie, or the rest of this file proves nothing', async () => {
    await seedSubaccounts();
    const { items } = await context.storage.subaccounts.list({ provider: 'wise', limit: 50 });
    expect(new Set(items.map((s) => s.createdAt)).size).toBe(1);
  });

  it('breaks the tie on id, rather than however the planner feels', async () => {
    const created = await seedSubaccounts();
    const { items } = await context.storage.subaccounts.list({ provider: 'wise', limit: 50 });

    // The assertion that fails without a tiebreaker: measured then, SQLite
    // returned an order matching neither of the two orders anyone could name.
    expect(items.map((s) => s.id)).toEqual([...created].sort().reverse());
  });

  it('returns the same order twice', async () => {
    await seedSubaccounts();
    const first = await context.storage.subaccounts.list({ provider: 'wise', limit: 50 });
    const second = await context.storage.subaccounts.list({ provider: 'wise', limit: 50 });
    expect(first.items.map((s) => s.id)).toEqual(second.items.map((s) => s.id));
  });

  it('pages without dropping or repeating a row', async () => {
    const created = await seedSubaccounts();

    const paged: string[] = [];
    for (let offset = 0; offset < created.length; offset += 4) {
      const { items } = await context.storage.subaccounts.list({
        provider: 'wise',
        limit: 4,
        offset,
      });
      paged.push(...items.map((s) => s.id));
    }

    // The half of this that is a plain bug rather than a broken promise:
    // LIMIT/OFFSET over an unstable sort can show one row on two pages and
    // another on none.
    expect(paged).toHaveLength(created.length);
    expect(new Set(paged).size).toBe(created.length);
    expect(paged).toEqual([...created].sort().reverse());
  });
});

describe('the append-only tables', () => {
  it('break ties on sequence, which is the order rows were written', async () => {
    // `id` is a token from the seeded random stream and says nothing about
    // when a row was written, so the three tables that record an append order
    // sort on that instead. Jobs enqueued in one frozen instant must drain in
    // enqueue order.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = context.ids.next('job');
      ids.push(id);
      await context.storage.jobs.enqueue({
        id,
        kind: 'payment.simulate',
        payload: { n: i },
        status: 'ready',
        runAt: context.clock.nowISO(),
        attempt: 0,
        maxAttempts: 1,
        leaseExpiresAt: null,
        lastError: null,
        groupKey: null,
        createdAt: context.clock.nowISO(),
        updatedAt: context.clock.nowISO(),
      });
    }

    const { items } = await context.storage.jobs.list({ limit: 50 });
    expect(items.map((job) => job.id)).toEqual(ids);
  });
});

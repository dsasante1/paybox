import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Ledger append order under a frozen clock.
 *
 * Regression, and the same bug as `job-ordering.test.ts` in the other
 * append-only table. `ledger.list` ordered by `created_at` then `id`. Under
 * the frozen clock every entry written in one request shares a `created_at`,
 * so the tie fell to `id` — a base32 token drawn from the seeded random
 * stream, which is deterministic but has nothing to do with when a row was
 * written.
 *
 * That is invisible for a *balance*, which is a sum and does not care about
 * order. It is very visible for a **running** balance: WeWire puts
 * `balanceBefore` and `balanceAfter` on every wallet transaction, and those
 * are a fold. Fold the same entries in the wrong order and a payout reports
 * the balance from before the top-up that funded it.
 *
 * Migration 0020 added `balance_ledger.sequence`. This pins it.
 */
let app: FastifyInstance;
let context: PayboxContext;

async function boot(seed: string) {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-04T12:00:00.000Z';
  process.env.PAYBOX_SEED = seed;
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
  app = await buildApp(context);
  await app.ready();
}

beforeEach(async () => {
  await boot('ledger');
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

describe('the balance ledger', () => {
  it('returns entries in append order, not id order, under a frozen clock', async () => {
    // Ten entries at the same instant. Their ids come from the seeded random
    // stream and are in no particular relation to insertion order, so if the
    // sort still fell to `id` these would come back shuffled.
    for (let index = 1; index <= 10; index += 1) {
      await context.engine.creditBalance({
        provider: 'wewire',
        currency: 'USD',
        amount: index * 100,
        reason: `entry_${index}`,
      });
    }

    const { items } = await context.storage.ledger.list({ provider: 'wewire', limit: 50 });
    // The repository returns newest first.
    expect(items.map((entry) => entry.reason)).toEqual([
      'entry_10',
      'entry_9',
      'entry_8',
      'entry_7',
      'entry_6',
      'entry_5',
      'entry_4',
      'entry_3',
      'entry_2',
      'entry_1',
    ]);

    // Every entry shares the instant, which is what made the tiebreak load-bearing.
    expect(new Set(items.map((entry) => entry.createdAt)).size).toBe(1);
  });

  it('folds a running balance that agrees with the balance itself', async () => {
    const opening = await context.engine.getBalance('wewire', 'USD', null);

    await context.engine.creditBalance({
      provider: 'wewire',
      currency: 'USD',
      amount: 500_00,
      reason: 'topup',
      resourceId: 'res_topup',
    });
    await context.engine.debitBalance({
      provider: 'wewire',
      currency: 'USD',
      amount: 250_00,
      reason: 'payout',
      resourceId: 'res_payout',
    });

    const { items } = await context.storage.ledger.list({ provider: 'wewire', limit: 50 });
    const oldestFirst = [...items].reverse();

    let running = opening;
    const windows = new Map<string, { before: number; after: number }>();
    for (const entry of oldestFirst) {
      const before = running;
      running += entry.direction === 'credit' ? entry.amount : -entry.amount;
      if (entry.resourceId) windows.set(entry.resourceId, { before, after: running });
    }

    // The payout must see the balance *after* the top-up that funded it.
    expect(windows.get('res_topup')).toEqual({ before: opening, after: opening + 500_00 });
    expect(windows.get('res_payout')).toEqual({
      before: opening + 500_00,
      after: opening + 250_00,
    });

    // And the fold lands exactly where the balance says it should.
    expect(running).toBe(await context.engine.getBalance('wewire', 'USD', null));
  });

  it('is identical across two runs at the same seed', async () => {
    const reasons = async () => {
      for (let index = 1; index <= 6; index += 1) {
        await context.engine.creditBalance({
          provider: 'kora',
          currency: 'NGN',
          amount: index * 10,
          reason: `e${index}`,
        });
      }
      const { items } = await context.storage.ledger.list({ provider: 'kora', limit: 20 });
      return items.map((entry) => `${entry.reason}:${entry.amount}`);
    };

    const first = await reasons();
    await app.close();
    await context.shutdown();

    await boot('ledger');
    const second = await reasons();

    expect(second).toEqual(first);
  });
});

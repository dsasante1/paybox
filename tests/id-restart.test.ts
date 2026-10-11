import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Ids across a restart on the same database.
 *
 * Every id comes from a stream seeded by PAYBOX_SEED, which is what makes a
 * run reproducible. A restart used to start that stream again from the
 * beginning, so the first ids minted after it were the ids minted first
 * last time -- already in the database. The write failed ("UNIQUE constraint
 * failed"), and inside a job it killed the job: a webhook retry, a renewal.
 */
const START = '2026-06-14T12:00:00.000Z';

let dir: string;
let database: string;
const open: PayboxContext[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paybox-ids-'));
  database = join(dir, 'paybox.db');
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!.shutdown();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PAYBOX_START_AT;
  delete process.env.PAYBOX_FREEZE_CLOCK;
});

async function boot(db = database): Promise<PayboxContext> {
  process.env.PAYBOX_DATABASE = db;
  process.env.PAYBOX_SEED = 'ids';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  const { config } = loadConfig();
  const context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  open.push(context);
  return context;
}

async function restart(context: PayboxContext, db = database): Promise<PayboxContext> {
  open.splice(open.indexOf(context), 1);
  await context.shutdown();
  return boot(db);
}

const pay = (context: PayboxContext, reference: string) =>
  context.engine.createPayment({ provider: 'paystack', amount: 1000, currency: 'NGN', reference });

describe('ids after a restart on the same database', () => {
  it('never repeat an id already stored', async () => {
    const first = await boot();
    const before = [];
    for (let i = 0; i < 5; i++) before.push(await pay(first, `before-${i}`));

    const second = await restart(first);
    const after = [];
    for (let i = 0; i < 5; i++) after.push(await pay(second, `after-${i}`));

    const all = [...before, ...after].map((payment) => payment.id);
    expect(new Set(all).size).toBe(all.length);
    // And the events behind them, which collided first.
    const events = (await second.storage.events.list({ limit: 1000, offset: 0 })).items.map((event) => event.id);
    expect(new Set(events).size).toBe(events.length);
  });

  it('keeps every provider key the same, so a configured client keeps working', async () => {
    const first = await boot();
    // Every credential set, Tingg's and Flutterwave v4's above all: those are
    // matched exactly, not by shape.
    const keysOf = (context: PayboxContext) => ({
      paystack: context.keys,
      stripe: context.stripeKeys,
      flutterwave: context.flutterwaveKeys,
      flutterwaveV4: context.flutterwaveV4,
      kora: context.koraKeys,
      quiddpay: context.quiddpayKeys,
      tingg: context.tinggKeys,
      wewire: context.wewireKeys,
      wise: context.wiseKeys,
      bachs: context.bachsKeys,
    });
    const keys = keysOf(first);
    await pay(first, 'one');
    const second = await restart(first);
    expect(keysOf(second)).toEqual(keys);
    const third = await restart(second);
    expect(keysOf(third)).toEqual(keys);
    // And the same as a fresh in-memory start.
    expect(keysOf(await boot(':memory:'))).toEqual(keys);
  });

  it('still lets a due job run after the restart, rather than dying on a duplicate id', async () => {
    const first = await boot();
    // A pending payment with an expiry schedules a job; several more ids
    // follow so the restart has plenty to replay into.
    const payment = await first.engine.createPayment({
      provider: 'paystack',
      amount: 1000,
      currency: 'NGN',
      reference: 'expires',
      status: 'pending',
      expiresInMs: 3_600_000,
    });
    for (let i = 0; i < 3; i++) await pay(first, `filler-${i}`);
    const second = await restart(first);
    second.clock.advance(3_600_000);
    await second.scheduler.drain();
    expect((await second.engine.getPayment(payment.id))?.status).toBe('expired');
  });

  it('is reproducible: the same seed and the same restarts mint the same ids', async () => {
    const run = async (db: string) => {
      const first = await boot(db);
      await pay(first, 'a');
      const second = await restart(first, db);
      const minted = (await pay(second, 'b')).id;
      open.splice(open.indexOf(second), 1);
      await second.shutdown();
      return minted;
    };
    const one = await run(join(dir, 'one.db'));
    const two = await run(join(dir, 'two.db'));
    expect(one).toBe(two);
  });

  it('leaves a fresh database and :memory: exactly as before', async () => {
    const fresh = await boot();
    const memory = await boot(':memory:');
    const a = (await pay(fresh, 'x')).id;
    const b = (await pay(memory, 'x')).id;
    expect(a).toBe(b);
  });

  it('treats a database written before boots were counted as booted already', async () => {
    const first = await boot();
    const before = [];
    for (let i = 0; i < 3; i++) before.push((await pay(first, `old-${i}`)).id);
    open.splice(open.indexOf(first), 1);
    await first.shutdown();
    // What an older paybox leaves: data, a clock, and no boot count.
    const raw = new DatabaseSync(database);
    raw.exec('DELETE FROM id_state; DELETE FROM clock_state;');
    raw.close();

    const second = await boot();
    const after = [];
    for (let i = 0; i < 3; i++) after.push((await pay(second, `new-${i}`)).id);
    expect(after.filter((id) => before.includes(id))).toEqual([]);
  });

  it('keeps counting through paybox reset', async () => {
    const first = await boot();
    await pay(first, 'kept');
    await first.storage.reset();
    const second = await restart(first);
    await pay(second, 'after-reset');
    const third = await restart(second);
    await expect(pay(third, 'after-two-restarts')).resolves.toBeDefined();
  });

  it('recognises an older database that holds only rows written without events', async () => {
    const first = await boot();
    const plan = await first.engine.createPlan({ provider: 'paystack', name: 'Basic', amount: 1000, currency: 'NGN', interval: 'monthly' });
    open.splice(open.indexOf(first), 1);
    await first.shutdown();
    const raw = new DatabaseSync(database);
    raw.exec('DELETE FROM id_state; DELETE FROM clock_state;');
    raw.close();
    const second = await boot();
    const next = await second.engine.createPlan({ provider: 'paystack', name: 'Pro', amount: 2000, currency: 'NGN', interval: 'monthly' });
    expect(next.id).not.toBe(plan.id);
    expect(next.providerPlanCode).not.toBe(plan.providerPlanCode);
  });

  it("does not repeat a provider's generated reference after a restart", async () => {
    const first = await boot();
    const second = await restart(first);
    // WeWire draws its fallback references from the context's random stream.
    const a = first.random.fork('probe').int(0, 1_000_000_000);
    const b = second.random.fork('probe').int(0, 1_000_000_000);
    expect(b).not.toBe(a);
  });
});

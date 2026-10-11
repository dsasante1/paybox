import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Virtual time across a restart on the same database.
 *
 * It used to live only in memory: every boot started again at
 * PAYBOX_START_AT, earlier than the events and jobs the previous process had
 * written. A restart now resumes where the clock was -- unless PAYBOX_START_AT
 * changed, which is the documented way to move to another date
 * (docs/time.md) and still works.
 */
const START = '2026-06-14T12:00:00.000Z';
const START_MS = Date.parse(START);
const HOUR = 3_600_000;

let dir: string;
let database: string;
const open: PayboxContext[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paybox-clock-'));
  database = join(dir, 'paybox.db');
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!.shutdown();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PAYBOX_START_AT;
  delete process.env.PAYBOX_FREEZE_CLOCK;
});

async function boot(env: { db?: string; startAt?: string | null; frozen?: boolean }): Promise<PayboxContext> {
  process.env.PAYBOX_DATABASE = env.db ?? database;
  process.env.PAYBOX_SEED = 'clock';
  if (env.frozen === false) delete process.env.PAYBOX_FREEZE_CLOCK;
  else process.env.PAYBOX_FREEZE_CLOCK = '1';
  if (env.startAt === null) delete process.env.PAYBOX_START_AT;
  else process.env.PAYBOX_START_AT = env.startAt ?? START;
  const { config } = loadConfig();
  const context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  open.push(context);
  return context;
}

async function restart(context: PayboxContext, env: Parameters<typeof boot>[0] = {}) {
  open.splice(open.indexOf(context), 1);
  await context.shutdown();
  return boot(env);
}

describe('a restart on the same database', () => {
  it('resumes a frozen clock where it was', async () => {
    const first = await boot({});
    first.clock.advance(2 * HOUR);
    const second = await restart(first);
    expect(second.clock.now()).toBe(START_MS + 2 * HOUR);
    expect(second.clock.state().mode).toBe('frozen');
  });

  it('is never earlier than what the previous process wrote', async () => {
    const first = await boot({});
    first.clock.advance(3 * HOUR);
    const payment = await first.engine.createPayment({
      provider: 'paystack',
      amount: 1000,
      currency: 'NGN',
      reference: 'written-late',
    });
    const second = await restart(first);
    expect(second.clock.now()).toBeGreaterThanOrEqual(Date.parse(payment.createdAt));
  });

  it('still fires a job that was due before the restart', async () => {
    const first = await boot({});
    // Expires in an hour; the process stops at +59m.
    const payment = await first.engine.createPayment({
      provider: 'paystack',
      amount: 1000,
      currency: 'NGN',
      reference: 'expires',
      status: 'pending',
      expiresInMs: HOUR,
    });
    first.clock.advance(59 * 60_000);
    await first.scheduler.drain();
    const second = await restart(first);
    second.clock.advance(60_000);
    await second.scheduler.drain();
    expect((await second.engine.getPayment(payment.id))?.status).toBe('expired');
  });

  it('honours a changed PAYBOX_START_AT, even an earlier one', async () => {
    const first = await boot({});
    first.clock.advance(5 * HOUR);
    const earlier = '2026-01-01T00:00:00.000Z';
    const second = await restart(first, { startAt: earlier });
    expect(second.clock.now()).toBe(Date.parse(earlier));
    // And that new start is now the one a further restart resumes from.
    second.clock.advance(HOUR);
    const third = await restart(second, { startAt: earlier });
    expect(third.clock.now()).toBe(Date.parse(earlier) + HOUR);
  });

  it('treats the same instant written differently as unchanged', async () => {
    const first = await boot({ startAt: '2026-06-14T12:00:00Z' });
    first.clock.advance(24 * HOUR);
    // The same instant with milliseconds, and with an offset.
    const second = await restart(first, { startAt: '2026-06-14T12:00:00.000Z' });
    expect(second.clock.now()).toBe(START_MS + 24 * HOUR);
    const third = await restart(second, { startAt: '2026-06-14T13:00:00+01:00' });
    expect(third.clock.now()).toBe(START_MS + 24 * HOUR);
  });

  it.each([
    ['past what a Date can hold', 9e15],
    ['past what the driver can read', 1e17],
  ])('starts afresh rather than refusing to boot on a recorded clock %s', async (_label, now) => {
    const first = await boot({});
    await first.storage.clock.put({
      state: { mode: 'frozen', now, offsetMs: 0 },
      configuredStartAt: START,
      updatedAt: START,
    });
    const second = await restart(first);
    expect(second.clock.now()).toBe(START_MS);
  });

  it('keeps an advance made with the clock flowing', async () => {
    const first = await boot({ frozen: false, startAt: null });
    first.clock.advance(10 * HOUR);
    const second = await restart(first, { frozen: false, startAt: null });
    // Real time plus the recorded offset: at least the ten hours, give or
    // take the few milliseconds the restart took.
    expect(second.clock.state().offsetMs).toBeGreaterThanOrEqual(10 * HOUR - 1_000);
    expect(second.clock.state().mode).toBe('system');
  });

  it('lets config choose the mode, carrying on from the recorded instant', async () => {
    const first = await boot({});
    first.clock.advance(HOUR);
    const second = await restart(first, { frozen: false });
    expect(second.clock.state().mode).toBe('system');
    expect(second.clock.now()).toBeGreaterThanOrEqual(START_MS + HOUR);
  });

  it('resumes after paybox reset, which clears data and leaves the clock', async () => {
    const first = await boot({});
    first.clock.advance(4 * HOUR);
    await first.storage.reset();
    const second = await restart(first);
    expect(second.clock.now()).toBe(START_MS + 4 * HOUR);
  });
});

describe('a fresh database', () => {
  it('starts at PAYBOX_START_AT, as it always has', async () => {
    const context = await boot({});
    expect(context.clock.now()).toBe(START_MS);
  });

  it('is what :memory: always is, so in-memory runs are unchanged', async () => {
    const first = await boot({ db: ':memory:' });
    first.clock.advance(HOUR);
    const second = await restart(first, { db: ':memory:' });
    expect(second.clock.now()).toBe(START_MS);
  });
});

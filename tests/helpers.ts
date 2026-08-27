import { openStorage } from '@paybox/storage';
import {
  EventBus,
  PaymentEngine,
  Scheduler,
  VirtualClock,
  type Storage,
} from '@paybox/core';
import { createIdFactory, createRandom, type IdFactory, type PayboxEvent } from '@paybox/shared';

export interface Harness {
  storage: Storage;
  clock: VirtualClock;
  ids: IdFactory;
  bus: EventBus;
  engine: PaymentEngine;
  scheduler: Scheduler;
  events: PayboxEvent[];
  close(): Promise<void>;
}

/**
 * A fully deterministic engine: in-memory database, frozen clock, fixed seed.
 * Every test starts from the same instant with the same id stream, so
 * assertions can be exact rather than approximate.
 */
export async function createHarness(
  options: { seed?: string; startAt?: string } = {},
): Promise<Harness> {
  const { storage } = await openStorage({ database: ':memory:' });
  const clock = new VirtualClock({
    startAt: options.startAt ?? '2026-01-01T12:00:00.000Z',
    frozen: true,
  });
  const random = createRandom(options.seed ?? 'test-seed');
  const ids = createIdFactory(random);
  const bus = new EventBus();
  const engine = new PaymentEngine({ storage, clock, ids, bus });
  const scheduler = new Scheduler({ storage, clock });

  const events: PayboxEvent[] = [];
  bus.onAny((event) => {
    events.push(event);
  });

  return {
    storage,
    clock,
    ids,
    bus,
    engine,
    scheduler,
    events,
    async close() {
      await scheduler.stop();
      await storage.close();
    },
  };
}

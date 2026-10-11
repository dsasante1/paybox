import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayboxEvent, ProviderId } from '@paybox/shared';
import { createHarness, type Harness } from './helpers.js';

/**
 * Two opt-in engine additions made for Bachs, pinned independently of it:
 *
 *  - `recordEvent` appends an informational event about a provider-owned
 *    resource the engine has no model for (a Bachs checkout session), with an
 *    optional projection write committed in the same transaction;
 *  - `updateCustomer(..., { event: true })` appends `customer.updated`, while
 *    the default call stays silent so every other adapter's event log is
 *    byte-identical to before.
 */
const BACHS = 'bachs' as ProviderId;

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('engine.recordEvent', () => {
  it('appends an informational checkout event and runs apply in the same transaction', async () => {
    const now = harness.clock.nowISO();
    const { event, result } = await harness.engine.recordEvent({
      provider: BACHS,
      type: 'checkout.completed',
      resourceType: 'checkout',
      resourceId: 'chk_1',
      data: { checkout_id: 'chk_1' },
      apply: async (tx) => {
        await tx.providerState.put(BACHS, 'checkout:chk_1', '{"status":"completed"}', now);
        return 42;
      },
    });

    expect(result).toBe(42);
    expect(event).toMatchObject({
      type: 'checkout.completed',
      provider: BACHS,
      resourceType: 'checkout',
      resourceId: 'chk_1',
      data: { checkout_id: 'chk_1' },
      previousStatus: null,
      currentStatus: null,
      sequence: 1,
      createdAt: now,
    });

    const log = await harness.storage.events.listByResource('chk_1');
    expect(log).toEqual([event]);
    expect(await harness.storage.providerState.get(BACHS, 'checkout:chk_1')).toBe('{"status":"completed"}');
    expect(harness.events).toEqual([event]);
  });

  it('works without apply, and keeps per-resource sequences gapless', async () => {
    const first = await harness.engine.recordEvent({
      provider: BACHS,
      type: 'checkout.expired',
      resourceType: 'checkout',
      resourceId: 'chk_2',
      data: {},
    });
    const second = await harness.engine.recordEvent({
      provider: BACHS,
      type: 'checkout.completed',
      resourceType: 'checkout',
      resourceId: 'chk_2',
      data: {},
    });
    expect(first.result).toBeUndefined();
    expect([first.event.sequence, second.event.sequence]).toEqual([1, 2]);
  });

  it('appends nothing, writes nothing and emits nothing when apply throws', async () => {
    const now = harness.clock.nowISO();
    await expect(
      harness.engine.recordEvent({
        provider: BACHS,
        type: 'checkout.completed',
        resourceType: 'checkout',
        resourceId: 'chk_3',
        data: {},
        apply: async (tx) => {
          await tx.providerState.put(BACHS, 'checkout:chk_3', 'half-written', now);
          throw new Error('projection failed');
        },
      }),
    ).rejects.toThrow('projection failed');

    expect(await harness.storage.events.listByResource('chk_3')).toEqual([]);
    expect(await harness.storage.providerState.get(BACHS, 'checkout:chk_3')).toBeNull();
    expect(harness.events).toEqual([]);
  });

  it('reaches the bus only after commit: a subscriber reads the applied state and the event', async () => {
    const seen: Array<{ state: string | null; logged: number }> = [];
    harness.bus.onAny(async (event: PayboxEvent) => {
      if (event.resourceId !== 'chk_4') return;
      seen.push({
        state: await harness.storage.providerState.get(BACHS, 'checkout:chk_4'),
        logged: (await harness.storage.events.listByResource('chk_4')).length,
      });
    });

    const now = harness.clock.nowISO();
    await harness.engine.recordEvent({
      provider: BACHS,
      type: 'checkout.expired',
      resourceType: 'checkout',
      resourceId: 'chk_4',
      data: {},
      apply: async (tx) => {
        await tx.providerState.put(BACHS, 'checkout:chk_4', 'expired', now);
        // Nothing may have been published yet while the transaction is open.
        expect(harness.events).toEqual([]);
      },
    });

    expect(seen).toEqual([{ state: 'expired', logged: 1 }]);
  });
});

describe('engine.updateCustomer', () => {
  async function customer() {
    const created = await harness.engine.createCustomer({ provider: BACHS, email: 'ada@example.com' });
    expect(harness.events.map((e) => e.type)).toEqual(['customer.created']);
    return created;
  }

  it('appends no event by default, exactly as before', async () => {
    const created = await customer();
    const updated = await harness.engine.updateCustomer(created.id, { firstName: 'Ada' });
    expect(updated.firstName).toBe('Ada');
    expect((await harness.storage.events.listByResource(created.id)).map((e) => e.type)).toEqual([
      'customer.created',
    ]);
    expect(harness.events.map((e) => e.type)).toEqual(['customer.created']);
  });

  it('with { event: true } appends exactly one customer.updated and emits it', async () => {
    const created = await customer();
    const updated = await harness.engine.updateCustomer(
      created.id,
      { email: 'ada.okafor@example.com' },
      { event: true },
    );
    expect(updated.email).toBe('ada.okafor@example.com');

    const log = await harness.storage.events.listByResource(created.id);
    expect(log.map((e) => e.type)).toEqual(['customer.created', 'customer.updated']);
    const event = log[1]!;
    expect(event).toMatchObject({
      provider: BACHS,
      resourceType: 'customer',
      resourceId: created.id,
      previousStatus: null,
      currentStatus: null,
      sequence: 2,
      data: { id: created.id, email: 'ada.okafor@example.com' },
    });
    expect(harness.events.map((e) => e.type)).toEqual(['customer.created', 'customer.updated']);
    expect(harness.events[1]).toEqual(event);
  });
});

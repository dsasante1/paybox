import { describe, expect, it } from 'vitest';
import {
  assertPaymentTransition,
  assertRefundable,
  canTransitionPayment,
  isTerminalPayment,
  nextPaymentStates,
  refundedStatus,
} from '@paybox/core';
import { PAYMENT_STATUSES, type PaymentStatus } from '@paybox/shared';

describe('payment state machine (spec §7)', () => {
  it('treats failed, cancelled, expired and refunded as terminal', () => {
    for (const status of ['failed', 'cancelled', 'expired', 'refunded'] as PaymentStatus[]) {
      expect(isTerminalPayment(status)).toBe(true);
      expect(nextPaymentStates(status)).toHaveLength(0);
    }
  });

  it('never allows a self-transition', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(() => assertPaymentTransition(status, status)).toThrow(/already/i);
    }
  });

  it('rejects failed -> successful without an explicit reversal', () => {
    expect(canTransitionPayment('failed', 'successful')).toBe(false);
    expect(() => assertPaymentTransition('failed', 'successful')).toThrow(
      /terminal|Cannot move/i,
    );
    // The one documented escape hatch.
    expect(() => assertPaymentTransition('failed', 'successful', { reversal: true })).not.toThrow();
  });

  it('only allows a reversal out of a terminal state', () => {
    // A reversal is not a general override: pending -> refunded is still wrong.
    expect(() => assertPaymentTransition('pending', 'refunded', { reversal: true })).toThrow();
  });

  it('reaches every non-initial status from created', () => {
    // Guards against a status being added to the enum but orphaned in the table.
    const reachable = new Set<PaymentStatus>(['created']);
    let changed = true;
    while (changed) {
      changed = false;
      for (const from of [...reachable]) {
        for (const to of nextPaymentStates(from)) {
          if (!reachable.has(to)) {
            reachable.add(to);
            changed = true;
          }
        }
      }
    }
    expect([...PAYMENT_STATUSES].filter((s) => !reachable.has(s))).toEqual([]);
  });

  it('models the authorize -> capture path', () => {
    expect(canTransitionPayment('pending', 'authorized')).toBe(true);
    expect(canTransitionPayment('authorized', 'processing')).toBe(true);
    expect(canTransitionPayment('processing', 'successful')).toBe(true);
    // Voiding an authorization.
    expect(canTransitionPayment('authorized', 'cancelled')).toBe(true);
  });
});

describe('refund arithmetic (spec §18)', () => {
  it('enforces total_refunded <= amount', () => {
    expect(() => assertRefundable(10_000, 0, 10_000)).not.toThrow();
    expect(() => assertRefundable(10_000, 6_000, 4_000)).not.toThrow();
    expect(() => assertRefundable(10_000, 6_000, 4_001)).toThrow(/exceeds/);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => assertRefundable(10_000, 0, 0)).toThrow(/greater than zero/);
    expect(() => assertRefundable(10_000, 0, -1)).toThrow(/greater than zero/);
  });

  it('picks partially_refunded until the balance is exhausted', () => {
    expect(refundedStatus(10_000, 1)).toBe('partially_refunded');
    expect(refundedStatus(10_000, 9_999)).toBe('partially_refunded');
    expect(refundedStatus(10_000, 10_000)).toBe('refunded');
  });
});

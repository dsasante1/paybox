import type { Payment } from '@paybox/shared';
import { minorUnitExponent } from '@paybox/shared';
import type { Storage } from '@paybox/core';
import { paymentPot } from './actor.js';
import { fail } from './errors.js';
import { toDecimal } from './money.js';

/**
 * A checkout's split (connect/split-payments, the pinned
 * CreateCheckoutSessionRequest).
 *
 *   direct       X-Account-Id: the account's sale, `platform_fee` its cut.
 *   destination  `transfer_data.destination`: the platform's sale, with the
 *                seller's share sent on settlement -- fee-first
 *                (`platform_fee`) or share-first (`transfer_data.amount`).
 *   none         neither: a `platform_fee` here "has no effect", though it is
 *                still checked.
 *
 * Amounts are minor units of the sale's base currency, as sent.
 */
export interface StoredSplit {
  kind: 'direct' | 'destination' | 'none';
  /** The platform's cut, fee-first; null on a share-first split. */
  platformFee: number | null;
  /** The seller's account on a destination charge. */
  destination: string | null;
  /** The seller's share, share-first; null on a fee-first split. */
  destinationAmount: number | null;
  currency: string;
}

/**
 * A split amount: "rounded half-up to the currency's minor unit", and refused
 * if that leaves nothing ("`0.001` USD" is INVALID_PLATFORM_FEE).
 */
export function splitAmount(value: string, currency: string, field: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: must be a positive decimal string.`);
  const exponent = minorUnitExponent(currency);
  const fraction = (match[2] ?? '').padEnd(exponent + 1, '0');
  const kept = BigInt(`${match[1]}${fraction.slice(0, exponent)}`);
  const next = Number(fraction[exponent] ?? '0');
  const minor = Number(kept + (next >= 5 ? 1n : 0n));
  if (minor <= 0) {
    throw fail('validation_failed', 'INVALID_PLATFORM_FEE', `${field}: rounds to less than one minor unit of ${currency}.`);
  }
  return minor;
}

/** Bounds every split amount answers to: above zero, below the gross. */
export function assertWithinGross(amount: number, gross: number | null, field: string): void {
  if (gross !== null && amount >= gross) {
    throw fail('validation_failed', 'INVALID_PLATFORM_FEE', `${field}: must be less than the sale's total.`);
  }
}

/** `platform_fee` and `destination_amount`, each null unless it was the term sent. */
export function splitView(split: StoredSplit | null | undefined) {
  return {
    platform_fee: split?.platformFee != null ? toDecimal(split.platformFee, split.currency) : null,
    destination_amount: split?.destinationAmount != null ? toDecimal(split.destinationAmount, split.currency) : null,
  };
}

/**
 * `fee_paid_by`: "read back from the ledger posting rather than a flag
 * decided in advance". `null` until the fee is posted, `platform` when the
 * platform's own balance paid an account's direct charge, `merchant`
 * otherwise -- "on a destination charge this never reads `platform`".
 */
export async function feePaidByOf(storage: Storage, payment: Payment): Promise<'merchant' | 'platform' | null> {
  const entries = await storage.ledger.list({ provider: 'bachs', limit: 500, resourceId: payment.id });
  const posting = entries.items.find((entry) => entry.reason === 'processing_fee' && entry.resourceId === payment.id);
  if (!posting) return null;
  if (payment.settlementMode === 'direct' && (posting.subaccountId ?? null) !== paymentPot(payment)) return 'platform';
  return 'merchant';
}

/**
 * Who holds the fixed part of a split sale and who holds the rest. The fixed
 * part is the platform's cut on a fee-first split (direct or destination), or
 * the seller's share on a share-first one; whoever holds the rest takes any
 * difference between what was asked and what arrived, as far as their part
 * goes ("let the platform absorb any variance in the total" is share-first's
 * half of the same rule). Null for a sale with no split.
 */
export function splitParts(
  payment: Payment,
  split: StoredSplit | null | undefined,
): { fixed: number; fixedPot: string | null; restPot: string | null } | null {
  if (payment.settlementMode === 'direct' && payment.platformFee > 0) {
    return { fixed: payment.platformFee, fixedPot: null, restPot: payment.subaccountId };
  }
  if (payment.settlementMode === 'forwarded' && payment.subaccountId) {
    if (split?.platformFee != null) return { fixed: payment.platformFee, fixedPot: null, restPot: payment.subaccountId };
    return { fixed: payment.amount - payment.platformFee, fixedPot: payment.subaccountId, restPot: null };
  }
  return null;
}

/**
 * What a split sale of which `paid` arrived left one party, before fees and
 * refunds: the fixed part, as far as what arrived covers it, or the rest.
 */
export function keptBy(
  pot: string | null,
  paid: number,
  parts: { fixed: number; fixedPot: string | null; restPot: string | null },
): number {
  if (pot === parts.fixedPot) return Math.min(parts.fixed, paid);
  if (pot === parts.restPot) return Math.max(0, paid - parts.fixed);
  return 0;
}

import { createHash } from 'node:crypto';

/**
 * Wise's numeric ids, derived from paybox's string ids.
 *
 * Wise types profiles, recipients, transfers, balances and payments as
 * `integer, format: int64`, while paybox's own ids are prefixed base32 tokens
 * (`trf_zj4bw86…`). Something has to bridge that, and there are two ways to
 * do it: a monotonic counter, or a hash.
 *
 * This uses a hash, for the same reason `numericTransactionId` does in the
 * Paystack adapter: a counter is deterministic but **order-fragile**. Insert
 * one extra transfer at the head of a test and every later id shifts, so any
 * assertion on a literal id breaks for a reason that has nothing to do with
 * the thing under test. A hash is stable under reordering, which is what lets
 * the compat suites assert exact values.
 *
 * The cost is that ids are not sequential, which no Wise client should depend
 * on anyway — the spec calls them identifiers, not sequence numbers.
 * `docs/wise.md` records the choice.
 *
 * Values are kept below 2^40 so they stay comfortably inside a JSON-safe
 * integer while still being wide enough that a collision is not a practical
 * concern at emulator scale.
 */
const RANGE = 2 ** 40;

export function numericId(id: string): number {
  const digest = createHash('sha256').update(id).digest();
  // Six bytes, big-endian, offset so nothing lands on a suspicious-looking
  // small number that might be mistaken for a fixture.
  const value = digest.readUIntBE(0, 6) % RANGE;
  return 1_000_000 + value;
}

/**
 * Wise's quote ids are UUIDs, not integers, so they get their own derivation.
 *
 * Formatted as a v4-shaped UUID: the version and variant nibbles are set the
 * way a real one would be, because a client validating the shape should pass.
 * It is derived, not random — the same paybox id always yields the same UUID.
 */
export function derivedUuid(id: string, namespace = 'wise'): string {
  const hex = createHash('sha256').update(`${namespace}:${id}`).digest('hex');
  const version = `4${hex.slice(13, 16)}`;
  // Variant 10xx: one of 8, 9, a, b.
  const variant = `${'89ab'[parseInt(hex[16] as string, 16) % 4]}${hex.slice(17, 20)}`;
  return [hex.slice(0, 8), hex.slice(8, 12), version, variant, hex.slice(20, 32)].join('-');
}

/**
 * Find the paybox id behind a numeric one.
 *
 * A hash is one-way, so resolution is a scan of the candidates. That is
 * acceptable here and nowhere near a hot path: the emulator holds a
 * developer's test data, not a ledger of millions.
 */
export function resolveNumeric<T extends { id: string }>(
  items: readonly T[],
  wanted: number | string,
): T | undefined {
  const target = Number(wanted);
  if (!Number.isFinite(target)) {
    return items.find((item) => item.id === wanted);
  }
  return items.find((item) => numericId(item.id) === target);
}

export function resolveUuid<T extends { id: string }>(
  items: readonly T[],
  wanted: string,
  namespace = 'wise',
): T | undefined {
  return items.find((item) => item.id === wanted || derivedUuid(item.id, namespace) === wanted);
}

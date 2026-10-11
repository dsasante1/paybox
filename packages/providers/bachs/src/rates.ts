/**
 * Bachs' exchange rate, fixed.
 *
 * Bachs converts at "the prevailing rate" (charge-a-saved-card, read
 * 2026-10-10), which moves; a moving rate would break paybox's same-seed,
 * same-output promise. So the rate is a constant, and docs/bachs.md says so.
 *
 * 1,500 NGN to the US dollar is the figure Bachs' own worked examples use most
 * often (its conversion and payout guides use 1,500 and 1,650). One rate, no
 * spread: Bachs publishes no bid/ask split.
 *
 * Amounts stay integer minor units on both sides (CLAUDE.md, "No FX
 * conversion ever happens" in the engine): the adapter quotes, and records
 * what it quoted.
 */
export const NGN_PER_USD = 1_500;

/** Currencies the table can convert between. */
export const CONVERTIBLE = ['USD', 'NGN'] as const;

export function canConvert(from: string, to: string): boolean {
  return (
    (CONVERTIBLE as readonly string[]).includes(from) && (CONVERTIBLE as readonly string[]).includes(to)
  );
}

/**
 * Convert minor units of `from` into minor units of `to`, rounded half-up.
 * USD and NGN both have two decimal places, so the minor-unit ratio is the
 * major-unit one.
 */
export function convertMinor(amount: number, from: string, to: string): number {
  if (from === to) return amount;
  if (from === 'USD' && to === 'NGN') return amount * NGN_PER_USD;
  if (from === 'NGN' && to === 'USD') return Math.floor((amount * 2 + NGN_PER_USD) / (2 * NGN_PER_USD));
  throw new Error(`No rate from ${from} to ${to}.`);
}

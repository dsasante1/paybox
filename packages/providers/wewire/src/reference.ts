import { PayboxError } from '@paybox/shared';

/**
 * Per-rail `reference` validation.
 *
 * The reference travels with the payout to the receiving bank, so the payment
 * network — not WeWire — sets the character set and length. WeWire publishes
 * both patterns verbatim, and reproducing them is one of the more valuable
 * things this adapter does: a reference that is fine on SEPA and rejected on
 * Faster Payments is exactly the failure a developer would otherwise discover
 * in production, days after the code shipped.
 *
 * Patterns transcribed from docs.wewire.com/common-workflows/send-a-payout
 * ("Reference format", read 2026-08-29).
 */

/**
 * EUR over SEPA / SEPA Instant: 1–140 chars, no leading or trailing space.
 *
 * One deliberate departure from WeWire's published regex. Its prose lists the
 * allowed set as *"A–Z, a–z, 0–9, spaces, and `+ - / ? _ . : , ( ) '`"* and
 * its GBP section calls out `payment_q2` as something to fix **for Faster
 * Payments** — implying underscores are fine on SEPA. But the regex it labels
 * "Pattern (for tooling)" omits `_` from the first and middle character
 * classes while including it in the last, which no real character set does.
 *
 * That is a typo in their pattern, not a rule. paybox follows the prose and
 * the worked examples, and docs/wewire.md records the discrepancy — rejecting
 * a reference the real API accepts would be the worse failure of the two.
 */
const SEPA = /^[A-Za-z0-9+\-/?_.:,()'][A-Za-z0-9+\-/?_.:,()' ]{0,138}[A-Za-z0-9+\-/?_.:,()']$/;

/** GBP over Faster Payments: 1–18 chars, a much smaller character set. */
const FPS = /^[ a-zA-Z0-9,.-]{1,18}$/;

/**
 * A single character is legal on both rails but matches neither pattern
 * above, because each is written as first-char / middle / last-char. WeWire's
 * stated length limits start at 1, so the one-character case is allowed
 * explicitly rather than by loosening the published regex.
 */
const SEPA_SINGLE = /^[A-Za-z0-9+\-/?_.:,()']$/;
const FPS_SINGLE = /^[a-zA-Z0-9,.-]$/;

export function assertReferenceForRail(reference: string, destinationCurrency: string): void {
  if (destinationCurrency === 'EUR') {
    if (SEPA.test(reference) || SEPA_SINGLE.test(reference)) return;
    throw new PayboxError(
      'validation_failed',
      'reference is not valid for SEPA. Use 1–140 characters from A–Z, a–z, 0–9, ' +
        "spaces and + - / ? _ . : , ( ) ' , and do not start or end with a space.",
      { details: { wewireCode: 'VALIDATION_FAILED', field: 'reference' } },
    );
  }

  if (destinationCurrency === 'GBP') {
    if (FPS.test(reference) || FPS_SINGLE.test(reference)) return;
    throw new PayboxError(
      'validation_failed',
      'reference is not valid for Faster Payments. Use 1–18 characters from A–Z, a–z, ' +
        '0–9, spaces, comma, period and hyphen.',
      { details: { wewireCode: 'VALIDATION_FAILED', field: 'reference' } },
    );
  }

  // USD (ACH/WIRE/SWIFT): WeWire publishes no pattern, so paybox enforces
  // none. Inventing one would fail requests the real API accepts.
}

/**
 * The fallback when no reference is given: *"we'll use our own 16-digit
 * transaction id, which works for every rail."*
 *
 * Drawn from the injected Random, so it is reproducible under a fixed seed
 * like every other generated id in paybox.
 */
export function fallbackReference(draw: (max: number) => number): string {
  let digits = '';
  for (let index = 0; index < 16; index += 1) digits += String(draw(10));
  return digits;
}

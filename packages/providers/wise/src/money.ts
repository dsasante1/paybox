import { PayboxError, minorUnitExponent } from '@paybox/shared';

/**
 * The decimal boundary (spec §22).
 *
 * Wise quotes and transfers carry decimal amounts (`sourceAmount: 100`,
 * `targetAmount: 129.24`), so this file is the whole of the conversion and
 * nothing beyond the adapter ever sees a float.
 *
 * As everywhere else in paybox, `toMinor` **rounds** rather than truncating:
 * `129.24 * 100` is 12923.999999999998 in IEEE-754, and a truncating
 * conversion would quietly lose a cent on amounts like this one — which is
 * Wise's own published example.
 */
export function toMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) {
    throw new PayboxError('validation_failed', 'amount must be a finite number.');
  }
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(amount * factor);
  if (minor <= 0) {
    throw new PayboxError('validation_failed', 'amount must be greater than zero.');
  }
  return minor;
}

/** Minor units -> the decimal number Wise puts on a quote or transfer. */
export function toMajor(minorUnits: number, currency = 'GBP'): number {
  const exponent = minorUnitExponent(currency);
  return Number((minorUnits / 10 ** exponent).toFixed(exponent));
}

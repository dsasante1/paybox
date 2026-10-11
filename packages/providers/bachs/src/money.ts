import { PayboxError, minorUnitExponent } from '@paybox/shared';

/**
 * The decimal boundary.
 *
 * Bachs is emphatic: "Money is a decimal string. Amounts are sent and returned
 * as strings with two decimal places in the currency's major unit: `"29.00"`
 * for $29.00 ... Never send a number, and never use minor units (cents)."
 * (docs.bachs.io/api-reference/api-standards, read 2026-10-10.)
 *
 * Core stores integer minor units, so this file is the whole of the
 * conversion. Parsing is done on the string's digits rather than through a
 * float, so `"19.99"` is 1999 exactly and nothing is ever rounded: an amount
 * finer than the currency can hold is refused, never silently shaved.
 *
 * Output always carries two decimal places, including for a zero-decimal
 * currency (`"5000.00"` XAF): Bachs states the two-place rule for every
 * currency and publishes no exception.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export class AmountError extends PayboxError {
  constructor(field: string, message: string) {
    super('validation_failed', message, {
      details: { bachsCode: 'VALIDATION_ERROR', field },
    });
  }
}

/**
 * A Bachs decimal string -> integer minor units.
 *
 * `allowZero` is for the places Bachs allows `"0.00"`: a pay-what-you-want
 * minimum ("Set `"0.00"` to allow free") and nothing else.
 */
export function toMinor(
  value: string,
  currency: string,
  field = 'amount',
  options: { allowZero?: boolean } = {},
): number {
  const match = DECIMAL.exec(value.trim());
  if (!match) {
    throw new AmountError(
      field,
      `${field}: must be a decimal string such as "29.00", got ${JSON.stringify(value)}.`,
    );
  }
  const exponent = minorUnitExponent(currency);
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  // Trailing zeros carry no value, so "5000.00" is a whole number of XAF.
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > exponent || fraction.length > 2) {
    throw new AmountError(
      field,
      `${field}: ${currency} amounts allow at most ${Math.min(exponent, 2)} decimal places, got "${value}".`,
    );
  }
  const minor = Number(whole) * 10 ** exponent + Number(significant.padEnd(exponent, '0') || '0');
  if (!Number.isSafeInteger(minor)) {
    throw new AmountError(field, `${field}: "${value}" is too large.`);
  }
  if (minor === 0 && !options.allowZero) {
    throw new AmountError(field, `${field}: must be greater than zero.`);
  }
  return minor;
}

/** Integer minor units -> Bachs' two-place decimal string. */
export function toDecimal(minor: number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const major = minor / 10 ** exponent;
  return major.toFixed(2);
}

/** `toDecimal` for a nullable amount. */
export function toDecimalOrNull(minor: number | null | undefined, currency: string): string | null {
  return minor === null || minor === undefined ? null : toDecimal(minor, currency);
}

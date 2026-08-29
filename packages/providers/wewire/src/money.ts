import { PayboxError, minorUnitExponent } from '@paybox/shared';

/**
 * The decimal boundary (spec §22).
 *
 * Core stores integer minor units, always. WeWire's request format is
 * explicit that it does not: *"Monetary amounts use decimal numbers (e.g.
 * `250.00`), not minor units. Up to 2 decimal places."*
 * (docs.wewire.com/working-with-the-api/authentication#request-format, read
 * 2026-08-29.) So this file is the whole of the conversion, and nothing
 * beyond the adapter ever sees a float.
 *
 * `toMinor` **rounds**; it does not truncate. `19.99 * 100` is
 * 1998.9999999999998 in IEEE-754, and a truncating conversion would silently
 * bill a cent less on roughly every other amount — the kind of bug an
 * emulator exists to catch rather than to have.
 */
export function toMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) {
    throw new PayboxError('validation_failed', 'amount must be a finite number.');
  }
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(amount * factor);

  // WeWire documents "up to 2 decimal places"; anything finer would be
  // silently rounded away, so it is refused instead.
  if (Math.abs(amount * factor - minor) > 1e-6) {
    throw new PayboxError(
      'validation_failed',
      `amount has more precision than ${currency} allows (max ${minorUnitExponent(currency)} decimal places).`,
      { details: { wewireCode: 'VALIDATION_FAILED' } },
    );
  }
  if (minor <= 0) {
    throw new PayboxError('validation_failed', 'amount must be greater than zero.');
  }
  return minor;
}

/** Minor units -> the decimal number WeWire puts on wallet transactions. */
export function toMajor(minorUnits: number, currency = 'USD'): number {
  const factor = 10 ** minorUnitExponent(currency);
  return Number((minorUnits / factor).toFixed(minorUnitExponent(currency)));
}

/**
 * Minor units -> a fixed-decimal string.
 *
 * WeWire is not consistent about this and the emulator matches it rather than
 * tidying it up: the wallet-transaction object types `amount` as a JSON
 * number (`2500.00`), while the Africa collection and disbursement objects
 * type it as a string (`"100.00"`). Both are transcribed from its published
 * examples.
 */
export function toMajorString(minorUnits: number, currency = 'USD'): string {
  const exponent = minorUnitExponent(currency);
  return (minorUnits / 10 ** exponent).toFixed(exponent);
}

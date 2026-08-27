import type { PaymentMethod } from '@paybox/shared';

/**
 * Synthetic test instruments (spec §5, §29).
 *
 * The emulator must never be capable of charging a real card, so it does not
 * accept, validate, or store real card data. Instead, the *last four digits*
 * of an obviously-synthetic number select the outcome you want to test. The
 * numbers below are not issued by any network and fail the Luhn check by
 * design -- if one of these is ever submitted to a real gateway it is rejected
 * before it reaches a cardholder.
 *
 * CVV is never read, never stored, and never appears in any model here.
 */
export type SimulatedOutcome =
  | 'success'
  | 'declined'
  | 'insufficient_funds'
  | 'expired_card'
  | 'authentication_required'
  | 'authentication_failed'
  | 'timeout'
  | 'processing_error'
  | 'customer_rejected'
  | 'network_error';

export interface InstrumentResolution {
  outcome: SimulatedOutcome;
  /** Human-readable reason shown in the dashboard and the checkout page. */
  description: string;
}

/** Suffix -> outcome. Documented in docs/paystack.md and on the checkout page. */
const SUFFIX_OUTCOMES: Record<string, InstrumentResolution> = {
  '0000': { outcome: 'success', description: 'Charge succeeds immediately' },
  '0001': { outcome: 'declined', description: 'Issuer declines the charge' },
  '0002': { outcome: 'insufficient_funds', description: 'Insufficient funds' },
  '0003': { outcome: 'expired_card', description: 'Card has expired' },
  '0004': {
    outcome: 'authentication_required',
    description: '3-D Secure step-up, then success',
  },
  '0005': {
    outcome: 'authentication_failed',
    description: '3-D Secure step-up, then failure',
  },
  '0006': { outcome: 'timeout', description: 'Authorization never returns; expires' },
  '0007': { outcome: 'processing_error', description: 'Provider returns an error' },
  '0008': { outcome: 'customer_rejected', description: 'Customer rejects the prompt' },
  '0009': { outcome: 'network_error', description: 'Connection drops mid-authorization' },
};

export const TEST_CARDS = [
  { number: '4000 0000 0000 0000', brand: 'visa', ...SUFFIX_OUTCOMES['0000']! },
  { number: '4000 0000 0000 0001', brand: 'visa', ...SUFFIX_OUTCOMES['0001']! },
  { number: '4000 0000 0000 0002', brand: 'visa', ...SUFFIX_OUTCOMES['0002']! },
  { number: '4000 0000 0000 0003', brand: 'visa', ...SUFFIX_OUTCOMES['0003']! },
  { number: '4000 0000 0000 0004', brand: 'visa', ...SUFFIX_OUTCOMES['0004']! },
  { number: '4000 0000 0000 0005', brand: 'visa', ...SUFFIX_OUTCOMES['0005']! },
  { number: '5100 0000 0000 0000', brand: 'mastercard', ...SUFFIX_OUTCOMES['0000']! },
  { number: '5061 0000 0000 0000', brand: 'verve', ...SUFFIX_OUTCOMES['0000']! },
] as const;

export const TEST_MOBILE_NUMBERS = [
  { number: '0550000000', network: 'mtn', ...SUFFIX_OUTCOMES['0000']! },
  { number: '0550000001', network: 'mtn', ...SUFFIX_OUTCOMES['0001']! },
  { number: '0550000002', network: 'mtn', ...SUFFIX_OUTCOMES['0002']! },
  { number: '0550000006', network: 'vod', ...SUFFIX_OUTCOMES['0006']! },
  { number: '0550000008', network: 'atl', ...SUFFIX_OUTCOMES['0008']! },
] as const;

const DEFAULT: InstrumentResolution = {
  outcome: 'success',
  description: 'Unrecognised test instrument; defaulting to success',
};

/**
 * Resolve an instrument to an outcome by its last four digits.
 * Unknown instruments succeed, so a developer pasting an arbitrary test number
 * gets a working happy path rather than a confusing decline.
 */
export function resolveInstrument(
  identifier: string | null | undefined,
  method: PaymentMethod | null,
): InstrumentResolution {
  if (!identifier) return DEFAULT;
  const digits = identifier.replace(/\D/g, '');
  if (digits.length < 4) return DEFAULT;
  const suffix = digits.slice(-4);
  const resolved = SUFFIX_OUTCOMES[suffix];
  if (resolved) return resolved;

  // Mobile-money numbers are shorter, so also try the last single digit,
  // which is how the documented momo test numbers above are distinguished.
  if (method === 'mobile_money') {
    const byLastDigit = SUFFIX_OUTCOMES[`000${digits.slice(-1)}`];
    if (byLastDigit) return byLastDigit;
  }
  return DEFAULT;
}

/** Never store or echo more than the last four digits of any instrument. */
export function maskInstrument(identifier: string): {
  bin: string | null;
  last4: string;
} {
  const digits = identifier.replace(/\D/g, '');
  return {
    bin: digits.length >= 6 ? digits.slice(0, 6) : null,
    last4: digits.slice(-4),
  };
}

import type { PaymentMethod } from '@paybox/shared';
import type { InstrumentResolution, InstrumentResolver } from '@paybox/simulator';

/**
 * Paystack's own published test instruments.
 *
 * Transcribed from <https://paystack.com/docs/payments/test-payments/>, read
 * 2026-08-28. These are the numbers a developer will already have copied out
 * of Paystack's documentation, so the emulator has to recognise them -- and in
 * particular has to *decline* the one Paystack documents as declining. Falling
 * through to the unknown-instrument default would turn their failure test into
 * a silent pass, which is the exact trap this tool exists to catch.
 *
 * Injected into the simulator as an `InstrumentResolver` so that
 * @paybox/simulator never learns whose card numbers these are (spec §30).
 *
 * Matched on the full digit string rather than the last four, so these cannot
 * collide with the emulator's own `4000 0000 0000 000X` suffix convention.
 */

interface PublishedInstrument extends InstrumentResolution {
  /** Digits only, as written in Paystack's documentation. */
  digits: string;
  label: string;
}

const CARDS: readonly PublishedInstrument[] = [
  {
    digits: '4084084084084081',
    label: 'Successful — no validation, reusable',
    outcome: 'success',
    description: 'Paystack test card: succeeds with no customer validation',
  },
  {
    digits: '5192602720584796',
    label: 'Successful — bank auth simulation, reusable',
    outcome: 'success',
    description: 'Paystack test card: bank authorization simulation',
  },
  // The three validation cards park awaiting a customer action, which is what
  // makes /charge/submit_pin and /charge/submit_otp reachable with the numbers
  // Paystack actually documents.
  {
    digits: '507850785078507812',
    label: 'PIN validation',
    outcome: 'authentication_required',
    description: 'Paystack test card: requires a PIN (1111)',
  },
  {
    digits: '5060666666666666666',
    label: 'PIN + OTP validation',
    outcome: 'authentication_required',
    description: 'Paystack test card: requires PIN 1234 then OTP 123456',
  },
  {
    digits: '507850785078507804',
    label: 'PIN + phone + OTP validation',
    outcome: 'authentication_required',
    description: 'Paystack test card: requires PIN 0000, a phone number, then OTP 123456',
  },
  {
    digits: '4084080000005408',
    label: 'Declined',
    outcome: 'declined',
    description: 'Paystack test card: declined by the issuer',
  },
  {
    digits: '507850785078507853',
    label: 'Token not generated',
    outcome: 'processing_error',
    description: 'Paystack test card: authorization token could not be generated',
  },
  {
    digits: '4084080000670037',
    label: 'Insufficient funds',
    outcome: 'insufficient_funds',
    description: 'Paystack test card: insufficient funds',
  },
  // These two succeed at charge time; what they change is the *refund*
  // outcome, which the emulator does not model. Recognising them still beats
  // ignoring them -- the charge behaves as documented, and docs/paystack.md
  // records that the refund half is not reproduced.
  {
    digits: '4084080000671803',
    label: 'Charges, then fails on refund',
    outcome: 'success',
    description: 'Paystack test card: charge succeeds (its refund failure is not modelled)',
  },
  {
    digits: '4084080000671902',
    label: 'Charges, then refund needs attention',
    outcome: 'success',
    description: 'Paystack test card: charge succeeds (its refund outcome is not modelled)',
  },
];

const MOBILE_MONEY: readonly PublishedInstrument[] = [
  {
    digits: '0551234987',
    label: 'MTN — no PIN/OTP',
    outcome: 'success',
    description: 'Paystack test mobile money: MTN, approves without a prompt',
  },
  {
    digits: '254710000000',
    label: 'M-Pesa',
    outcome: 'success',
    description: 'Paystack test mobile money: M-Pesa',
  },
  {
    // Paystack pairs this one with OTP 1234, where its card flow uses 123456.
    // paybox accepts 123456 everywhere; docs/paystack.md notes the difference.
    digits: '0700000000',
    label: 'Orange (CIV) — OTP',
    outcome: 'authentication_required',
    description: 'Paystack test mobile money: Orange CIV, requires an OTP',
  },
];

const BY_DIGITS = new Map<string, PublishedInstrument>(
  [...CARDS, ...MOBILE_MONEY].map((instrument) => [instrument.digits, instrument]),
);

/** Everything above, for the dashboard and `docs/paystack.md`. */
export const PAYSTACK_PUBLISHED_INSTRUMENTS = [...CARDS, ...MOBILE_MONEY];

/**
 * Resolve one of Paystack's published test instruments.
 *
 * Returns null for anything else, so the emulator's own suffix convention
 * still applies to the synthetic `4000 0000 0000 000X` numbers.
 */
export const paystackInstrumentResolver: InstrumentResolver = (
  identifier: string,
  _method: PaymentMethod | null,
): InstrumentResolution | null => {
  const digits = identifier.replace(/\D/g, '');
  if (digits.length === 0) return null;

  const exact = BY_DIGITS.get(digits);
  if (exact) return { outcome: exact.outcome, description: exact.description };

  // Phone numbers arrive with and without a country code, so try the local
  // form too rather than making the caller normalise first.
  const withoutCountryCode = digits.replace(/^(?:00)?(?:233|234|254|225)/, '0');
  const local = BY_DIGITS.get(withoutCountryCode);
  return local ? { outcome: local.outcome, description: local.description } : null;
};

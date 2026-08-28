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
  /**
   * The OTP this instrument expects, where Paystack documents a specific one.
   *
   * Defaults to `123456` -- the value they publish for their card flows --
   * when absent.
   */
  otp?: string;
  /** How a refund against this instrument settles. */
  refund?: RefundOutcome;
}

/**
 * What a refund against a given instrument does.
 *
 * Paystack publishes cards whose *charge* succeeds but whose *refund* takes a
 * particular path, so that a merchant can rehearse the recovery flow. Mapped
 * to the canonical refund statuses.
 */
export type RefundOutcome = 'successful' | 'failed' | 'needs_attention';

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
    description: 'Paystack test card: charge succeeds, refund fails',
    refund: 'failed',
  },
  {
    digits: '4084080000671902',
    label: 'Charges, then refund needs attention',
    outcome: 'success',
    description: 'Paystack test card: charge succeeds, refund needs bank details',
    refund: 'needs_attention',
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
    digits: '0700000000',
    label: 'Orange (CIV) — OTP',
    outcome: 'authentication_required',
    description: 'Paystack test mobile money: Orange CIV, requires OTP 1234',
    // Paystack pairs this number with 1234, where their card flows use 123456.
    otp: '1234',
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


/** The default OTP, used by every instrument that does not publish its own. */
export const DEFAULT_TEST_OTP = '123456';

/**
 * The OTP a parked charge expects.
 *
 * Looked up from whatever identifier the payment retained. Mobile money keeps
 * the full number, so its instrument is findable; a card keeps only its last
 * four by design, so it falls back to the default -- which is what Paystack
 * documents for every one of their card flows anyway.
 */
export function expectedOtp(identifier: string | null | undefined): string {
  if (!identifier) return DEFAULT_TEST_OTP;
  const digits = identifier.replace(/\D/g, '');
  const local = digits.replace(/^(?:00)?(?:233|234|254|225)/, '0');
  const match = BY_DIGITS.get(digits) ?? BY_DIGITS.get(local);
  return match?.otp ?? DEFAULT_TEST_OTP;
}

/**
 * How a refund against this payment's instrument settles.
 *
 * Keyed explicitly on the last four rather than scanning every published
 * instrument for a matching suffix. A settled payment retains only four
 * digits, and those collide: `0000` is shared by the M-PESA test number, the
 * Orange CIV test number, and paybox's own success card. A scan would return
 * whichever happened to be listed first, so adding a refund outcome to any of
 * them would silently apply it to the other two.
 *
 * Only Paystack's two documented refund-outcome cards belong here. Keep the
 * keys collision-free: every entry must be a suffix no other test instrument
 * shares.
 */
const REFUND_BY_LAST4: Record<string, RefundOutcome> = {
  // 4084 0800 0067 1803 — "Failed"
  '1803': 'failed',
  // 4084 0800 0067 1902 — "Needs attention"
  '1902': 'needs_attention',
};

export function paystackRefundOutcome(last4: string | null | undefined): RefundOutcome {
  if (!last4) return 'successful';
  const suffix = last4.replace(/\D/g, '').slice(-4);
  return REFUND_BY_LAST4[suffix] ?? 'successful';
}

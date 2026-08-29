import type { PaymentMethod } from '@paybox/shared';
import type { InstrumentResolution, InstrumentResolver } from '@paybox/simulator';
import type { FlutterwaveAuthMode } from './status.js';

/**
 * Flutterwave's published test instruments.
 *
 * Transcribed verbatim from developer.flutterwave.com/v3.0.0/docs/testing
 * (read 2026-08-29). These are the numbers a developer already has in their
 * tests, so the emulator has to reproduce them -- above all the declining
 * ones, since a decline that silently succeeds turns a failure test into a
 * false pass.
 *
 * Flutterwave's table carries something Paystack's and Stripe's do not: each
 * card names the **authorization model** it triggers -- PIN, 3DS, AVS or
 * NoAuth. That is the whole point of their test set, because the step-up a
 * card demands is what an integration has to branch on, so it is modelled here
 * rather than flattened away.
 *
 * Injected as an `InstrumentResolver` so @paybox/simulator never learns whose
 * card numbers these are (spec §30).
 */
export interface FlutterwaveCard extends InstrumentResolution {
  digits: string;
  network: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  /** Which step-up this card demands. Null means it settles with no auth. */
  authMode: FlutterwaveAuthMode | null;
  /** Flutterwave's `processor_response` for this card. */
  processorResponse: string;
}

export const FLUTTERWAVE_PUBLISHED_CARDS: readonly FlutterwaveCard[] = [
  {
    digits: '5531886652142950',
    network: 'MASTERCARD',
    expiryMonth: '09',
    expiryYear: '32',
    cvv: '564',
    authMode: 'pin',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: PIN authentication, then success',
  },
  {
    digits: '5438898014560229',
    network: 'MASTERCARD',
    expiryMonth: '10',
    expiryYear: '31',
    cvv: '564',
    authMode: 'redirect',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: 3-D Secure, then success',
  },
  {
    digits: '4187427415564246',
    network: 'VISA',
    expiryMonth: '09',
    expiryYear: '32',
    cvv: '828',
    authMode: 'redirect',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: 3-D Secure, then success',
  },
  {
    digits: '5640003941605320',
    network: 'AFRIGO',
    expiryMonth: '05',
    expiryYear: '26',
    cvv: '044',
    authMode: 'redirect',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: Afrigo 3-D Secure, then success',
  },
  {
    digits: '5061460410120223210',
    network: 'VERVE',
    expiryMonth: '10',
    expiryYear: '31',
    cvv: '780',
    authMode: 'pin',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: Verve PIN authentication, then success',
  },
  {
    digits: '5061460166976054667',
    network: 'VERVE',
    expiryMonth: '10',
    expiryYear: '29',
    cvv: '564',
    authMode: null,
    outcome: 'success',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: no authentication, succeeds immediately',
  },
  {
    digits: '4556052704172643',
    network: 'VISA',
    expiryMonth: '09',
    expiryYear: '32',
    cvv: '899',
    authMode: 'avs_noauth',
    outcome: 'authentication_required',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: address verification, then success',
  },
  {
    digits: '5377283645077450',
    network: 'MASTERCARD',
    expiryMonth: '09',
    expiryYear: '31',
    cvv: '789',
    authMode: null,
    outcome: 'success',
    processorResponse: 'Approved. Successful',
    description: 'Flutterwave test card: pre-authorization',
  },

  /* --- cards that fail --- */

  {
    digits: '5143010522339965',
    network: 'MASTERCARD',
    expiryMonth: '08',
    expiryYear: '32',
    cvv: '276',
    authMode: 'pin',
    outcome: 'declined',
    processorResponse: 'Do not honour',
    description: 'Flutterwave test card: do not honour',
  },
  {
    digits: '5590131743294314',
    network: 'MASTERCARD',
    expiryMonth: '11',
    expiryYear: '32',
    cvv: '887',
    authMode: 'pin',
    outcome: 'declined',
    processorResponse: 'Card is fraudulent',
    description: 'Flutterwave test card: fraudulent card',
  },
  {
    digits: '5258585922666506',
    network: 'MASTERCARD',
    expiryMonth: '09',
    expiryYear: '31',
    cvv: '883',
    authMode: 'pin',
    outcome: 'insufficient_funds',
    processorResponse: 'Insufficient Funds',
    description: 'Flutterwave test card: insufficient funds',
  },
  {
    digits: '5640007065275380',
    network: 'AFRIGO',
    expiryMonth: '05',
    expiryYear: '31',
    cvv: '044',
    authMode: null,
    outcome: 'insufficient_funds',
    processorResponse: 'Insufficient Funds',
    description: 'Flutterwave test card: Afrigo insufficient funds',
  },
  {
    digits: '5399834697894723',
    network: 'MASTERCARD',
    expiryMonth: '09',
    expiryYear: '31',
    cvv: '883',
    authMode: 'pin',
    outcome: 'authentication_failed',
    processorResponse: 'Incorrect PIN',
    description: 'Flutterwave test card: incorrect PIN',
  },
];

const BY_DIGITS = new Map(FLUTTERWAVE_PUBLISHED_CARDS.map((card) => [card.digits, card]));

/** Look a published card up by its full number, or by the last four. */
export function findPublishedCard(number: string | null): FlutterwaveCard | null {
  if (!number) return null;
  const digits = number.replace(/\D/g, '');
  const exact = BY_DIGITS.get(digits);
  if (exact) return exact;
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  return (
    FLUTTERWAVE_PUBLISHED_CARDS.find((card) => card.digits.slice(-4) === last4) ?? null
  );
}

/**
 * Special OTPs, from the same testing page.
 *
 * "Any OTP passed in test transactions will pass validation", with two
 * exceptions that mock a failure. Reproduced exactly: a developer testing
 * their wrong-OTP branch needs `5548` to fail here as it does there.
 */
export const OTP_OUTCOMES: Record<string, 'authentication_failed' | 'insufficient_funds'> = {
  '5548': 'authentication_failed',
  '6648': 'insufficient_funds',
};

/**
 * Mobile-money test numbers.
 *
 * Any number succeeds with OTP `123456`; the numbers below mock a failure.
 * Same page, same date.
 */
const FAILING_MOMO_NUMBERS = new Set(['233121212121']);

export function momoFails(phone: string | null): boolean {
  if (!phone) return false;
  return FAILING_MOMO_NUMBERS.has(phone.replace(/\D/g, ''));
}

export const FLUTTERWAVE_TEST_OTP = '12345';
export const FLUTTERWAVE_TEST_PIN = '3310';
export const FLUTTERWAVE_MOMO_OTP = '123456';

/**
 * Resolve a test instrument to an outcome.
 *
 * Falls back to the shared last-four convention for anything not in
 * Flutterwave's published set, so paybox's own `…0002`-style numbers still
 * work across every provider.
 */
export const flutterwaveInstrumentResolver: InstrumentResolver = (
  number: string | null,
  _channel: PaymentMethod | null,
): InstrumentResolution | null => {
  const card = findPublishedCard(number);
  return card ? { outcome: card.outcome, description: card.description } : null;
};

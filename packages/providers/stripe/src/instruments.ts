import type { PaymentMethod } from '@paybox/shared';
import type { InstrumentResolution, InstrumentResolver } from '@paybox/simulator';

/**
 * Stripe's published test cards.
 *
 * Transcribed from <https://docs.stripe.com/testing>, read 2026-08-28. These
 * are the numbers a developer will already have in their tests, so the
 * emulator has to reproduce them -- above all the declining ones, since a
 * decline that silently succeeds turns a failure test into a false pass.
 *
 * Injected as an `InstrumentResolver` so @paybox/simulator never learns whose
 * card numbers these are (spec §30).
 */
interface PublishedCard extends InstrumentResolution {
  digits: string;
  /** Stripe's `error.code`. */
  code: string;
  /** Stripe's `error.decline_code`, where the docs give one. */
  declineCode?: string;
}

const CARDS: readonly PublishedCard[] = [
  {
    digits: '4242424242424242',
    outcome: 'success',
    code: '',
    description: 'Stripe test card: succeeds',
  },
  {
    digits: '4000000000000002',
    outcome: 'declined',
    code: 'card_declined',
    declineCode: 'generic_decline',
    description: 'Stripe test card: generic decline',
  },
  {
    digits: '4000000000009995',
    outcome: 'insufficient_funds',
    code: 'card_declined',
    declineCode: 'insufficient_funds',
    description: 'Stripe test card: insufficient funds',
  },
  {
    digits: '4000000000009987',
    outcome: 'declined',
    code: 'card_declined',
    declineCode: 'lost_card',
    description: 'Stripe test card: lost card',
  },
  {
    digits: '4000000000009979',
    outcome: 'declined',
    code: 'card_declined',
    declineCode: 'stolen_card',
    description: 'Stripe test card: stolen card',
  },
  {
    digits: '4000000000000069',
    outcome: 'expired_card',
    code: 'expired_card',
    description: 'Stripe test card: expired card',
  },
  {
    digits: '4000000000000127',
    outcome: 'declined',
    code: 'incorrect_cvc',
    description: 'Stripe test card: incorrect CVC',
  },
  {
    digits: '4000000000000119',
    outcome: 'processing_error',
    code: 'processing_error',
    description: 'Stripe test card: processing error',
  },
  {
    // Documented as requiring 3-D Secure authentication before it can settle.
    digits: '4000002500003155',
    outcome: 'authentication_required',
    code: 'authentication_required',
    description: 'Stripe test card: requires 3-D Secure authentication',
  },
  {
    digits: '4000000000003220',
    outcome: 'authentication_required',
    code: 'authentication_required',
    description: 'Stripe test card: 3-D Secure 2 authentication required',
  },
];

const BY_DIGITS = new Map(CARDS.map((card) => [card.digits, card]));

export const STRIPE_PUBLISHED_CARDS = CARDS;

export const stripeInstrumentResolver: InstrumentResolver = (
  identifier: string,
  _method: PaymentMethod | null,
): InstrumentResolution | null => {
  const digits = identifier.replace(/\D/g, '');
  const card =
    BY_DIGITS.get(digits) ??
    (digits.length >= 10 ? BY_BIN_LAST4.get(`${digits.slice(0, 6)}:${digits.slice(-4)}`) : undefined);
  return card ? { outcome: card.outcome, description: card.description } : null;
};

/**
 * The same table keyed by BIN and last four, for the second half of a
 * two-call flow.
 *
 * A PaymentIntent or SetupIntent created with a card and confirmed *later*,
 * a stored PaymentMethod being charged, and a subscription renewal all have
 * only the masked instrument left to resolve from (spec §29: the PAN is
 * discarded at the boundary). Callers reconstruct `bin + zeros + last4` the
 * way the Flutterwave adapter does, and this table answers from those two
 * fragments -- every published Stripe test card has a distinct BIN/last-four
 * pair. Without it, a 3-D Secure card attached at creation sailed through
 * `/confirm` with no step-up. A bare last four is deliberately *not* matched:
 * `…0002` alone is ambiguous between the published decline card and any
 * other number ending the same way.
 */
const BY_BIN_LAST4 = new Map(
  CARDS.map((card) => [`${card.digits.slice(0, 6)}:${card.digits.slice(-4)}`, card]),
);

/**
 * The identifier to resolve a masked instrument with: the BIN and last four
 * a settled charge kept, joined the way `findPublishedCard` expects. Null
 * when the fragments are missing, which makes the generic suffix table the
 * fallback exactly as before.
 */
export function maskedInstrumentIdentifier(
  details: { bin?: unknown; last4?: unknown } | null | undefined,
): string | null {
  const bin = typeof details?.bin === 'string' ? details.bin : null;
  const last4 = typeof details?.last4 === 'string' ? details.last4 : null;
  if (!last4) return null;
  return bin ? `${bin}${'0'.repeat(6)}${last4}` : last4;
}

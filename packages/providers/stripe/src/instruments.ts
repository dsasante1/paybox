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
  const card = BY_DIGITS.get(identifier.replace(/\D/g, ''));
  return card ? { outcome: card.outcome, description: card.description } : null;
};

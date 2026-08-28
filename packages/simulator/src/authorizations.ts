import type { Authorization, Metadata } from '@paybox/shared';
import {
  resolveInstrument,
  type InstrumentResolver,
  type SimulatedOutcome,
} from './instruments.js';

/**
 * Turning a stored authorization back into a chargeable instrument.
 *
 * Shared between the adapter's `charge_authorization` route and the
 * subscription runner so that an off-session debit behaves identically however
 * it was triggered -- a renewal and a manual re-charge of the same card must
 * not diverge.
 */

/** The `paymentMethodDetails` an off-session charge carries. */
export function authorizationChargeDetails(authorization: Authorization): Metadata {
  return {
    bin: authorization.bin,
    last4: authorization.last4,
    exp_month: authorization.expMonth,
    exp_year: authorization.expYear,
    brand: authorization.brand,
    card_type: authorization.cardType,
    bank: authorization.bank,
    country: authorization.countryCode,
  };
}

/**
 * Which outcome charging this authorization produces.
 *
 * Read from the instrument behind it, so a subscription backed by the
 * insufficient-funds test card fails its renewals -- which is the whole
 * scenario a dunning flow needs to be tested against.
 */
export function authorizationOutcome(
  authorization: Authorization,
  resolver?: InstrumentResolver | null,
): SimulatedOutcome {
  // A stored authorization keeps only the masked last four, so a provider's
  // published full-number table cannot match it. That is fine: the outcome was
  // already decided when the card was first charged, and the suffix convention
  // reproduces it. The resolver is still offered for providers whose test
  // instruments are distinguishable from four digits alone.
  return resolveInstrument(authorization.last4, authorization.channel, {
    ...(resolver ? { resolver } : {}),
  }).outcome;
}

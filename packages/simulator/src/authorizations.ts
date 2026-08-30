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
  // A stored authorization keeps only the masked BIN and last four, so a
  // provider's published full-number table cannot match it on its own. The
  // two fragments are handed over joined (`bin` + zeros + `last4`): the suffix
  // convention still reads the last four, and a provider resolver that keys
  // its published table by BIN and last four -- Stripe's, Flutterwave's -- can
  // recover the documented outcome rather than falling through to "success".
  const identifier =
    authorization.bin && authorization.last4
      ? `${authorization.bin}${'0'.repeat(6)}${authorization.last4}`
      : authorization.last4;
  return resolveInstrument(identifier, authorization.channel, {
    ...(resolver ? { resolver } : {}),
  }).outcome;
}

import type { Payment, PaymentMethod } from '@paybox/shared';
import type { AuthorizationDraft, AuthorizationMinter } from '@paybox/core';

/**
 * Flutterwave's reusable card tokens.
 *
 * A successful card charge leaves behind a token the merchant can debit again
 * without the customer present -- what Flutterwave calls tokenization and
 * charges through `/v3/tokenized-charges`. Verified at
 * developer.flutterwave.com/v3.0.0/docs/tokenization (read 2026-08-29).
 *
 * Injected into the engine as an `AuthorizationMinter` so core never learns
 * which of Flutterwave's channels are reusable (spec §30).
 *
 * Only cards mint one. Mobile money does not: the customer has to approve each
 * prompt on their handset, so a stored handle would promise something the rail
 * cannot deliver -- and charging it would be the failure a merchant needs to
 * discover locally rather than in production.
 */
const REUSABLE_CHANNELS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>(['card']);

/** Deterministic fingerprint, from masked fragments only (spec §29). */
function fingerprint(parts: readonly (string | null | undefined)[]): string {
  const input = parts.map((part) => part ?? '').join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(32).padStart(7, '0');
}

export const flutterwaveAuthorizationMinter: AuthorizationMinter = (
  payment: Payment,
): AuthorizationDraft | null => {
  const channel = payment.paymentMethod;
  if (!channel || !REUSABLE_CHANNELS.has(channel)) return null;

  const details = payment.paymentMethodDetails;
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const bin = str('bin');
  const last4 = str('last4');
  const expMonth = str('exp_month');
  const expYear = str('exp_year');
  const print = fingerprint([bin, last4, expMonth, expYear]);

  return {
    channel,
    reusable: true,
    // Flutterwave's tokens look like `flw-t1nf-<hash>-k3n`. Derived from the
    // instrument so the same card always yields the same token under a fixed
    // seed, and folded with the customer so two customers who happen to share
    // a card get two tokens -- a stored instrument belongs to a customer.
    providerAuthorizationCode: `flw-t1nf-${fingerprint([
      print,
      payment.customerId ?? payment.reference,
    ])}-k3n`,
    signature: `SIG_${print}`,
    bin,
    last4,
    expMonth,
    expYear,
    cardType: str('brand'),
    bank: null,
    brand: str('brand'),
    countryCode: str('country') ?? 'NG',
  };
};

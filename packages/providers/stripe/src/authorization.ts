import type { Payment, PaymentMethod } from '@paybox/shared';
import type { AuthorizationDraft, AuthorizationMinter } from '@paybox/core';

/**
 * Stripe's reusable instruments.
 *
 * A successful card payment leaves behind a PaymentMethod that can be charged
 * again off-session. Injected into the engine as an `AuthorizationMinter` so
 * core never learns which of Stripe's channels are reusable (spec §30).
 */
const REUSABLE_CHANNELS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>(['card']);

/** Deterministic instrument fingerprint, from masked fragments only. */
function fingerprint(parts: readonly (string | null | undefined)[]): string {
  const input = parts.map((p) => p ?? '').join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(32).padStart(7, '0');
}

export const stripeAuthorizationMinter: AuthorizationMinter = (
  payment: Payment,
): AuthorizationDraft | null => {
  const channel = payment.paymentMethod;
  if (!channel) return null;

  const details = payment.paymentMethodDetails;
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  if (channel !== 'card') {
    return {
      channel,
      reusable: REUSABLE_CHANNELS.has(channel),
      signature: null,
      providerAuthorizationCode: fingerprint([payment.providerTransactionId]),
      countryCode: str('country') ?? 'US',
    };
  }

  const bin = str('bin');
  const last4 = str('last4');
  const expMonth = str('exp_month');
  const expYear = str('exp_year');
  const print = fingerprint([bin, last4, expMonth, expYear]);

  return {
    channel,
    reusable: true,
    providerAuthorizationCode: print,
    signature: `SIG_${print}`,
    bin,
    last4,
    expMonth,
    expYear,
    cardType: str('brand') ?? 'visa',
    bank: null,
    brand: str('brand') ?? 'visa',
    countryCode: str('country') ?? 'US',
  };
};

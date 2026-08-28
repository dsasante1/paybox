import type { Authorization, Payment, PaymentMethod } from '@paybox/shared';
import type { AuthorizationDraft, AuthorizationMinter } from '@paybox/core';

/**
 * Stored authorizations, Paystack-side (spec §5).
 *
 * Verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27 --
 * operations `transaction_chargeAuthorization` and `charge_submitOtp`, and the
 * `authorization` object carried on every transaction response.
 */

/**
 * Which channels mint a code that can be charged again without the customer.
 *
 * Only cards are reusable. A mobile-money debit needs the payer to approve a
 * prompt on their handset every single time, and Paystack's own response says
 * `reusable: false` for that channel, so an off-session charge against one can
 * never work -- in the emulator or in production.
 */
const REUSABLE_CHANNELS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>(['card']);

/**
 * A deterministic stand-in for Paystack's instrument fingerprint.
 *
 * It must be stable per *instrument* rather than per transaction: that is what
 * makes charging the same card twice reuse one authorization instead of
 * accumulating a new one per payment. Derived only from fragments that are
 * already safe to persist -- never from a PAN, which the emulator discards at
 * the API boundary and never sees again (spec §29).
 */
function fingerprint(parts: readonly (string | null | undefined)[]): string {
  const input = parts.map((p) => p ?? '').join('|');
  // FNV-1a, 32-bit. Chosen for being short, deterministic and dependency-free;
  // this is an opaque identifier, not a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(32).padStart(7, '0');
}

/**
 * Turns a settled Paystack payment into the authorization Paystack would mint.
 *
 * Injected into the engine as an `AuthorizationMinter` so that core never
 * learns which channels Paystack considers reusable (spec §30).
 */
export const paystackAuthorizationMinter: AuthorizationMinter = (
  payment: Payment,
): AuthorizationDraft | null => {
  const channel = payment.paymentMethod;
  if (!channel) return null;

  const details = payment.paymentMethodDetails;
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  if (channel === 'card') {
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
      cardType: str('card_type'),
      bank: str('bank') ?? 'TEST BANK',
      brand: str('brand'),
      countryCode: str('country') ?? 'GH',
    };
  }

  if (channel === 'mobile_money') {
    const phone = str('phone');
    return {
      channel,
      reusable: false,
      // No signature: momo authorizations are single-use, so they must not
      // dedupe against one another. The partial unique index on
      // (provider, signature) skips NULLs precisely for this.
      signature: null,
      providerAuthorizationCode: fingerprint([phone, payment.providerTransactionId]),
      bank: str('network'),
      brand: str('network'),
      countryCode: str('country') ?? 'GH',
      accountName: str('account_name'),
      mobileMoneyNumber: phone,
    };
  }

  return {
    channel,
    reusable: REUSABLE_CHANNELS.has(channel),
    signature: null,
    providerAuthorizationCode: fingerprint([payment.providerTransactionId]),
    bank: str('bank'),
    countryCode: str('country') ?? 'GH',
    accountName: str('account_name'),
  };
};

/** Paystack's `authorization` object, built from a stored authorization. */
export function serializeAuthorization(authorization: Authorization) {
  const base = {
    authorization_code: `AUTH_${authorization.providerAuthorizationCode}`,
    bin: authorization.bin,
    last4: authorization.last4,
    exp_month: authorization.expMonth,
    exp_year: authorization.expYear,
    channel: authorization.channel,
    card_type: authorization.cardType,
    bank: authorization.bank,
    country_code: authorization.countryCode,
    brand: authorization.brand,
    reusable: authorization.reusable,
    signature: authorization.signature,
    account_name: authorization.accountName,
  };
  if (authorization.channel === 'mobile_money') {
    return {
      ...base,
      mobile_money_number: authorization.mobileMoneyNumber,
      receiver_bank_account_number: null,
      receiver_bank: null,
    };
  }
  return base;
}

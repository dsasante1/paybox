import type { Storage } from '@paybox/core';
import type { IdFactory } from '@paybox/shared';

/**
 * Short-lived Tingg-specific state, in the provider key/value store.
 *
 * Three things here are not engine resources and should not become ones:
 *
 *   the checkout request   Tingg's `checkout_request_id` plus the fields that
 *                          travel with it -- service code, account number,
 *                          redirect URLs, the per-request callback address
 *   the charge             a `charge_request_id` and its rail instructions;
 *                          one checkout can carry several charge attempts
 *   the BEEP payout packet the camelCase fields a payout was posted with,
 *                          which are Tingg's shape and not the engine's
 *
 * `storage.providerState` is the seam Wise added and Quid reused. Values are
 * JSON under a prefixed key, scoped to this provider, and cleared by
 * `paybox reset` along with everything else.
 */
const PROVIDER = 'tingg' as const;

/**
 * Tingg's ids are decimal numbers, not opaque strings.
 *
 * `checkout_request_id: 568192`, `charge_request_id: 277648`,
 * `beepTransactionID: 10324841472`. The injected id factory emits base32, so
 * its characters are folded down to digits -- deterministic under a fixed
 * seed, which is what the integration suite needs, and never `Math.random`.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function numericId(ids: IdFactory, digits: number): string {
  const token = ids.token(digits);
  let out = '';
  for (const char of token) {
    const index = ALPHABET.indexOf(char);
    out += String(index < 0 ? 0 : index % 10);
  }
  // A leading zero would make the id shorter once a client parses it as a
  // number, and Tingg's samples never have one.
  return out.replace(/^0/, '1');
}

/* ------------------------------- checkout ------------------------------- */

export interface StoredCharge {
  chargeRequestId: string;
  gatewayChargeUuid: string;
  paymentOptionCode: string;
  chargeMsisdn: string;
  chargeAmount: number;
  paymentInstructions: string;
  thirdPartyReference: string;
  thirdPartyId: string;
  createdAt: string;
}

/**
 * One checkout request.
 *
 * Keyed by `merchant_transaction_id`, which Tingg documents as the merchant's
 * unique reference and which paybox also uses as `Payment.reference`. A second
 * key indexes it by `checkout_request_id`, because `query/{service_code}/{id}`
 * and the acknowledgement route address it by that instead.
 */
export interface StoredCheckout {
  merchantTransactionId: string;
  checkoutRequestId: string;
  paymentId: string;
  serviceCode: string;
  accountNumber: string;
  msisdn: string;
  countryCode: string;
  currencyCode: string;
  requestAmount: number;
  customerFirstName: string;
  customerLastName: string;
  customerEmail: string | null;
  requestDescription: string | null;
  invoiceNumber: string | null;
  /** The per-request IPN address. Tingg has no dashboard-configured one. */
  callbackUrl: string | null;
  successRedirectUrl: string | null;
  failRedirectUrl: string | null;
  paymentOptionCode: string | null;
  languageCode: string;
  dueDate: string;
  /** Present once express checkout minted a hosted-page URL for it. */
  shortUrl: string | null;
  charges: StoredCharge[];
  /** What the merchant acknowledged, if anything. */
  acknowledgement: {
    statusCode: string;
    reference: string;
    type: string;
    amount: number | null;
    narration: string | null;
    at: string;
  } | null;
  createdAt: string;
}

/* -------------------------------- payouts ------------------------------- */

export interface StoredPayout {
  payerTransactionId: string;
  beepTransactionId: string;
  transferId: string;
  serviceCode: string;
  countryCode: string;
  msisdn: string;
  accountNumber: string;
  currencyCode: string;
  amount: number;
  narration: string;
  customerNames: string;
  callbackUrl: string | null;
  extraData: Record<string, unknown>;
  createdAt: string;
}

/* -------------------------------- accessor ------------------------------- */

export function tinggState(storage: Storage, now: () => string) {
  async function read<T>(key: string): Promise<T | null> {
    const value = await storage.providerState.get(PROVIDER, key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async function write(key: string, value: unknown): Promise<void> {
    await storage.providerState.put(PROVIDER, key, JSON.stringify(value), now());
  }

  return {
    checkouts: {
      get: (merchantTransactionId: string) =>
        read<StoredCheckout>(`checkout:${merchantTransactionId}`),
      async byRequestId(checkoutRequestId: string): Promise<StoredCheckout | null> {
        const pointer = await read<{ merchantTransactionId: string }>(
          `checkout-id:${checkoutRequestId}`,
        );
        if (!pointer) return null;
        return read<StoredCheckout>(`checkout:${pointer.merchantTransactionId}`);
      },
      async put(checkout: StoredCheckout): Promise<void> {
        await write(`checkout:${checkout.merchantTransactionId}`, checkout);
        await write(`checkout-id:${checkout.checkoutRequestId}`, {
          merchantTransactionId: checkout.merchantTransactionId,
        });
      },
    },
    payouts: {
      get: (payerTransactionId: string) => read<StoredPayout>(`payout:${payerTransactionId}`),
      async byBeepId(beepTransactionId: string): Promise<StoredPayout | null> {
        const pointer = await read<{ payerTransactionId: string }>(
          `payout-id:${beepTransactionId}`,
        );
        if (!pointer) return null;
        return read<StoredPayout>(`payout:${pointer.payerTransactionId}`);
      },
      async put(payout: StoredPayout): Promise<void> {
        await write(`payout:${payout.payerTransactionId}`, payout);
        await write(`payout-id:${payout.beepTransactionId}`, {
          payerTransactionId: payout.payerTransactionId,
        });
      },
    },
  };
}

export type TinggState = ReturnType<typeof tinggState>;

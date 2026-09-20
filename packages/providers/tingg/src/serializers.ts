import type { Payment } from '@paybox/shared';
import { checkoutStatusDescription, toTinggStatus } from './status.js';
import type { StoredCharge, StoredCheckout } from './state.js';

/**
 * Tingg's response shapes.
 *
 * Two envelopes, because Tingg has two APIs:
 *
 *   Checkout 3.0   { status: { status_code, status_description }, results }
 *   Payouts        { authStatus: { authStatusCode, … }, results: [ … ] }
 *
 * Both transcribed from docs.tingg.africa, read 2026-09-20.
 *
 * Note that Checkout's `status_code` is **not** consistently an HTTP status:
 * the express-checkout sample answers `200`, while `checkout-charge` answers
 * `1` with "Transaction was saved successfully." That inconsistency is
 * Tingg's, and is reproduced rather than tidied up -- a client that switches
 * on the value has to handle both, and it should find that out here.
 */

/** Money leaves in major units, the way every Tingg sample quotes it. */
export function major(minorUnits: number): number {
  return Number((minorUnits / 100).toFixed(2));
}

/** `checkout-charge` answers `status_code: 1`, not 200. */
export const CHARGE_SAVED_CODE = 1;
export const CHARGE_SAVED_DESCRIPTION = 'Transaction was saved successfully.';

/**
 * The name a payer sees against a charge.
 *
 * `payer_client_name` on an IPN is the institution the money came from. There
 * is no real one here, so it is derived from the payment option the merchant
 * selected rather than invented as a bank that exists.
 */
export const PAYER_CLIENT_CODE = 'PAYBOX';

/* ------------------------------ express ------------------------------- */

/**
 * `{ short_url, long_url }`.
 *
 * Tingg returns two URLs for one hosted page: a shortened one to put in an
 * SMS and the full one to redirect a browser to. paybox serves the same page
 * from both, because there is no link shortener here and pretending otherwise
 * would mean one of the two did not work.
 */
export function serializeExpressResults(
  checkout: StoredCheckout,
  urls: { shortUrl: string; longUrl: string },
): Record<string, unknown> {
  void checkout;
  return { short_url: urls.shortUrl, long_url: urls.longUrl };
}

/* ------------------------------ checkout ------------------------------ */

export function serializeCheckoutResults(
  checkout: StoredCheckout,
  payment: Payment,
): Record<string, unknown> {
  return {
    checkout_request_id: Number(checkout.checkoutRequestId),
    merchant_transaction_id: checkout.merchantTransactionId,
    account_number: checkout.accountNumber,
    request_amount: major(payment.amount),
    currency_code: payment.currency,
    msisdn: Number(checkout.msisdn),
    overall_status: Number(toTinggStatus(payment.status)),
    created_at: stamp(checkout.createdAt),
  };
}

export function serializeChargeResults(
  checkout: StoredCheckout,
  charge: StoredCharge,
): Record<string, unknown> {
  return {
    merchant_transaction_id: checkout.merchantTransactionId,
    currency_code: checkout.currencyCode,
    checkout_request_id: Number(checkout.checkoutRequestId),
    gateway_charge_uuid: charge.gatewayChargeUuid,
    charge_request_id: Number(charge.chargeRequestId),
    language_code: checkout.languageCode,
    charge_msisdn: Number(charge.chargeMsisdn),
    charge_amount: major(charge.chargeAmount),
    payment_instructions: charge.paymentInstructions,
    third_party_response: {
      third_party_reference: charge.thirdPartyReference,
      third_party_id: charge.thirdPartyId,
    },
    created_at: stamp(charge.createdAt),
  };
}

/**
 * The IPN body, and the body `query/{service_code}/{id}` answers with.
 *
 * Field-for-field from the express-checkout page's "Incoming Request Body".
 * Two deliberate departures, both recorded in docs/tingg.md:
 *
 *   `account_number` is typed `number` on that page but is a string
 *   everywhere it is *sent*, and Tingg's own sample value
 *   ("10000017560004") would lose a leading zero if coerced. It is sent as
 *   the string the merchant supplied.
 *
 *   `original_request_*` equal `request_*`. They differ only where Tingg
 *   converted a currency, and paybox never converts (spec §17).
 */
export function serializeNotification(
  checkout: StoredCheckout,
  payment: Payment,
  options: { countryAbbrv: string; requestDate: string },
): Record<string, unknown> {
  const statusCode = Number(toTinggStatus(payment.status));
  const paid = payment.status === 'successful' || payment.status === 'partially_refunded' || payment.status === 'refunded';
  const charge = checkout.charges.at(-1) ?? null;

  const paymentLine = charge
    ? {
        customer_name: `${checkout.customerFirstName} ${checkout.customerLastName}`.trim(),
        account_number: checkout.accountNumber,
        cpg_transaction_id: charge.gatewayChargeUuid,
        currency_code: checkout.currencyCode,
        payer_client_code: PAYER_CLIENT_CODE,
        payer_client_name: charge.paymentOptionCode,
        amount_paid: major(charge.chargeAmount),
        service_code: checkout.serviceCode,
        date_payment_received: stamp(payment.updatedAt),
        msisdn: charge.chargeMsisdn,
        payer_transaction_id: charge.thirdPartyReference,
        hub_overall_status: statusCode,
        payer_narration: checkout.requestDescription ?? '',
        payment_status: checkoutStatusDescription(statusCode),
      }
    : null;

  return {
    checkout_request_id: Number(checkout.checkoutRequestId),
    merchant_transaction_id: checkout.merchantTransactionId,
    request_amount: major(payment.amount),
    original_request_amount: major(payment.amount),
    request_currency_code: payment.currency,
    original_request_currency_code: payment.currency,
    account_number: checkout.accountNumber,
    currency_code: payment.currency,
    amount_paid: paid ? major(payment.amount) : 0,
    // Tingg's settlement fees are not published, and inventing a schedule
    // would put a number in a developer's reconciliation tests that no real
    // statement will ever match.
    service_charge_amount: 0,
    request_date: options.requestDate,
    service_code: checkout.serviceCode,
    request_status_code: String(statusCode),
    request_status_description: checkoutStatusDescription(statusCode),
    msisdn: checkout.msisdn,
    payments: paid && paymentLine ? [paymentLine] : [],
    failed_payments: !paid && paymentLine ? [paymentLine] : [],
    extra_data: '',
    country_abbrv: options.countryAbbrv,
  };
}

/* ------------------------------- payouts ------------------------------- */

/**
 * `{ authStatus, results: [...] }`.
 *
 * `results` is always an array: BEEP takes a `packet` of several items and
 * answers one result per item, even when the packet held one.
 */
export function beepEnvelope(
  auth: { code: number; description: string },
  results: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    authStatus: { authStatusCode: auth.code, authStatusDescription: auth.description },
    results,
  };
}

/** Tingg stamps `2026-07-01 08:34:29`, not ISO 8601 with a T and a Z. */
export function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

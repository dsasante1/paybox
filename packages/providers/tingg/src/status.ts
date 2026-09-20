import type { PaymentStatus, TransferStatus } from '@paybox/shared';

/**
 * Tingg's status vocabulary is **numeric**, and there are two of them.
 *
 * Checkout 3.0 and Payouts (BEEP) are separate products with separate code
 * lists that happen to overlap on the handful of codes describing a settled
 * payment. They are kept apart here rather than merged into one table,
 * because merging would invite using a payout code on a checkout response --
 * inventing provider behaviour by accident, which is the failure mode
 * CONTRIBUTING non-negotiable #3 exists to prevent.
 *
 * Sources, all read 2026-09-20:
 *   docs.tingg.africa/docs/checkout-v3-express-checkout   183 / 180 / 188
 *   docs.tingg.africa/docs/callback                       183 / 180 / 217 / 216
 *   docs.tingg.africa/reference/combined-checkout-charge  overall_status 130
 *   docs.tingg.africa/reference/postpayment               131 / 139 / 174 / 230-232
 *   docs.tingg.africa/reference/querypaymentstatus        148 / 178 / 183 / 180 / 216-219
 *   docs.tingg.africa/reference/queryfloatbalance         418
 *   docs.tingg.africa/reference/validateaccount           301 / 306 / 307
 *   docs.tingg.africa/reference/querybill                 308
 */

/* ------------------------------- checkout ------------------------------- */

/**
 * Codes a checkout request or its IPN carries.
 *
 * `PENDING` is the `overall_status` a freshly saved checkout carries in the
 * published `checkout-charge` example. The three acknowledgement codes are the
 * ones the *merchant* sends back on the callback, and Tingg reuses them as
 * request statuses -- which is why 188 appears in both directions.
 */
export const TINGG_CHECKOUT_STATUS = {
  PENDING: 130,
  REJECTED: 180,
  SUCCESS: 183,
  ACK_LATER: 188,
  MANUALLY_REJECTED: 216,
  MANUALLY_ACCEPTED: 217,
} as const;

/** The three codes a merchant may answer an IPN with. */
export const TINGG_ACKNOWLEDGEMENT_CODES = [
  TINGG_CHECKOUT_STATUS.SUCCESS,
  TINGG_CHECKOUT_STATUS.REJECTED,
  TINGG_CHECKOUT_STATUS.ACK_LATER,
] as const;

const CHECKOUT_DESCRIPTIONS: Record<number, string> = {
  130: 'Request is pending payment',
  180: 'Payment rejected',
  183: 'Payment received successfully',
  188: 'Payment received and will be acknowledged later',
  216: 'Payment manually rejected',
  217: 'Payment manually accepted',
};

export function checkoutStatusDescription(code: number): string {
  return CHECKOUT_DESCRIPTIONS[code] ?? 'Unknown status';
}

/**
 * Canonical payment status -> Tingg's `request_status_code`.
 *
 * Returned as a string because that is what `Payment.providerStatus` holds for
 * every adapter; the serialisers turn it back into a number where Tingg sends
 * one. Deliberately narrow: Tingg publishes no checkout status meaning
 * "refunded", so a refunded payment still reads 183. The refund is its own
 * resource with its own codes, exactly as it is at Tingg.
 */
export function toTinggStatus(status: PaymentStatus): string {
  switch (status) {
    case 'successful':
    case 'refunded':
    case 'partially_refunded':
      return String(TINGG_CHECKOUT_STATUS.SUCCESS);
    case 'failed':
    case 'cancelled':
    case 'expired':
      return String(TINGG_CHECKOUT_STATUS.REJECTED);
    // created, pending, processing, requires_action and authorized are all
    // "still waiting on the payer" as far as Tingg's checkout is concerned.
    default:
      return String(TINGG_CHECKOUT_STATUS.PENDING);
  }
}

/** Whether a checkout has reached a state Tingg would report on an IPN. */
export function isFinalCheckoutStatus(status: PaymentStatus): boolean {
  return ['successful', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded'].includes(
    status,
  );
}

/* -------------------------------- refunds ------------------------------- */

/**
 * Refund codes.
 *
 * The refund reference page lists these as "184/185 initiated (partial/full),
 * 186/187 processed (partial/full), 191 expired", and says notifications fire
 * for the final three only. The *pairing* of partial to the lower number of
 * each couple is stated only in that parenthetical and is corroborated
 * nowhere else, so docs/tingg.md records it as inferred rather than verified.
 */
export const TINGG_REFUND_STATUS = {
  PARTIAL_INITIATED: 184,
  FULL_INITIATED: 185,
  PARTIAL_PROCESSED: 186,
  FULL_PROCESSED: 187,
  EXPIRED: 191,
} as const;

/* -------------------------------- payouts ------------------------------- */

/**
 * BEEP codes.
 *
 * `authStatusCode` is separate from the per-packet `statusCode`: 131 says the
 * credentials in the body were accepted, and says nothing at all about whether
 * the payment went through. Reproduced as published -- a client that reads
 * only the outer envelope would call a failed payout a success, and that is a
 * bug worth being able to find locally.
 */
export const TINGG_BEEP_AUTH = {
  SUCCESS: 131,
  FAILED: 132,
} as const;

export const TINGG_BEEP_STATUS = {
  DELIVERED_TO_THIRD_PARTY: 148,
  GENERIC_FAILURE: 174,
  PENDING_QUERY: 178,
  REJECTED: 180,
  SUCCESS: 183,
  INVALID_SERVICE: 167,
  MANUALLY_REJECTED: 216,
  MANUALLY_ACCEPTED: 217,
  ESCALATED: 219,
  INSUFFICIENT_FLOAT: 230,
  ABOVE_MAXIMUM: 231,
  BELOW_MINIMUM: 232,
  VALIDATION_UNAVAILABLE: 301,
  INVALID_ACCOUNT: 306,
  VALID_ACCOUNT: 307,
  BILL_AVAILABLE: 308,
  PENDING_ACKNOWLEDGEMENT: 139,
  FLOAT_SUCCESS: 418,
} as const;

const BEEP_DESCRIPTIONS: Record<number, string> = {
  139: 'Payment posted successfully and pending acknowledgement',
  148: 'Transaction delivered to third party for processing',
  167: 'Invalid service',
  174: 'Generic failure',
  178: 'The transaction is pending acknowledgement from the client',
  180: 'Payment failed',
  183: 'Payment successful',
  216: 'Payment manually rejected',
  217: 'Payment manually accepted',
  219: 'Payment escalated',
  230: 'Insufficient float balance',
  231: 'Amount exceeds maximum allowed',
  232: 'Amount below minimum allowed',
  301: 'Account validation is unavailable',
  306: 'Account number provided is invalid',
  307: 'Account number provided is valid',
  308: 'Bill information is available',
  418: 'Float processing was successful',
};

export function beepStatusDescription(code: number): string {
  return BEEP_DESCRIPTIONS[code] ?? 'Unknown status';
}

/**
 * Canonical transfer status -> BEEP `statusCode`.
 *
 * A queued payout is 139 rather than 178: 139 is what `postPayment` answers
 * with, and the documentation is explicit that it is the *only* code that
 * triggers a callback. 178 is what a later `queryPaymentStatus` reports while
 * that callback is still outstanding.
 */
export function toBeepStatus(status: TransferStatus): number {
  switch (status) {
    case 'created':
    case 'pending':
      return TINGG_BEEP_STATUS.PENDING_ACKNOWLEDGEMENT;
    case 'processing':
      return TINGG_BEEP_STATUS.DELIVERED_TO_THIRD_PARTY;
    case 'successful':
      return TINGG_BEEP_STATUS.SUCCESS;
    case 'failed':
    case 'cancelled':
      return TINGG_BEEP_STATUS.REJECTED;
    // A returned payout is a reversal of a settled decision; Tingg has no
    // distinct code for it and reports the money back as a failure.
    case 'reversed':
      return TINGG_BEEP_STATUS.REJECTED;
  }
}

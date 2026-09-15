import type { PaymentStatus, TransferStatus } from '@paybox/shared';

/**
 * Canonical -> Quid Payments.
 *
 * A checkout session has five states, published as `CheckoutSessionStatusEnum`
 * (`docs.quiddpayments.com/openapi.json`, contract `2026-06`, read
 * 2026-09-15): `open`, `pending`, `success`, `failed`, `expired`.
 *
 * The distinction that matters, and the one this mapping exists to preserve,
 * is `open` vs `pending`. `open` means the session is payable and nobody has
 * tried yet; `pending` means an attempt is in flight on some rail and the
 * merchant must not fulfil. Quid's guide says so directly — "order remains
 * pending while `finalized` is false" — so collapsing the two would erase the
 * exact state a merchant integration is supposed to be tested against.
 *
 *   created / pending                     -> open
 *   processing / requires_action /
 *     authorized                          -> pending
 *   cancelled                             -> failed
 *
 * `cancelled` has no session-level equivalent: a payer abandoning a cash slip
 * or declining a prompt leaves the session `failed` at Quid, and the reason
 * travels on the attempt rather than the session.
 */
const TO_SESSION: Record<PaymentStatus, string> = {
  created: 'open',
  pending: 'open',
  processing: 'pending',
  requires_action: 'pending',
  authorized: 'pending',
  successful: 'success',
  failed: 'failed',
  cancelled: 'failed',
  expired: 'expired',
  // Quid has no refund API. A refunded collection is settled money that was
  // returned out of band, and the session that collected it stays `success`.
  refunded: 'success',
  partially_refunded: 'success',
};

export function toQuiddpaySessionStatus(status: PaymentStatus): string {
  return TO_SESSION[status];
}

/**
 * Is this session finished, as far as a merchant is concerned?
 *
 * Quid exposes exactly this as `finalized` on the attempt-status response, and
 * the fulfilment checklist is built on it. Deriving it here — rather than
 * storing a flag — keeps it from drifting away from the status it describes.
 */
export function isFinalized(status: PaymentStatus): boolean {
  const session = toQuiddpaySessionStatus(status);
  return session === 'success' || session === 'failed' || session === 'expired';
}

/**
 * The outcomes Quid's test simulator accepts, published as `OutcomeEnum`.
 *
 * These are Quid's own words for what a synthetic payment did, and they are
 * not the same vocabulary as the session status: `paid` settles a session to
 * `success`, while `manual_review` and `amount_mismatch` hold it at `pending`
 * because neither is a decision yet.
 */
export const QUIDDPAY_OUTCOMES = [
  'pending',
  'paid',
  'failed',
  'expired',
  'cancelled',
  'reversed',
  'manual_review',
  'amount_mismatch',
] as const;

export type QuiddpayOutcome = (typeof QUIDDPAY_OUTCOMES)[number];

/** Canonical -> the attempt's own status string. */
export function toAttemptStatus(status: PaymentStatus): string {
  switch (status) {
    case 'successful':
    case 'refunded':
    case 'partially_refunded':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}

/**
 * Payout status.
 *
 * Quid's six: `requested`, `processing`, `paid`, `failed`, `cancelled`,
 * `returned`. `reversed` maps to `returned` because that is what Quid calls a
 * payout that settled and then came back — "a paid payout can later be
 * returned" (docs.quiddpayments.com/webhooks, read 2026-09-15).
 */
export function toQuiddpayPayoutStatus(status: TransferStatus): string {
  switch (status) {
    case 'pending':
      return 'requested';
    case 'processing':
      return 'processing';
    case 'successful':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'reversed':
      return 'returned';
    default:
      return 'requested';
  }
}

/** The human label Quid puts beside the status on a payout object. */
export function payoutStatusLabel(status: string): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'processing':
      return 'Processing';
    case 'paid':
      return 'Paid';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'returned':
      return 'Returned';
    default:
      return status;
  }
}

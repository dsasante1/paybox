import type { PaymentStatus, RefundStatus } from '@paybox/shared';

/**
 * Stripe's PaymentIntent status vocabulary.
 *
 * Verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28) and the lifecycle documentation at
 * docs.stripe.com/payments/paymentintents/lifecycle.
 *
 * Note what is **not** here: there is no `failed`. A declined PaymentIntent
 * returns to `requires_payment_method` "so that the payment can be retried",
 * and `canceled` is the only state Stripe describes as irreversible. That is
 * why the engine grew a `retry` transition flag; see docs/architecture.md.
 */
export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

/**
 * Canonical -> Stripe.
 *
 * Four mappings deserve a note:
 *
 *   created          -> requires_payment_method  Nothing attached yet.
 *   authorized       -> requires_capture         Stripe's separate-capture
 *                                                state, which paybox already
 *                                                modelled as `authorized`.
 *   failed           -> requires_payment_method  A declined intent is alive and
 *                                                retryable; the failure is
 *                                                reported in
 *                                                `last_payment_error`.
 *   expired          -> canceled                 Stripe has no expired status;
 *                                                it cancels with
 *                                                `cancellation_reason:
 *                                                'expired'`.
 */
const TO_STRIPE: Record<PaymentStatus, StripePaymentIntentStatus> = {
  created: 'requires_payment_method',
  pending: 'requires_confirmation',
  processing: 'processing',
  requires_action: 'requires_action',
  authorized: 'requires_capture',
  successful: 'succeeded',
  failed: 'requires_payment_method',
  cancelled: 'canceled',
  expired: 'canceled',
  // A refund does not change a PaymentIntent's status at Stripe; the intent
  // stays `succeeded` and the money movement lives on the Refund object.
  refunded: 'succeeded',
  partially_refunded: 'succeeded',
};

const FROM_STRIPE: Record<StripePaymentIntentStatus, PaymentStatus> = {
  requires_payment_method: 'created',
  requires_confirmation: 'pending',
  requires_action: 'requires_action',
  processing: 'processing',
  requires_capture: 'authorized',
  succeeded: 'successful',
  canceled: 'cancelled',
};

export function toStripeStatus(status: PaymentStatus): StripePaymentIntentStatus {
  return TO_STRIPE[status];
}

export function fromStripeStatus(status: string): PaymentStatus | null {
  return FROM_STRIPE[status as StripePaymentIntentStatus] ?? null;
}

/**
 * A Charge's status, which is a different thing from its intent's.
 *
 * Charges are immutable attempt records: `failed` here is genuinely terminal,
 * even though the PaymentIntent that produced it is not.
 */
export type StripeChargeStatus = 'succeeded' | 'pending' | 'failed';

export function toStripeChargeStatus(status: PaymentStatus): StripeChargeStatus {
  if (status === 'successful' || status === 'refunded' || status === 'partially_refunded') {
    return 'succeeded';
  }
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed';
  return 'pending';
}

/**
 * Refund statuses. Stripe documents `pending`, `requires_action`, `succeeded`,
 * `failed` and `canceled`.
 *
 * paybox's canonical `needs_attention` -- a refund the processor cannot place
 * without more detail -- maps onto `requires_action`, which is the same idea.
 */
export function toStripeRefundStatus(status: RefundStatus): string {
  switch (status) {
    case 'successful':
      return 'succeeded';
    case 'needs_attention':
      return 'requires_action';
    case 'processing':
      return 'pending';
    default:
      return status;
  }
}

/**
 * Why a PaymentIntent was canceled.
 *
 * Stripe folds expiry into cancellation with a reason, where paybox has a
 * distinct `expired` status; this is where the two are reconciled.
 */
export function cancellationReason(status: PaymentStatus): string | null {
  if (status === 'expired') return 'abandoned';
  if (status === 'cancelled') return 'requested_by_customer';
  return null;
}

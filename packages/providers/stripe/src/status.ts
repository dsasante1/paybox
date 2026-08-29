import {
  PayboxError,
  type InvoiceStatus,
  type PaymentStatus,
  type PlanInterval,
  type RefundStatus,
  type SetupStatus,
  type SubscriptionStatus,
} from '@paybox/shared';

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
  if (
    status === 'successful' ||
    status === 'refunded' ||
    status === 'partially_refunded' ||
    // An authorized-but-uncaptured charge is `succeeded` at Stripe, with
    // `captured: false` carrying the distinction and `paid` documented as
    // "true if the charge succeeded, or was successfully authorized for later
    // capture". The status is not where the two are told apart.
    status === 'authorized'
  ) {
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


/**
 * SetupIntent status: canonical -> Stripe.
 *
 * Stripe's enum is `requires_payment_method | requires_confirmation |
 * requires_action | processing | succeeded | canceled` -- note the absence of
 * a failure state, exactly as on PaymentIntents. A setup that is declined
 * returns to `requires_payment_method` and reports why in `last_setup_error`,
 * so the merchant can confirm again with another instrument.
 *
 * Verified against `stripe/openapi` `openapi/spec3.json` schema `setup_intent`
 * (API version 2026-08-26.dahlia, read 2026-08-28).
 */
export function toStripeSetupStatus(status: SetupStatus): string {
  switch (status) {
    case 'created':
      return 'requires_payment_method';
    case 'pending':
      return 'requires_confirmation';
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'successful':
      return 'succeeded';
    case 'cancelled':
      return 'canceled';
    // No `failed` at Stripe: a declined setup is alive and retryable.
    case 'failed':
      return 'requires_payment_method';
  }
}

/**
 * Subscription status: canonical -> Stripe.
 *
 * Stripe's enum is `active | canceled | incomplete | incomplete_expired |
 * past_due | paused | trialing | unpaid`. Two mappings deserve a note:
 *
 *   trialing      -> trialing   Exists, will bill, has not yet.
 *   attention     -> past_due   A renewal failed and the merchant must act.
 *   non_renewing  -> active     Stripe expresses "stops at period end" as a
 *                               *flag* (`cancel_at_period_end`), not a status,
 *                               so the status stays active and the serializer
 *                               sets the flag.
 *   completed     -> canceled   Stripe has no completed state; a subscription
 *                               that has run its course is simply canceled.
 */
export function toStripeSubscriptionStatus(status: SubscriptionStatus): string {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'attention':
      return 'past_due';
    case 'non_renewing':
      return 'active';
    case 'completed':
    case 'cancelled':
      return 'canceled';
    default:
      return 'active';
  }
}

/**
 * Invoice status: canonical -> Stripe.
 *
 * Stripe's enum is `draft | open | paid | uncollectible | void`. A *failed*
 * invoice stays `open` there, because Stripe keeps retrying it -- the same
 * "failure is not final" theme that runs through its PaymentIntents.
 */
export function toStripeInvoiceStatus(status: InvoiceStatus): string {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'success':
      return 'paid';
    case 'void':
      return 'void';
    case 'uncollectible':
      return 'uncollectible';
    // A *failed attempt* leaves the invoice open at Stripe -- the status
    // describes the invoice, not the attempt, and Stripe keeps retrying it.
    case 'failed':
    case 'pending':
      return 'open';
  }
}

/** Canonical interval + count -> Stripe's `recurring` object. */
export function toStripeRecurring(
  interval: PlanInterval,
  intervalCount: number,
): { interval: string; interval_count: number } {
  switch (interval) {
    case 'daily':
      return { interval: 'day', interval_count: intervalCount };
    case 'weekly':
      return { interval: 'week', interval_count: intervalCount };
    case 'annually':
      return { interval: 'year', interval_count: intervalCount };
    // Stripe has no half-yearly interval; it writes six months.
    case 'biannually':
      return { interval: 'month', interval_count: intervalCount * 6 };
    default:
      return { interval: 'month', interval_count: intervalCount };
  }
}

/** Stripe's `recurring` -> canonical interval + count. */
export function fromStripeRecurring(
  interval: string,
  intervalCount: number,
): { interval: PlanInterval; intervalCount: number } {
  const count = Number.isInteger(intervalCount) && intervalCount > 0 ? intervalCount : 1;
  switch (interval) {
    case 'day':
      return { interval: 'daily', intervalCount: count };
    case 'week':
      return { interval: 'weekly', intervalCount: count };
    case 'year':
      return { interval: 'annually', intervalCount: count };
    case 'month':
      return { interval: 'monthly', intervalCount: count };
    default:
      throw new PayboxError(
        'validation_failed',
        `Unknown recurring interval "${interval}". Expected day, week, month or year.`,
      );
  }
}

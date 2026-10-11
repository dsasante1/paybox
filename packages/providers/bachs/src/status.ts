import type { InvoiceStatus, PaymentStatus, RefundStatus, SubscriptionStatus } from '@paybox/shared';

/**
 * Bachs' status vocabularies.
 *
 * Bachs reports one payment in at least four vocabularies that disagree, and
 * an integration written against it branches on each one, so every one is
 * reproduced rather than reconciled (docs/bachs.md tabulates them):
 *
 *   payment object     lowercase, 12 values      PaymentResponse.status
 *   checkout session   open|completed|expired|cancelled
 *   checkout payment   requires_payment_method|... |canceled (one L)
 *   webhook data       UPPERCASE                  "do not compare the values
 *                                                  directly" (event pages)
 *
 * The statuses guide (/guides/payments/statuses) describes a fifth,
 * `open`/`incomplete` with a `substatus`, which appears nowhere in the
 * OpenAPI spec. The spec wins for REST shapes, so the API returns the spec's
 * values; the guide's are recorded as a contradiction.
 *
 * Every function here is pure and computed from the canonical status at
 * serialisation time. Only `PaymentResponse.status` is stored, as
 * `providerStatus`, because three of its values -- `underpaid`, `overpaid`,
 * `accepted` -- carry more than the canonical status can.
 */

export const BACHS_PAYMENT_STATUSES = [
  'created',
  'processing',
  'succeeded',
  'accepted',
  'failed',
  'expired',
  'cancelled',
  'refunded',
  'partially_refunded',
  'auto_refunded',
  'underpaid',
  'overpaid',
] as const;
export type BachsPaymentStatus = (typeof BACHS_PAYMENT_STATUSES)[number];

/**
 * Canonical -> `PaymentResponse.status`, for transitions that do not name one.
 *
 * `created` covers everything still waiting on the payer -- "the charge exists
 * and no attempt has succeeded yet" -- including a transfer not yet sent and a
 * prompt not yet approved. `processing` is reserved for "an attempt is in
 * flight and is being verified".
 */
export function toBachsPaymentStatus(status: PaymentStatus): BachsPaymentStatus {
  switch (status) {
    case 'created':
    case 'pending':
    case 'requires_action':
      return 'created';
    case 'processing':
    case 'authorized':
      return 'processing';
    case 'successful':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partially_refunded';
  }
}

/** The stored provider status, trusting it only when it is one of Bachs' own. */
export function paymentStatusOf(payment: {
  status: PaymentStatus;
  providerStatus: string;
  amountRefunded?: number;
  paymentMethodDetails?: Record<string, unknown>;
}): BachsPaymentStatus {
  // A refund moves the canonical status on, and nothing about `overpaid` or
  // `accepted` survives it, so a refunded payment reads as refunded. An
  // accepted underpayment is fully refunded once what was *paid* is back,
  // though the engine, comparing against the requested amount, says partial.
  if (payment.status === 'partially_refunded') {
    const paid = payment.paymentMethodDetails?.amount_paid;
    if (typeof paid === 'number' && (payment.amountRefunded ?? 0) >= paid) return 'refunded';
    return 'partially_refunded';
  }
  if (payment.status === 'refunded') return 'refunded';
  const stored = payment.providerStatus as BachsPaymentStatus;
  if ((BACHS_PAYMENT_STATUSES as readonly string[]).includes(stored)) {
    // A stored value is only good while the canonical status still agrees
    // with it: paybox's own tooling can move a payment without naming a
    // provider status, and the projection must follow the payment.
    if (toBachsPaymentStatus(payment.status) === stored) return stored;
    if (stored === 'underpaid' && payment.status === 'processing') return stored;
    if ((stored === 'overpaid' || stored === 'accepted') && payment.status === 'successful') {
      return stored;
    }
  }
  return toBachsPaymentStatus(payment.status);
}

export type CheckoutStatus = 'open' | 'completed' | 'expired' | 'cancelled';

/**
 * A checkout session's status, from its payment.
 *
 * A failed attempt leaves the checkout open -- "the checkout stays open, and
 * the customer can try again or choose another payment method"
 * (collection.failed) -- and so does an underpayment. Only a settled, expired
 * or cancelled payment closes it.
 */
export function checkoutStatusFor(status: PaymentStatus): CheckoutStatus {
  switch (status) {
    case 'successful':
    case 'refunded':
    case 'partially_refunded':
      return 'completed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'open';
  }
}

export type CheckoutPaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/** `CheckoutSessionApiResponse.payment_status` -- note `canceled`, one L, as published. */
export function checkoutPaymentStatusFor(status: PaymentStatus | null): CheckoutPaymentStatus | null {
  switch (status) {
    case null:
    case 'created':
      return 'requires_payment_method';
    case 'pending':
    case 'requires_action':
      return 'requires_action';
    case 'processing':
    case 'authorized':
      return 'processing';
    case 'successful':
    case 'refunded':
    case 'partially_refunded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'expired':
      // checkout.expired: "payment_status: Always null. An expired checkout
      // never collected payment."
      return null;
  }
}

/** Webhook `data.status`: the payment status, uppercased. */
export function webhookStatus(status: BachsPaymentStatus): string {
  return status.toUpperCase();
}

export type BachsRefundStatus = 'processing' | 'success' | 'failed';

/** `RefundResponse.status` (spec): `processing`, `success`, `failed`. */
export function toBachsRefundStatus(status: RefundStatus): BachsRefundStatus {
  switch (status) {
    case 'successful':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
}

/**
 * The refund status in `refund.*` webhooks.
 *
 * The event pages say `paid` where the REST object says `success`
 * (guides/webhooks/events/refund-paid vs RefundResponse). Webhook payloads
 * follow the event pages, so the two are allowed to differ, as they do at
 * Bachs.
 */
export function toBachsRefundEventStatus(status: RefundStatus): 'processing' | 'paid' | 'failed' {
  switch (status) {
    case 'successful':
      return 'paid';
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
}

/** A human message for `PaymentResponse.message`, which the spec says is "derived from status". */
export function paymentMessage(status: BachsPaymentStatus): string {
  switch (status) {
    case 'succeeded':
    case 'accepted':
    case 'overpaid':
      return 'Successful';
    case 'created':
      return 'Awaiting payment';
    case 'processing':
      return 'Processing';
    case 'underpaid':
      return 'Underpaid';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
    case 'cancelled':
      return 'Cancelled';
    case 'refunded':
    case 'auto_refunded':
      return 'Refunded';
    case 'partially_refunded':
      return 'Partially refunded';
  }
}

/* ------------------------------ subscriptions ------------------------------ */

/**
 * `SubscriptionResponse.status`. "A subscription is always in exactly one
 * status" (guides/subscriptions/overview). `paused` is in the OpenAPI enum
 * and nowhere else -- no endpoint pauses or resumes -- so it is never
 * produced.
 */
export type BachsSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'paused';

/**
 * A projection, never stored: canonical `attention` is `past_due` while
 * recovery runs and `unpaid` once it ran out on an account that keeps unpaid
 * subscriptions; a future `trial_end` reads `trialing` even on a subscription
 * the core still calls active ("This works even on an active subscription,
 * which becomes trialing"). paybox's generic tooling can move the core row
 * (`non_renewing`, `completed`) and the projection follows it.
 */
export function subscriptionStatusOf(
  core: { status: SubscriptionStatus },
  stored: { trialEnd: string | null; exhausted: boolean; owing?: boolean } | null,
  now: number,
): BachsSubscriptionStatus {
  if (core.status === 'cancelled' || core.status === 'completed') return 'canceled';
  if (stored?.owing) return stored.exhausted ? 'unpaid' : 'past_due';
  switch (core.status) {
    case 'attention':
      return stored?.exhausted ? 'unpaid' : 'past_due';
    case 'trialing':
      return 'trialing';
    default:
      return stored?.trialEnd && Date.parse(stored.trialEnd) > now ? 'trialing' : 'active';
  }
}

/**
 * The invoice status on `invoice.*` webhooks: `draft`, `open`, `paid`,
 * `uncollectible` or `void`. An invoice still being collected -- including
 * one whose attempts have failed and are being retried -- is `open`.
 */
export function invoiceStatusOf(status: InvoiceStatus): 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' {
  if (status === 'success') return 'paid';
  if (status === 'draft' || status === 'void' || status === 'uncollectible') return status;
  return 'open';
}

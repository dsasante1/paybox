/**
 * Canonical payment status (spec §4).
 *
 * Providers do NOT share a status vocabulary. Paystack says "success",
 * Stripe says "succeeded", Flutterwave says "successful". We store both:
 * this canonical value drives the state machine and the engine, while the
 * verbatim provider string is preserved on the row so the adapter can echo
 * it back at the API boundary without a lossy round-trip (spec §4).
 */
export const PAYMENT_STATUSES = [
  'created',
  'pending',
  'processing',
  'requires_action',
  'authorized',
  'successful',
  'failed',
  'cancelled',
  'expired',
  'refunded',
  'partially_refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  'failed',
  'cancelled',
  'expired',
  'refunded',
]);

export const REFUND_STATUSES = ['pending', 'processing', 'successful', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const TRANSFER_STATUSES = [
  'created',
  'pending',
  'processing',
  'successful',
  'failed',
  'reversed',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/**
 * Subscription lifecycle.
 *
 * Canonical spelling is snake_case; Paystack writes `non-renewing` with a
 * hyphen and the adapter maps to it, the same way it maps `successful` to
 * `success`. `attention` is where a subscription lands when a renewal fails --
 * it is still alive, but the merchant has to do something about it.
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'non_renewing',
  'attention',
  'completed',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** One billing attempt against a subscription. */
export const INVOICE_STATUSES = ['pending', 'success', 'failed'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Billing intervals.
 *
 * Exactly the enum in Paystack's `PlanCreate.interval` and no more. Paystack's
 * prose mentions other cadences in places, but the OpenAPI specification is the
 * source this project verifies against, and adding one it does not list would
 * be inventing provider behaviour.
 */
export const PLAN_INTERVALS = [
  'daily',
  'weekly',
  'monthly',
  'biannually',
  'annually',
] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export const PAYMENT_METHODS = [
  'card',
  'mobile_money',
  'bank',
  'bank_transfer',
  'ussd',
  'eft',
  'qr',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PROVIDERS = ['paystack', 'stripe', 'flutterwave', 'kora'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

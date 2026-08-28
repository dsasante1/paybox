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

/**
 * Refund lifecycle.
 *
 * `needs_attention` is Paystack's `needs-attention`: the processor could not
 * find an account to credit and the merchant must supply bank details before
 * the refund can proceed. It is a real, recoverable state with its own webhook
 * and its own retry endpoint -- not an error.
 *
 * Canonical spelling is snake_case; the adapter hyphenates. `successful` maps
 * to Paystack's `processed`.
 */
export const REFUND_STATUSES = [
  'pending',
  'processing',
  'needs_attention',
  'successful',
  'failed',
] as const;
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
 *
 * `trialing` is a subscription that exists and will bill, but has not yet.
 * Modelling it as a status rather than as "active with a future date" is what
 * lets a merchant's dunning and access logic tell "paying" from "trying" --
 * which is the distinction the whole free-trial pattern turns on. Paystack has
 * no trial concept, so its adapter never produces one.
 */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'non_renewing',
  'attention',
  'completed',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Setting up an instrument for later, without moving money.
 *
 * The vocabulary deliberately mirrors the payment one: `created` is "nothing
 * attached yet", `successful` means the instrument is stored and chargeable.
 * `failed` is canonical even though Stripe has no such SetupIntent status --
 * a failed setup there returns to `requires_payment_method` and reports the
 * reason in `last_setup_error`, exactly as its PaymentIntents do. The adapter
 * maps it, the same way it does for payments.
 */
export const SETUP_STATUSES = [
  'created',
  'pending',
  'processing',
  'requires_action',
  'successful',
  'failed',
  'cancelled',
] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/**
 * An invoice's life.
 *
 * `pending` is an invoice that has been issued and is awaiting payment --
 * Stripe calls that `open`, Paystack calls it `pending`. The three additions
 * beyond Paystack's vocabulary are the ones an invoice needs once it can be
 * built by hand rather than only raised by a billing run:
 *
 *   draft          Being assembled. Not owed yet, and still editable.
 *   void           Cancelled. The money was never owed after all.
 *   uncollectible  Owed, given up on. A bookkeeping outcome, not a failure --
 *                  and reversible, because a customer can still pay late.
 *
 * `failed` is a payment attempt that did not succeed, which leaves the invoice
 * still owed; Stripe keeps such an invoice `open` and the adapter maps it back.
 */
export const INVOICE_STATUSES = [
  'draft',
  'pending',
  'success',
  'failed',
  'void',
  'uncollectible',
] as const;
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

/**
 * Chargeback lifecycle.
 *
 * Canonical spelling is snake_case; Paystack hyphenates
 * (`awaiting-merchant-feedback`) and the adapter maps to it. The four values
 * are exactly the enum on `GET /dispute`'s `status` parameter in the pinned
 * OpenAPI spec.
 */
export const DISPUTE_STATUSES = [
  'awaiting_merchant_feedback',
  'awaiting_bank_feedback',
  'pending',
  'resolved',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** Schema `DisputeResolve.resolution`. */
export const DISPUTE_RESOLUTIONS = ['merchant-accepted', 'declined'] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

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

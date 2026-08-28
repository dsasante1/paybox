import { z } from 'zod';

/**
 * Request schemas for Stripe's form-encoded bodies.
 *
 * Everything arrives as a string over `application/x-www-form-urlencoded`, so
 * numeric and boolean fields are coerced rather than declared. Nested keys are
 * expanded by `expandFormBody` before validation.
 *
 * Verified against `stripe/openapi` `openapi/spec3.json`, read 2026-08-28.
 */

/** Stripe amounts are integer minor units, sent as a string. */
const amount = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Amount must be a positive integer.' });
    return z.NEVER;
  }
  return parsed;
});

const optionalAmount = amount.optional();

/** Accepts Stripe's `true`/`false` and `1`/`0`. */
const formBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return undefined;
  });

const metadata = z.record(z.string(), z.unknown()).optional();

/** Inline card details, as `payment_method_data[card][number]`. */
const cardData = z.object({
  number: z.string().min(12),
  exp_month: z.union([z.number(), z.string()]).optional(),
  exp_year: z.union([z.number(), z.string()]).optional(),
  cvc: z.string().optional(),
});

const paymentMethodData = z.object({
  type: z.string().default('card'),
  card: cardData.optional(),
  billing_details: z.record(z.string(), z.unknown()).optional(),
  metadata,
});

export const paymentIntentCreateSchema = z.object({
  amount,
  currency: z.string().min(3).max(3),
  customer: z.string().optional(),
  description: z.string().optional(),
  receipt_email: z.string().optional(),
  metadata,
  payment_method: z.string().optional(),
  payment_method_data: paymentMethodData.optional(),
  payment_method_types: z.array(z.string()).optional(),
  capture_method: z.enum(['automatic', 'automatic_async', 'manual']).optional(),
  confirmation_method: z.enum(['automatic', 'manual']).optional(),
  confirm: formBool,
  return_url: z.string().optional(),
  setup_future_usage: z.enum(['on_session', 'off_session']).optional(),
  expand: z.array(z.string()).optional(),
});

export const paymentIntentUpdateSchema = z.object({
  amount: optionalAmount,
  currency: z.string().min(3).max(3).optional(),
  description: z.string().optional(),
  metadata,
  payment_method: z.string().optional(),
  receipt_email: z.string().optional(),
});

export const paymentIntentConfirmSchema = z.object({
  payment_method: z.string().optional(),
  payment_method_data: paymentMethodData.optional(),
  return_url: z.string().optional(),
  receipt_email: z.string().optional(),
  setup_future_usage: z.enum(['on_session', 'off_session']).optional(),
  expand: z.array(z.string()).optional(),
});

export const paymentIntentCaptureSchema = z.object({
  amount_to_capture: optionalAmount,
  expand: z.array(z.string()).optional(),
});

export const paymentIntentCancelSchema = z.object({
  cancellation_reason: z
    .enum(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'])
    .optional(),
});

export const refundCreateSchema = z.object({
  charge: z.string().optional(),
  payment_intent: z.string().optional(),
  amount: optionalAmount,
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
  metadata,
});

/**
 * Invoices you build by hand.
 *
 * A draft is assembled from invoice items, finalised (which is when the money
 * becomes owed), then paid, voided or written off.
 */
export const invoiceCreateSchema = z.object({
  customer: z.string().min(1),
  subscription: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
  description: z.string().optional(),
  /** Stripe's flag for "finalise this automatically". */
  auto_advance: formBool,
  collection_method: z.enum(['charge_automatically', 'send_invoice']).optional(),
  days_until_due: z.union([z.number(), z.string()]).optional(),
  metadata,
});

export const invoiceUpdateSchema = z.object({
  description: z.string().optional(),
  auto_advance: formBool,
  days_until_due: z.union([z.number(), z.string()]).optional(),
  metadata,
});

export const invoicePaySchema = z.object({
  payment_method: z.string().optional(),
  source: z.string().optional(),
  /** Settle the invoice without taking money -- Stripe's "pay out of band". */
  paid_out_of_band: formBool,
});

export const invoiceFinalizeSchema = z.object({ auto_advance: formBool });

export const invoiceVoidSchema = z.object({});

/**
 * A line item.
 *
 * With no `invoice` the item is *pending*: it waits for the next invoice to
 * be finalised, which is how Stripe carries a mid-cycle change forward onto
 * the customer's next bill instead of raising one of its own.
 */
export const invoiceItemCreateSchema = z.object({
  customer: z.string().min(1),
  invoice: z.string().optional(),
  subscription: z.string().optional(),
  price: z.string().optional(),
  /** Signed: a negative amount is a credit. Not the positive-only `amount`. */
  amount: z.union([z.number(), z.string()]).optional(),
  unit_amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().min(3).max(3).optional(),
  description: z.string().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  period: z.object({ start: z.union([z.number(), z.string()]).optional(), end: z.union([z.number(), z.string()]).optional() }).optional(),
  metadata,
});

/**
 * SetupIntents: store an instrument without charging it.
 *
 * `usage` is Stripe's own field and matters -- an off-session mandate is the
 * one that lets a merchant charge while the customer is away, which is the
 * whole reason to run a setup rather than just a charge.
 */
export const setupIntentCreateSchema = z.object({
  customer: z.string().optional(),
  payment_method: z.string().optional(),
  payment_method_data: paymentMethodData.optional(),
  payment_method_types: z.array(z.string()).optional(),
  usage: z.enum(['on_session', 'off_session']).optional(),
  description: z.string().optional(),
  confirm: formBool,
  return_url: z.string().optional(),
  metadata,
});

export const setupIntentUpdateSchema = z.object({
  customer: z.string().optional(),
  description: z.string().optional(),
  payment_method: z.string().optional(),
  metadata,
});

export const setupIntentConfirmSchema = z.object({
  payment_method: z.string().optional(),
  payment_method_data: paymentMethodData.optional(),
  return_url: z.string().optional(),
});

export const setupIntentCancelSchema = z.object({
  cancellation_reason: z.enum(['abandoned', 'requested_by_customer', 'duplicate']).optional(),
});

/**
 * The legacy Charges API.
 *
 * Deprecated at Stripe in favour of PaymentIntents but still in wide use, and
 * still in the specification (`PostCharges`). Synchronous: the response says
 * whether the money moved, so a decline is a 402 rather than a 200 carrying a
 * retryable object.
 */
export const chargeCreateSchema = z.object({
  amount,
  currency: z.string().min(3).max(3),
  customer: z.string().optional(),
  /** A stored instrument. paybox accepts its own `pm_` ids; see docs/stripe.md. */
  source: z.string().optional(),
  /** Inline card details, which this endpoint (unlike PaymentIntents) takes. */
  card: cardData.optional(),
  description: z.string().optional(),
  receipt_email: z.string().optional(),
  statement_descriptor: z.string().optional(),
  transfer_group: z.string().optional(),
  /** Defaults to true. False authorizes now and captures later. */
  capture: formBool,
  metadata,
});

export const chargeUpdateSchema = z.object({
  customer: z.string().optional(),
  description: z.string().optional(),
  receipt_email: z.string().optional(),
  transfer_group: z.string().optional(),
  metadata,
});

export const chargeCaptureSchema = z.object({
  amount: optionalAmount,
  receipt_email: z.string().optional(),
  statement_descriptor: z.string().optional(),
});

export const customerCreateSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  description: z.string().optional(),
  metadata,
});

export const paymentMethodCreateSchema = z.object({
  type: z.string().default('card'),
  card: cardData.optional(),
  billing_details: z.record(z.string(), z.unknown()).optional(),
  metadata,
});

export const paymentMethodAttachSchema = z.object({
  customer: z.string().min(1),
});

/**
 * Stripe's cursor pagination.
 *
 * `starting_after` and `ending_before` are **object ids**, not offsets. The
 * adapter translates them; paybox's repositories page by offset.
 */
export const listQuerySchema = z.object({
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      const parsed = value === undefined ? 10 : Number(value);
      if (!Number.isFinite(parsed)) return 10;
      // Stripe's documented bounds.
      return Math.min(Math.max(Math.trunc(parsed), 1), 100);
    }),
  starting_after: z.string().optional(),
  ending_before: z.string().optional(),
  customer: z.string().optional(),
});

/**
 * Checkout Sessions.
 *
 * Only `mode: payment` is implemented in this slice. Line items arrive as
 * `line_items[0][price_data][unit_amount]` and friends, which the form
 * expander turns into an array of objects before this runs.
 */
const priceData = z.object({
  currency: z.string().min(3).max(3),
  unit_amount: amount,
  product_data: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
    })
    .optional(),
});

const lineItem = z.object({
  price_data: priceData.optional(),
  price: z.string().optional(),
  quantity: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      const parsed = value === undefined ? 1 : Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
    }),
});

export const checkoutSessionCreateSchema = z.object({
  mode: z.enum(['payment', 'setup', 'subscription']).default('payment'),
  success_url: z.string().optional(),
  cancel_url: z.string().optional(),
  return_url: z.string().optional(),
  client_reference_id: z.string().optional(),
  customer: z.string().optional(),
  customer_email: z.string().email().optional(),
  line_items: z.array(lineItem).min(1),
  currency: z.string().min(3).max(3).optional(),
  metadata,
  expires_at: z.union([z.number(), z.string()]).optional(),
});

/** The hosted page's own form. Not a Stripe API shape. */
export const checkoutPaySchema = z.object({
  card_number: z.string().min(12),
  exp_month: z.string().optional(),
  exp_year: z.string().optional(),
});

/** Products, Prices and Subscriptions. */
export const productCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  active: formBool,
  metadata,
});

export const priceCreateSchema = z.object({
  currency: z.string().min(3).max(3),
  unit_amount: amount,
  product: z.string().optional(),
  product_data: z
    .object({ name: z.string().min(1), description: z.string().optional() })
    .optional(),
  nickname: z.string().optional(),
  recurring: z
    .object({
      interval: z.enum(['day', 'week', 'month', 'year']),
      interval_count: z
        .union([z.number(), z.string()])
        .optional()
        .transform((value) => {
          const parsed = value === undefined ? 1 : Number(value);
          return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
        }),
    })
    .optional(),
  metadata,
});

export const subscriptionCreateSchema = z.object({
  customer: z.string().min(1),
  items: z
    .array(
      z.object({
        price: z.string().min(1),
        quantity: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .min(1),
  default_payment_method: z.string().optional(),
  metadata,
});

export const subscriptionUpdateSchema = z.object({
  cancel_at_period_end: formBool,
  default_payment_method: z.string().optional(),
  metadata,
});

export const subscriptionCancelSchema = z.object({
  invoice_now: formBool,
  prorate: formBool,
});

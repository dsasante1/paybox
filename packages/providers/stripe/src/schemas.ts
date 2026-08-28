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

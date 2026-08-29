import { z } from 'zod';

/**
 * Request schemas for Kora.
 *
 * Verified against the Kora Public APIs Postman collection (docs.korapay.com,
 * collection 303979/SVzxXeSM, read 2026-08-29).
 *
 * Kora sends **major-unit amounts**, sometimes as numbers and sometimes as
 * fixed-2 strings. Converting at the boundary is the adapter's job: the engine
 * only ever sees integer minor units.
 */
export const majorAmount = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Amount must be a positive number.' });
    return z.NEVER;
  }
  // Rounded, not truncated: upstream floating-point arithmetic must not
  // silently shave a minor unit off every charge.
  return Math.round(parsed * 100);
});

const currency = z.string().min(3).max(3);

const customer = z.object({
  name: z.string().optional(),
  email: z.string().email(),
});

export const initializeSchema = z.object({
  reference: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  customer,
  narration: z.string().optional(),
  notification_url: z.string().optional(),
  redirect_url: z.string().optional(),
  channels: z.array(z.string()).optional(),
  default_channel: z.string().optional(),
  merchant_bears_cost: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** The card charge envelope: details arrive encrypted in `charge_data`. */
export const encryptedChargeSchema = z.object({
  charge_data: z.string().min(1).optional(),
});

export const cardChargeSchema = z.object({
  reference: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  customer,
  card: z.object({
    number: z.string().min(12),
    cvv: z.string().optional(),
    expiry_month: z.union([z.string(), z.number()]).optional(),
    expiry_year: z.union([z.string(), z.number()]).optional(),
    pin: z.string().optional(),
    name: z.string().optional(),
  }),
  redirect_url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const authorizeChargeSchema = z.object({
  transaction_reference: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  authorization: z
    .object({ pin: z.string().optional(), otp: z.string().optional() })
    .optional(),
  token: z.string().optional(),
  pin: z.string().optional(),
});

export const bankTransferSchema = z.object({
  reference: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  customer,
  account_name: z.string().optional(),
  narration: z.string().optional(),
  notification_url: z.string().optional(),
  merchant_bears_cost: z.boolean().optional(),
});

export const mobileMoneySchema = z.object({
  reference: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  customer,
  mobile_money: z.object({ number: z.string().min(3) }),
  description: z.string().optional(),
  notification_url: z.string().optional(),
  redirect_url: z.string().optional(),
  merchant_bears_cost: z.boolean().optional(),
});

export const refundSchema = z.object({
  payment_reference: z.string().min(1),
  amount: majorAmount.optional(),
  reference: z.string().optional(),
  reason: z.string().optional(),
  webhook_url: z.string().optional(),
});

const payoutDestination = z.object({
  type: z.enum(['bank_account', 'mobile_money']),
  amount: majorAmount,
  currency: currency.optional(),
  narration: z.string().optional(),
  bank_account: z
    .object({ bank: z.string().optional(), bank_code: z.string().optional(), account: z.string().optional(), account_number: z.string().optional() })
    .optional(),
  mobile_money: z
    .object({ operator: z.string().optional(), mobile_number: z.string().optional() })
    .optional(),
  customer: customer.partial({ email: true }).optional(),
});

export const disburseSchema = z.object({
  reference: z.string().min(1),
  destination: payoutDestination,
});

export const virtualAccountSchema = z.object({
  account_name: z.string().min(1),
  account_reference: z.string().min(1),
  permanent: z.boolean().optional(),
  bank_code: z.string().optional(),
  customer,
  kyc: z.record(z.string(), z.unknown()).optional(),
});

export const creditVirtualAccountSchema = z.object({
  account_number: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
});

export const resolveBankSchema = z.object({
  bank: z.string().min(1),
  account: z.string().min(1),
});

/** The hosted checkout page's own form. Not a Kora API shape. */
export const checkoutPaySchema = z.object({
  card_number: z.string().min(12),
  exp_month: z.string().optional(),
  exp_year: z.string().optional(),
});

/* ---------------------------------------------------------------- *
 * Depth: bulk payouts and cursor-paged listing
 * ---------------------------------------------------------------- */

const bulkPayout = z.object({
  reference: z.string().min(1),
  amount: majorAmount,
  type: z.enum(['bank_account', 'mobile_money']).default('bank_account'),
  narration: z.string().optional(),
  bank_account: z
    .object({ bank: z.string().optional(), bank_code: z.string().optional(), account: z.string().optional(), account_number: z.string().optional() })
    .optional(),
  mobile_money: z
    .object({ operator: z.string().optional(), mobile_number: z.string().optional() })
    .optional(),
  customer: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
});

export const bulkDisburseSchema = z.object({
  batch_reference: z.string().min(1),
  description: z.string().optional(),
  currency: currency.optional(),
  merchant_bears_cost: z.boolean().optional(),
  payouts: z.array(bulkPayout).min(1),
});

/**
 * Kora's cursor pagination.
 *
 * Each row carries an opaque `pointer`, and `starting_after` names the pointer
 * to resume from -- so the cursor is a row identity, not an offset. `limit`
 * bounds the page and `has_more` says whether another exists.
 */
export const koraListQuerySchema = z.object({
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      const parsed = value === undefined ? 10 : Number(value);
      if (!Number.isFinite(parsed)) return 10;
      return Math.min(Math.max(Math.trunc(parsed), 1), 100);
    }),
  starting_after: z.string().optional(),
});

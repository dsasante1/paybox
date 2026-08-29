import { z } from 'zod';

/**
 * Request schemas for Flutterwave v3.
 *
 * Verified against developer.flutterwave.com/v3.0.0/docs (read 2026-08-29).
 *
 * Flutterwave sends **major-unit decimal amounts as strings** ("7500" or
 * "75.50"), not integer minor units. Converting at the boundary is this
 * adapter's job: the engine only ever sees integer minor units, which is what
 * keeps rounding out of the domain model entirely.
 */

/** "75.50" or 75.5 -> 7550 minor units. */
export const majorAmount = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Amount must be a positive number.' });
      return z.NEVER;
    }
    // Rounded, not truncated: 0.1 + 0.2 arithmetic upstream must not silently
    // shave a minor unit off every charge.
    return Math.round(parsed * 100);
  });

const metadata = z.record(z.string(), z.unknown()).optional();

const currency = z.string().min(3).max(3);

/** The Standard checkout payload: `POST /v3/payments`. */
export const paymentsInitiateSchema = z.object({
  tx_ref: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  redirect_url: z.string().optional(),
  payment_options: z.string().optional(),
  customer: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    phonenumber: z.string().optional(),
  }),
  customizations: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      logo: z.string().optional(),
    })
    .optional(),
  subaccounts: z
    .array(z.object({ id: z.string(), transaction_split_ratio: z.union([z.number(), z.string()]).optional() }))
    .optional(),
  meta: metadata,
});

/**
 * A direct card charge.
 *
 * The card details arrive 3DES-encrypted in `client`; everything else is
 * plaintext. paybox also accepts the *decrypted* shape directly, because a
 * developer poking at the emulator with curl should not have to hand-encrypt a
 * payload — docs/flutterwave.md records that as an emulator convenience.
 */
export const encryptedChargeSchema = z.object({
  client: z.string().min(1).optional(),
});

export const cardChargeSchema = z.object({
  card_number: z.string().min(12),
  cvv: z.string().optional(),
  expiry_month: z.union([z.string(), z.number()]).optional(),
  expiry_year: z.union([z.string(), z.number()]).optional(),
  currency: currency.optional(),
  amount: majorAmount,
  email: z.string().email(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  card_holder_name: z.string().optional(),
  tx_ref: z.string().min(1),
  redirect_url: z.string().optional(),
  preauthorize: z.boolean().optional(),
  /** Sent on the second call, once the mode is known. */
  pin: z.string().optional(),
  otp: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  zipcode: z.string().optional(),
  meta: metadata,
});

/** Mobile money, bank transfer, USSD and the other non-card rails. */
export const railChargeSchema = z.object({
  tx_ref: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  email: z.string().email(),
  fullname: z.string().optional(),
  phone_number: z.string().optional(),
  network: z.string().optional(),
  account_bank: z.string().optional(),
  account_number: z.string().optional(),
  voucher: z.string().optional(),
  redirect_url: z.string().optional(),
  meta: metadata,
});

export const validateChargeSchema = z.object({
  otp: z.string().min(1),
  flw_ref: z.string().min(1),
  type: z.string().optional(),
});

export const refundSchema = z.object({
  amount: majorAmount.optional(),
  comments: z.string().optional(),
});

export const transferSchema = z.object({
  account_bank: z.string().min(1),
  account_number: z.string().min(1),
  amount: majorAmount,
  currency: currency.optional(),
  narration: z.string().optional(),
  reference: z.string().optional(),
  beneficiary_name: z.string().optional(),
  callback_url: z.string().optional(),
  debit_currency: currency.optional(),
  meta: metadata,
});

export const paymentPlanSchema = z.object({
  amount: majorAmount,
  name: z.string().min(1),
  interval: z.string().min(1),
  duration: z.union([z.number(), z.string()]).optional(),
  currency: currency.optional(),
});

export const paymentPlanUpdateSchema = z.object({
  name: z.string().optional(),
  status: z.enum(['active', 'cancelled']).optional(),
});

export const subaccountSchema = z.object({
  account_bank: z.string().min(1),
  account_number: z.string().min(1),
  business_name: z.string().min(1),
  business_email: z.string().email().optional(),
  business_contact: z.string().optional(),
  business_contact_mobile: z.string().optional(),
  business_mobile: z.string().optional(),
  country: z.string().optional(),
  split_type: z.enum(['percentage', 'flat']).optional(),
  split_value: z.union([z.number(), z.string()]).optional(),
});

export const virtualAccountSchema = z.object({
  email: z.string().email(),
  is_permanent: z.boolean().optional(),
  bvn: z.string().optional(),
  tx_ref: z.string().optional(),
  phonenumber: z.string().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  narration: z.string().optional(),
  amount: majorAmount.optional(),
});

export const listQuerySchema = z.object({
  page: z.union([z.number(), z.string()]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  tx_ref: z.string().optional(),
});

/** The hosted checkout page's own form. Not a Flutterwave API shape. */
export const checkoutPaySchema = z.object({
  card_number: z.string().min(12),
  exp_month: z.string().optional(),
  exp_year: z.string().optional(),
});

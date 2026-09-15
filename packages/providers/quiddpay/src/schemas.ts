import { z } from 'zod';
import { CHECKOUT_OPERATORS, QUIDDPAY_RAILS } from './rails.js';
import { QUIDDPAY_OUTCOMES } from './status.js';

/**
 * Request schemas for Quid Payments.
 *
 * Every constraint below is transcribed from the matching component of Quid's
 * published OpenAPI document (`docs.quiddpayments.com/openapi.json`, contract
 * `2026-06`, read 2026-09-15) — including the length limits, which are part of
 * what a client is tested against. `invoice_ref` really is capped at 120 and
 * `description` at 240, and a client that sends more should find out here.
 *
 * Amounts arrive as `amount_minor`, an integer already in pesewas, so there is
 * no conversion anywhere in this file: Quid and the engine agree.
 */

const amountMinor = z.number().int().min(1);

/** `CurrencyEnum` has one member; the check itself lives in rails.ts. */
const currency = z.string().min(3).max(3).optional();

/** `Customer` — `name` required, everything else optional. */
export const customerSchema = z.object({
  reference: z.string().max(120).optional(),
  name: z.string().max(200),
  email: z.string().email().optional(),
  phone: z
    .string()
    .max(16)
    .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +233241234567.')
    .optional(),
});

/** `CheckoutSessionCreate`. */
export const createSessionSchema = z.object({
  amount_minor: amountMinor,
  invoice_ref: z.string().max(120),
  description: z.string().max(240).optional(),
  currency,
  customer: customerSchema,
  callback_url: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Quid's floor. A session shorter than a minute could not be paid.
  expires_in_seconds: z.number().int().min(60).optional(),
});

/** `MerchantInvoiceLineIngest`. */
export const invoiceLinesSchema = z.object({
  invoice_ref: z.string().max(120),
  lines: z.array(
    z.object({
      code: z.string().max(80),
      name: z.string().max(200).optional(),
      amount_minor: amountMinor,
    }),
  ),
  currency,
});

/** `MerchantRevenueLineBulk` — the merchant's service-code catalogue. */
export const revenueLinesSchema = z.object({
  lines: z.array(
    z.object({
      code: z.string().max(80),
      name: z.string().max(200),
    }),
  ),
  deactivate_missing: z.boolean().optional(),
});

/**
 * `ProviderPaymentInitiate`.
 *
 * Only `rail` is required at the schema level, because the rails need
 * different fields and Quid expresses that in prose rather than in oneOf. The
 * per-rail requirements are enforced in the route, which is also where the
 * coded `INVALID_ARGUMENT` for a missing `phone` comes from.
 */
export const startAttemptSchema = z.object({
  rail: z.enum(QUIDDPAY_RAILS),
  amount_minor: amountMinor.optional(),
  phone: z.string().max(32).optional(),
  operator: z.enum(CHECKOUT_OPERATORS).optional(),
  account_name: z.string().max(120).optional(),
  sender: z
    .object({
      bank_id: z.string().min(1).max(80),
      account_name: z.string().min(2).max(160),
      account_number: z.string().min(6).max(34),
    })
    .optional(),
  transfer_method: z.literal('ghipss').optional(),
});

/** `ProviderPaymentAuthorize` — the wallet PIN or OTP, 4 to 8 characters. */
export const authorizeAttemptSchema = z.object({
  code: z.string().min(4).max(8),
});

/** `MobileMoneyAccountVerification`. */
export const verifyMomoSchema = z.object({
  phone: z.string().max(32),
  operator: z.enum(CHECKOUT_OPERATORS),
});

/** `ReceiptEmail`. */
export const receiptEmailSchema = z.object({
  email: z.string().email(),
});

/** `CashDepositSlipCreate`. */
export const cashSlipSchema = z.object({
  session_id: z.string().min(1),
  amount_minor: amountMinor,
});

/** `TestPaymentOutcome`. */
export const simulateSchema = z.object({
  outcome: z.enum(QUIDDPAY_OUTCOMES),
});

/* -------------------------------- payouts -------------------------------- */

/**
 * `CreatePayoutRecipient` — a discriminated union on `account_type`.
 *
 * Quid's guide: "Do not mix the fields." The union enforces that rather than
 * accepting a payload that names a bank and a wallet and quietly picking one.
 */
export const createRecipientSchema = z.discriminatedUnion('account_type', [
  z.object({
    account_type: z.literal('bank'),
    bank_id: z.string().max(80),
    account_number: z.string().regex(/^[0-9]{4,34}$/, 'Account number must be 4-34 digits.'),
    account_name: z.string().max(160),
    customer_id: z.string().max(254).optional(),
  }),
  z.object({
    account_type: z.literal('momo'),
    network: z.enum(['mtn', 'telecel', 'at']),
    phone: z.string().max(40),
    account_name: z.string().max(160),
    customer_id: z.string().max(254).optional(),
  }),
]);

/**
 * The same, with `account_type` defaulted.
 *
 * Quid defaults it to `bank`, so a payload that omits it is a bank recipient.
 * The default has to be applied before the discriminated union sees the
 * object, which is what this preprocessing step is for.
 */
export const recipientRequestSchema = z.preprocess((value) => {
  if (typeof value === 'object' && value !== null && !('account_type' in value)) {
    return { ...(value as Record<string, unknown>), account_type: 'bank' };
  }
  return value;
}, createRecipientSchema);

/** `QuoteCreate`. */
export const payoutQuoteSchema = z.object({
  recipient_id: z.string().min(1),
  amount_minor: amountMinor,
});

/** `RequestCreate` — creating a payout. */
export const createPayoutSchema = z.object({
  recipient_id: z.string().min(1),
  amount_minor: amountMinor.max(1_000_000_000_000),
  currency,
  max_fee_minor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  client_reference: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/,
      'client_reference must start alphanumeric and use only A-Z a-z 0-9 _ . : -',
    ),
  notes: z.string().optional(),
});

/** `PayoutCancelRequest`. */
export const cancelPayoutSchema = z
  .object({ reason: z.string().optional() })
  .optional()
  .transform((value) => value ?? {});

/** Paging shared by the payout and recipient lists. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  reference: z.string().optional(),
});

/** The hosted checkout page's own form. Not Quid surface. */
export const checkoutPaySchema = z.object({
  rail: z.enum(QUIDDPAY_RAILS),
  phone: z.string().optional(),
  operator: z.string().optional(),
});

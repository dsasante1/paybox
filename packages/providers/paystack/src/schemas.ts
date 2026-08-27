import { z } from 'zod';

/**
 * Request schemas mirroring Paystack's documented bodies.
 *
 * Paystack accepts `amount` as either a string or a number of minor units, and
 * a good many integrations send the string form, so we accept both and
 * normalise -- rejecting the string would be an emulator-only failure the
 * developer would never hit in production.
 */
const minorAmount = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Amount must be a positive integer in the currency\'s minor unit.',
      });
      return z.NEVER;
    }
    return parsed;
  });

/** Like `minorAmount`, but zero is a legitimate value. */
const nonNegativeMinorAmount = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Amount must be a non-negative integer in the currency\'s minor unit.',
      });
      return z.NEVER;
    }
    return parsed;
  });

export const initializeSchema = z.object({
  email: z.string().email('A valid customer email is required.'),
  amount: minorAmount,
  currency: z.string().length(3).optional(),
  reference: z.string().min(1).max(100).optional(),
  callback_url: z.string().url().optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  channels: z.array(z.string()).optional(),
  label: z.string().optional(),
  split_code: z.string().optional(),
  subaccount: z.string().optional(),
  transaction_charge: z.union([z.number(), z.string()]).optional(),
  bearer: z.enum(['account', 'subaccount']).optional(),
});

export const chargeSchema = z.object({
  email: z.string().email(),
  amount: minorAmount,
  currency: z.string().length(3).optional(),
  reference: z.string().min(1).max(100).optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  split_code: z.string().optional(),
  subaccount: z.string().optional(),
  mobile_money: z
    .object({
      phone: z.string().min(6),
      provider: z.string().min(2),
    })
    .optional(),
  // A synthetic test card only. See packages/simulator/src/instruments.ts --
  // the emulator has no code path that could reach a real card network, and
  // `cvv` is accepted-and-discarded rather than rejected so that existing
  // integration code does not need editing to point at the emulator.
  card: z
    .object({
      number: z.string().min(12),
      expiry_month: z.string().optional(),
      expiry_year: z.string().optional(),
      cvv: z.string().optional(),
    })
    .optional(),
  bank: z
    .object({
      code: z.string(),
      account_number: z.string(),
    })
    .optional(),
  // Schema `USSD`: a fixed enum of three-digit bank codes, per the OpenAPI
  // spec. Anything outside it is a validation error rather than a silent
  // fallback -- a typo'd code would fail at Paystack too.
  ussd: z
    .object({
      type: z.enum(['737', '919', '822', '966']),
    })
    .optional(),
  // Schema `EFT`. Paystack documents only `provider` on this object.
  eft: z
    .object({
      provider: z.string().min(1),
    })
    .optional(),
});

/**
 * Charging a stored authorization.
 *
 * Verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb (fetched 2026-08-27), schema
 * `TransactionChargeAuthorization`. Required: email, amount,
 * authorization_code.
 */
export const chargeAuthorizationSchema = z.object({
  email: z.string().email(),
  amount: minorAmount,
  authorization_code: z.string().min(1),
  reference: z.string().min(1).max(100).optional(),
  currency: z.string().length(3).optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  // Accepted and echoed; splits themselves are not modelled yet, and
  // docs/paystack.md says so rather than pretending otherwise.
  split_code: z.string().optional(),
  subaccount: z.string().optional(),
  transaction_charge: z.union([z.number(), z.string()]).optional(),
  bearer: z.enum(['account', 'subaccount']).optional(),
  queue: z.boolean().optional(),
});

/** Schema `TransactionPartialDebit`. Note `currency` is required here. */
export const partialDebitSchema = z.object({
  email: z.string().email(),
  amount: minorAmount,
  authorization_code: z.string().min(1),
  currency: z.string().length(3),
  at_least: z.union([z.number(), z.string()]).optional(),
  reference: z.string().min(1).max(100).optional(),
});

/** Schemas `ChargeSubmitOTP` / `ChargeSubmitPin` / `...Phone` / `...Birthday`. */
export const submitOtpSchema = z.object({
  otp: z.string().min(1),
  reference: z.string().min(1),
});

export const submitPinSchema = z.object({
  pin: z.string().min(1),
  reference: z.string().min(1),
});

export const submitPhoneSchema = z.object({
  phone: z.string().min(1),
  reference: z.string().min(1),
});

export const submitBirthdaySchema = z.object({
  birthday: z.string().min(1),
  reference: z.string().min(1),
});

/** Schema `CustomerDeactivateAuthorization`. */
export const deactivateAuthorizationSchema = z.object({
  authorization_code: z.string().min(1),
});

/**
 * Dedicated virtual accounts. Schemas `DedicatedVirtualAccountCreate` and
 * `DedicatedVirtualAccountAssign` from the pinned OpenAPI spec.
 */
export const dedicatedAccountCreateSchema = z.object({
  customer: z.string().min(1),
  preferred_bank: z.string().optional(),
  subaccount: z.string().optional(),
  split_code: z.string().optional(),
});

export const dedicatedAccountAssignSchema = z.object({
  email: z.string().email(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().min(1),
  preferred_bank: z.string().min(1),
  country: z.enum(['NG', 'GH']),
  account_number: z.string().optional(),
  bvn: z.string().optional(),
  bank_code: z.string().optional(),
  subaccount: z.string().optional(),
  split_code: z.string().optional(),
});

/**
 * Plans and subscriptions. Schemas `PlanCreate` and `SubscriptionCreate` from
 * the pinned OpenAPI spec. The interval enum is exactly the documented one.
 */
export const planCreateSchema = z.object({
  name: z.string().min(1),
  amount: minorAmount,
  interval: z.enum(['daily', 'weekly', 'monthly', 'biannually', 'annually']),
  description: z.string().optional(),
  send_invoices: z.boolean().optional(),
  send_sms: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  invoice_limit: z.union([z.number(), z.string()]).optional(),
});

export const planUpdateSchema = planCreateSchema.partial();

export const subscriptionCreateSchema = z.object({
  customer: z.string().min(1),
  plan: z.string().min(1),
  authorization: z.string().optional(),
  start_date: z.string().optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
});

export const subscriptionToggleSchema = z.object({
  code: z.string().min(1),
  token: z.string().min(1),
});

/** Schemas `SubaccountCreate` and `SplitCreate` from the pinned OpenAPI spec. */
export const subaccountCreateSchema = z.object({
  business_name: z.string().min(1),
  settlement_bank: z.string().min(1),
  account_number: z.string().min(4),
  percentage_charge: z.union([z.number(), z.string()]).transform(Number),
  description: z.string().optional(),
  primary_contact_email: z.string().email().optional(),
  primary_contact_name: z.string().optional(),
  primary_contact_phone: z.string().optional(),
  currency: z.string().length(3).optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
});

export const subaccountUpdateSchema = subaccountCreateSchema.partial();

export const splitCreateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['percentage', 'flat']),
  currency: z.enum(['NGN', 'GHS', 'ZAR', 'USD']),
  subaccounts: z
    .array(
      z.object({
        subaccount: z.string().min(1),
        share: z.union([z.number(), z.string()]).transform(Number),
      }),
    )
    .min(1),
  bearer_type: z.enum(['subaccount', 'account', 'all-proportional', 'all']).optional(),
  bearer_subaccount: z.string().optional(),
});

export const splitUpdateSchema = z.object({
  name: z.string().optional(),
  active: z.boolean().optional(),
  bearer_type: z.enum(['subaccount', 'account', 'all-proportional', 'all']).optional(),
  bearer_subaccount: z.string().optional(),
});

export const splitSubaccountSchema = z.object({
  subaccount: z.string().min(1),
  share: z.union([z.number(), z.string()]).transform(Number),
});

/** Schemas `DisputeResolve` and `DisputeEvidence` from the pinned OpenAPI spec. */
export const disputeResolveSchema = z.object({
  resolution: z.enum(['merchant-accepted', 'declined']),
  message: z.string().min(1),
  // Zero is meaningful here and must be accepted: a declined dispute refunds
  // nothing, and `refund_amount` is a required field on DisputeResolve. The
  // usual `minorAmount` insists on a positive integer, which is right
  // everywhere money actually moves and wrong here.
  refund_amount: nonNegativeMinorAmount.optional(),
  uploaded_filename: z.string().optional(),
  evidence: z.union([z.number(), z.string()]).optional(),
});

export const disputeEvidenceSchema = z.object({
  customer_email: z.string().email(),
  customer_name: z.string().min(1),
  customer_phone: z.string().min(1),
  service_details: z.string().min(1),
  delivery_address: z.string().optional(),
  delivery_date: z.string().optional(),
});

/** Emulator-only: opening a dispute is not something a merchant API can do. */
export const disputeOpenSchema = z.object({
  transaction: z.union([z.string(), z.number()]).transform(String),
  category: z.string().optional(),
  refund_amount: minorAmount.optional(),
  message: z.string().optional(),
});

export const refundSchema = z.object({
  transaction: z.union([z.string(), z.number()]).transform(String),
  amount: minorAmount.optional(),
  currency: z.string().length(3).optional(),
  customer_note: z.string().optional(),
  merchant_note: z.string().optional(),
});

export const customerSchema = z.object({
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const recipientSchema = z.object({
  type: z.string().default('nuban'),
  name: z.string().min(1),
  account_number: z.string().min(4),
  bank_code: z.string().min(1),
  currency: z.string().length(3).default('NGN'),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const transferSchema = z.object({
  source: z.string().default('balance'),
  amount: minorAmount,
  recipient: z.string().min(1),
  reason: z.string().optional(),
  currency: z.string().length(3).optional(),
  reference: z.string().optional(),
});

export const checkoutPaySchema = z.object({
  method: z.enum(['card', 'mobile_money', 'bank']),
  card_number: z.string().optional(),
  phone: z.string().optional(),
  network: z.string().optional(),
});

/** Paystack accepts metadata as a JSON string; normalise to an object. */
export function normalizeMetadata(
  value: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: value };
  }
}

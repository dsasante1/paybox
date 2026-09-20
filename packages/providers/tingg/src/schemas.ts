import { z } from 'zod';

/**
 * Request schemas for Tingg's two APIs.
 *
 * Transcribed from docs.tingg.africa, read 2026-09-20. The two halves look
 * nothing alike and are kept visibly apart below: Checkout 3.0 is snake_case
 * REST, Payouts is camelCase RPC with a `function` discriminator.
 *
 * ## Amounts arrive in major units
 *
 * Every Tingg sample quotes whole currency: `"request_amount": 600` against
 * `KES`, and `payment_instructions` reading "a payment of KES 1000" for
 * `charge_amount: 1000`. `queryBill` returns `"dueAmount": 25.83`. So Tingg
 * speaks major units with decimals, and the engine only ever sees integer
 * minor units. Conversion happens here, once, at the boundary -- the same
 * place and for the same reason the Flutterwave adapter does it.
 */

/** "75.50" or 75.5 -> 7550 minor units. Rounded, never truncated. */
export const majorAmount = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      ctx.addIssue({ code: 'custom', message: 'amount must be a non-negative number' });
      return z.NEVER;
    }
    return Math.round(parsed * 100);
  });

/* ============================== Checkout 3.0 ============================== */

export const tokenRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  grant_type: z.string().min(1),
});

/**
 * The fields shared by express checkout, `checkout/request` and
 * `checkout-charge`.
 *
 * Required/optional follows the express-checkout table exactly. `account_number`
 * is documented as "≤15 chars, no special chars except underscore" and
 * `merchant_transaction_id` as "≤100 chars"; both limits are enforced here so a
 * payload that would be rejected upstream is rejected locally too.
 */
const checkoutBase = {
  customer_first_name: z.string().min(1),
  customer_last_name: z.string().min(1),
  msisdn: z.string().min(1),
  account_number: z
    .string()
    .min(1)
    .max(15)
    .regex(/^[A-Za-z0-9_]+$/, 'account_number allows letters, digits and underscore only'),
  request_amount: majorAmount,
  merchant_transaction_id: z.string().min(1).max(100),
  service_code: z.string().min(1),
  country_code: z.string().min(2),
  currency_code: z.string().length(3),
  callback_url: z.string().url(),
  success_redirect_url: z.string().url(),
  fail_redirect_url: z.string().url(),

  due_date: z.string().optional(),
  customer_email: z.string().email().optional(),
  request_description: z.string().max(100).optional(),
  invoice_number: z.string().optional(),
  prefill_msisdn: z.boolean().optional(),
  payment_option_code: z.string().optional(),
  language_code: z.enum(['en', 'fr', 'ar', 'pt']).optional(),
  charge_beneficiaries: z.array(z.record(z.string(), z.unknown())).optional(),
  extra_data: z.record(z.string(), z.unknown()).optional(),
};

export const expressRequestSchema = z.object(checkoutBase);

export const checkoutRequestSchema = z.object(checkoutBase);

/**
 * `checkout-charge` -- one call that logs the request and posts the charge.
 *
 * Adds the three fields its own sample carries beyond the express payload.
 * `is_offline` is Tingg's own flag and is echoed, not acted on.
 */
export const checkoutChargeSchema = z.object({
  ...checkoutBase,
  is_offline: z.boolean().optional(),
  national_id: z.string().optional(),
  passport_number: z.string().optional(),
});

/** `charge/request` -- post a charge against a checkout that already exists. */
export const chargeRequestSchema = z.object({
  merchant_transaction_id: z.string().min(1).max(100),
  checkout_request_id: z.union([z.string(), z.number()]).optional(),
  service_code: z.string().min(1),
  payment_option_code: z.string().min(1),
  charge_amount: majorAmount.optional(),
  charge_msisdn: z.string().optional(),
  currency_code: z.string().length(3).optional(),
  country_code: z.string().min(2).optional(),
  language_code: z.enum(['en', 'fr', 'ar', 'pt']).optional(),
  extra_data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `acknowledgement/request`.
 *
 * `acknowledgement_amount` is documented as "required for partial payments",
 * which is a conditional the flat schema cannot express; the route checks it
 * once `acknowledgement_type` is known.
 */
export const acknowledgementSchema = z.object({
  acknowledgement_amount: majorAmount.optional(),
  acknowledgement_type: z.string().min(1),
  acknowledgement_narration: z.string().optional(),
  acknowledgment_reference: z.string().min(1),
  merchant_transaction_id: z.string().min(1),
  service_code: z.string().min(1),
  status_code: z.union([z.string(), z.number()]),
  currency_code: z.string().length(3),
});

/** `refund/request`. Tingg's own sample sends `refund_type: "PARTIAL"`. */
export const refundRequestSchema = z.object({
  currency_code: z.string().length(3).optional(),
  merchant_transaction_id: z.string().min(1).max(100),
  refund_type: z.string().min(1),
  amount: majorAmount.optional(),
  refund_narration: z.string().max(100),
  refund_reference: z.string().max(100),
  service_code: z.string().min(1),
  payment_id: z.string().optional(),
});

/** The hosted page's own form post. Not Tingg surface — see coverage.ts. */
export const hostedPaySchema = z.object({
  msisdn: z.string().min(1).optional(),
  payment_option_code: z.string().optional(),
});

/* ================================ Payouts ================================= */

/**
 * BEEP is RPC: one path, and `function` selects the operation.
 *
 * The envelope is validated first and the packet second, per function, because
 * a malformed packet must still come back inside a `{authStatus, results}`
 * body -- Tingg answers 200 with codes in the envelope rather than raising an
 * HTTP error, and a client written against it would not know what to do with
 * anything else.
 */
export const beepEnvelopeSchema = z.object({
  function: z.string().min(1),
  countryCode: z.string().min(2),
  payload: z.object({
    credentials: z
      .object({ username: z.string(), password: z.string() })
      .optional(),
    packet: z.array(z.record(z.string(), z.unknown())).min(1),
  }),
});

export const postPaymentPacketSchema = z.object({
  serviceCode: z.string().min(1),
  MSISDN: z.string().min(1),
  invoiceNumber: z.string().optional(),
  accountNumber: z.string().min(1),
  payerTransactionID: z.string().min(1),
  amount: majorAmount,
  hubID: z.string().optional(),
  narration: z.string().optional(),
  datePaymentReceived: z.string().optional(),
  extraData: z
    .object({
      destinationAccountName: z.string().optional(),
      destinationAccountNo: z.string().optional(),
      destinationBank: z.string().optional(),
      destinationBankCode: z.string().optional(),
      callbackUrl: z.string().url().optional(),
    })
    .passthrough()
    .optional(),
  currencyCode: z.string().length(3),
  customerNames: z.string().optional(),
  paymentMode: z.string().optional(),
});

export const queryPaymentStatusPacketSchema = z.object({
  payerTransactionID: z.string().optional(),
  beepTransactionID: z.union([z.string(), z.number()]).optional(),
});

export const queryFloatBalancePacketSchema = z.object({
  serviceCode: z.string().min(1),
  narration: z.string().optional(),
});

export const validateAccountPacketSchema = z.object({
  serviceCode: z.string().min(1),
  accountNumber: z.string().min(1),
  requestExtraData: z.record(z.string(), z.unknown()).optional(),
});

export const queryBillPacketSchema = z.object({
  serviceCode: z.string().min(1),
  MSISDN: z.string().optional(),
  accountNumber: z.string().min(1),
  payerTransactionID: z.string().optional(),
  extraData: z.unknown().optional(),
});

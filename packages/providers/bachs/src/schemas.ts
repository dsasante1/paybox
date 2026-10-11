import { z } from 'zod';

/**
 * Request schemas for Bachs.
 *
 * Shapes are transcribed from the pinned OpenAPI document
 * (docs.bachs.io/docs/openapi/openapi.json, sha256 9c2265585c2b…4810, read
 * 2026-10-10); each schema names the component it follows. Only the *shape*
 * is checked here -- types, lengths, enums. Business rules that Bachs reports
 * with their own `error_code` (a fixed price without an amount, a recurring
 * interval changed, a cart in two currencies) are enforced in the routes, so
 * they surface with that code rather than as a generic `VALIDATION_ERROR`.
 *
 * Amounts are decimal *strings*. A JSON number is refused: "Never send a
 * number" (api-standards).
 */
const decimal = z.string();
const nullableDecimal = decimal.nullable().optional();
const metadata = z.record(z.string(), z.unknown());

/** `ProductCadenceInput`: both fields required whenever a cadence is sent. */
export const cadenceSchema = z.object({
  interval: z.enum(['day', 'week', 'month', 'year']),
  frequency: z.number().int().min(1),
});

/** `CurrencyOptionInput`. */
const currencyOptionSchema = z.object({
  currency: z.string(),
  amount: nullableDecimal,
  preset_amount: nullableDecimal,
  minimum_amount: nullableDecimal,
  maximum_amount: nullableDecimal,
});

/** `PriceInput`. The fixed/free/custom `oneOf` is checked in the route. */
export const priceInputSchema = z.object({
  currency: z.string(),
  price_type: z.enum(['fixed', 'free', 'custom']).nullable().optional(),
  amount: nullableDecimal,
  preset_amount: nullableDecimal,
  minimum_amount: nullableDecimal,
  maximum_amount: nullableDecimal,
  currency_options: z.array(currencyOptionSchema).nullable().optional(),
});

/** `CreateProductRequest`. */
export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  price: priceInputSchema,
  metadata: metadata.nullable().optional(),
  billing_cycle: cadenceSchema.nullable().optional(),
  trial_period: cadenceSchema.nullable().optional(),
});

/** `UpdatePriceInput`. */
export const updatePriceSchema = z.object({
  amount: nullableDecimal,
  currency_options: z.array(currencyOptionSchema).nullable().optional(),
});

/** `UpdateProductRequest`. */
export const updateProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  metadata: metadata.nullable().optional(),
  media: z.array(z.string()).optional(),
  price: updatePriceSchema.optional(),
  billing_cycle: cadenceSchema.nullable().optional(),
  trial_period: cadenceSchema.nullable().optional(),
});

export const listProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  include_archived: z.enum(['true', 'false']).optional(),
});

/** `CustomerBillingAddress`. `line1` and `country` are checked in the route. */
export const billingAddressSchema = z.object({
  line1: z.string().max(255).nullable().optional(),
  line2: z.string().max(255).nullable().optional(),
  city: z.string().max(128).nullable().optional(),
  state: z.string().max(128).nullable().optional(),
  postal_code: z.string().max(32).nullable().optional(),
  country: z.string().min(2).max(2).nullable().optional(),
});

/** `CreateCustomerRequest`. */
export const createCustomerSchema = z.object({
  email: z.email(),
  name: z.string().max(511).nullable().optional(),
  phone_number: z.string().nullable().optional(),
  metadata: metadata.optional(),
  billing_address: billingAddressSchema.nullable().optional(),
});

/** `UpdateCustomerRequest`: only fields sent are changed. */
export const updateCustomerSchema = z.object({
  email: z.email().nullable().optional(),
  name: z.string().max(511).nullable().optional(),
  phone_number: z.string().nullable().optional(),
  metadata: metadata.nullable().optional(),
  billing_address: billingAddressSchema.nullable().optional(),
});

export const listCustomersQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  search: z.string().optional(),
});

/** `AdhocPriceInput`. */
const adhocPriceSchema = z.object({
  price_type: z.enum(['fixed', 'custom', 'free']).optional(),
  amount: nullableDecimal,
  preset_amount: nullableDecimal,
  minimum_amount: nullableDecimal,
  maximum_amount: nullableDecimal,
});

/** `ProductItemRequest`. */
const productItemSchema = z.object({
  product_id: z.string(),
  quantity: z.number().int().min(1).optional(),
  amount: nullableDecimal,
  pricing: adhocPriceSchema.nullable().optional(),
});

/** `MerchantIntent`. */
const merchantIntentSchema = z.object({
  currency: z.string(),
  amount: decimal.optional(),
  price_type: z.enum(['fixed', 'custom', 'free']).optional(),
  preset_amount: decimal.optional(),
  minimum_amount: decimal.optional(),
  maximum_amount: decimal.optional(),
  currency_options: z.record(z.string(), decimal).optional(),
});

/** `ExistingCustomerRequest` | `NewCustomerRequest`. */
const checkoutCustomerSchema = z.union([
  z.object({ customer_id: z.string() }),
  z.object({
    email: z.email(),
    name: z.string().min(1, 'If supplied, name must not be blank.').nullable().optional(),
    phone_number: z.string().nullable().optional(),
  }),
]);

/** `CreateCheckoutSessionRequest`. */
export const createCheckoutSchema = z.object({
  product_cart: z.array(productItemSchema).min(1).max(20).optional(),
  pricing: merchantIntentSchema.optional(),
  customer: checkoutCustomerSchema.nullable().optional(),
  customer_creation: z.enum(['always', 'if_required']).optional(),
  success_url: z.string().optional(),
  return_url: z.string().nullable().optional(),
  cancel_url: z.string().nullable().optional(),
  billing_currency: z.string().nullable().optional(),
  payment_method_types: z.array(z.string()).nullable().optional(),
  metadata: metadata.nullable().optional(),
  reference: z.string().max(128).nullable().optional(),
  expires_in_minutes: z.number().int().min(1).max(1440).optional(),
  save_payment_method: z.boolean().optional(),
  platform_fee: z.string().nullable().optional(),
  // `additionalProperties` refused: a platform_fee put inside transfer_data is an error, not ignored.
  transfer_data: z
    .object({ destination: z.string(), amount: z.string().nullable().optional() })
    .strict()
    .nullable()
    .optional(),
});

export const listPaymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  status_filter: z
    .enum([
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
    ])
    .optional(),
});

/** `CreateRefundRequest`. `fee_bearer` is case-insensitive ("Case is ignored"). */
export const createRefundSchema = z.object({
  charge_id: z.string(),
  reference: z.string().min(1).max(128),
  refund_address: z.string().max(255).nullable().optional(),
  amount: nullableDecimal,
  fee_bearer: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['org', 'customer']))
    .nullable()
    .optional(),
  reason: z.string().max(500).nullable().optional(),
  idempotency_key: z.string().max(255).nullable().optional(),
  simulated_outcome: z.enum(['success', 'failed']).nullable().optional(),
});

export const listRefundsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(['processing', 'success', 'failed']).optional(),
});

/* --------------------------------- billing --------------------------------- */

export const listSubscriptionsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  customer_id: z.string().optional(),
  // `paused` is in the object's enum but not the filter's.
  status: z.enum(['trialing', 'active', 'past_due', 'unpaid', 'canceled']).optional(),
});

/**
 * `UpdateSubscriptionRequest`. `proration_behavior` is a plain string here so
 * that `reset` reaches the route and gets its documented
 * `PRORATION_BEHAVIOR_NOT_SUPPORTED` rather than a schema error.
 */
export const updateSubscriptionSchema = z.object({
  product_id: z.string().optional(),
  trial_end: z.string().optional(),
  payment_method_id: z.string().optional(),
  // "`metadata: ""` clears everything" (guides/subscriptions/manage).
  metadata: z.union([z.record(z.string(), z.unknown()), z.literal('')]).optional(),
  proration_behavior: z.string().optional(),
});

/** `CancelSubscriptionRequest`; the body is optional. */
export const cancelSubscriptionSchema = z.object({
  cancel_at_period_end: z.boolean().optional(),
  reason: z.string().max(255).nullable().optional(),
});

/** `CreateProductGroupRequest`. */
export const createProductGroupSchema = z.object({
  name: z.string().min(1).max(255),
  product_ids: z.array(z.string()).min(1),
});

/** `UpdateProductGroupRequest`: `product_ids` replaces the list and its order. */
export const updateProductGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  product_ids: z.array(z.string()).min(1).optional(),
});

export const listProductGroupsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const getProductGroupQuery = z.object({
  include_archived: z.enum(['true', 'false']).optional(),
});

/** `CreateChargeRequest`. */
export const createChargeSchema = z.object({
  customer: z.string(),
  payment_method: z.string().optional(),
  amount: decimal,
  currency: z.string(),
  description: z.string().optional(),
  reference: z.string().optional(),
  metadata: metadata.optional(),
});

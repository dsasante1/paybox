import { z } from 'zod';

/**
 * Request schemas for Wise.
 *
 * Field names, types and requirements transcribed from the Wise Platform API
 * OpenAPI 3.1.0 document, version `2026Q3` (read 2026-08-29). The
 * `operationId` is named on each schema so a reader can find the source.
 *
 * Amounts stay decimal here and are converted to integer minor units in
 * money.ts, at the one boundary allowed to see a float.
 */

const currency = z.string().length(3).toUpperCase();
const decimalAmount = z.number().positive('amount must be greater than zero.').finite();

/**
 * `quoteCreate` — `POST /profiles/{profileId}/quotes`.
 *
 * The spec is explicit: *"Either `sourceAmount` or `targetAmount` is
 * required, never both."* That is a real constraint a client gets wrong, so
 * it is enforced rather than tolerated.
 */
export const createQuoteSchema = z
  .object({
    sourceCurrency: currency,
    targetCurrency: currency,
    sourceAmount: decimalAmount.nullish(),
    targetAmount: decimalAmount.nullish(),
    targetAccount: z.union([z.number(), z.string()]).nullish(),
    payOut: z.string().nullish(),
    preferredPayIn: z.string().nullish(),
    // Wise's pricing overrides. Accepted and echoed; paybox models no pricing.
    pricingConfiguration: z.record(z.string(), z.unknown()).nullish(),
  })
  .refine(
    (value) =>
      (value.sourceAmount != null || value.targetAmount != null) &&
      !(value.sourceAmount != null && value.targetAmount != null),
    {
      message: 'Provide exactly one of sourceAmount or targetAmount, never both.',
      path: ['sourceAmount'],
    },
  );

/** `quoteUpdate` — `PATCH /profiles/{profileId}/quotes/{quoteId}`. */
export const updateQuoteSchema = z.object({
  targetAccount: z.union([z.number(), z.string()]),
});

/**
 * `transferCreate` — `POST /transfers`.
 *
 * `customerTransactionId` is Wise's idempotency key, and the spec says why:
 * *"Required to perform idempotency check to avoid duplicate transfers in
 * case of network failures or timeouts."* It is a body field, not a header.
 */
export const createTransferSchema = z.object({
  sourceAccount: z.union([z.number(), z.string()]).nullish(),
  targetAccount: z.union([z.number(), z.string()]),
  quoteUuid: z.string().min(1),
  customerTransactionId: z.string().min(1),
  details: z
    .object({
      reference: z.string().nullish(),
      transferPurpose: z.string().nullish(),
      transferPurposeSubTransferPurpose: z.string().nullish(),
      sourceOfFunds: z.string().nullish(),
    })
    .nullish(),
});

/**
 * `recipientCreate` — `POST /accounts`.
 *
 * `details` is deliberately open: Wise's required fields depend entirely on
 * the `type` (a `sort_code` account needs `sortCode` + `accountNumber`, an
 * `iban` account needs `IBAN`, and there are dozens of country-specific
 * types). Those requirements are served dynamically from
 * `GET /quotes/{quoteId}/account-requirements`, so hard-coding a subset here
 * would reject accounts the real API accepts.
 */
export const createRecipientSchema = z.object({
  currency,
  type: z.string().min(1),
  profile: z.union([z.number(), z.string()]).nullish(),
  accountHolderName: z.string().min(1),
  ownedByCustomer: z.boolean().nullish(),
  details: z.record(z.string(), z.unknown()).default({}),
});

/**
 * `transferFund` — `POST /profiles/{profileId}/transfers/{transferId}/payments`.
 *
 * `type: BALANCE` is the only value paybox can settle: it is the one pay-in
 * method that does not require money to arrive from outside the emulator.
 */
export const fundTransferSchema = z.object({
  type: z.string().default('BALANCE'),
  balanceId: z.union([z.number(), z.string()]).nullish(),
});

/** `balanceCreate` — `POST /profiles/{profileId}/balances`. */
export const createBalanceSchema = z.object({
  currency,
  type: z.enum(['STANDARD', 'SAVINGS']).default('STANDARD'),
  name: z.string().nullish(),
});

/** `balanceMovement` — `POST /profiles/{profileId}/balance-movements`. */
export const balanceMovementSchema = z.object({
  quoteId: z.string().min(1),
});

/** `simulationBalanceTopup` — `POST /simulation/balance/topup`. */
export const topupSchema = z.object({
  profileId: z.union([z.number(), z.string()]),
  balanceId: z.union([z.number(), z.string()]),
  currency,
  amount: decimalAmount,
});

/**
 * `webhookProfileSubscriptionCreate` — `POST /profiles/{profileId}/subscriptions`.
 *
 * Note the field naming: `trigger_on` and `delivery.version` are snake_case
 * and nested, unlike every other Wise request body, which is camelCase and
 * flat. Transcribed from schema `subscription-request` rather than tidied.
 */
export const createSubscriptionSchema = z.object({
  name: z.string().min(1),
  trigger_on: z.string().min(1),
  delivery: z.object({
    version: z.string().min(1),
    url: z.string().url(),
  }),
});

export const ratesQuerySchema = z.object({
  source: currency.optional(),
  target: currency.optional(),
});

export const transferListQuerySchema = z.object({
  profile: z.union([z.number(), z.string()]).optional(),
  status: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  createdDateStart: z.string().optional(),
  createdDateEnd: z.string().optional(),
});

export const recipientListQuerySchema = z.object({
  profileId: z.union([z.number(), z.string()]).optional(),
  currency: currency.optional(),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

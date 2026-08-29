import { z } from 'zod';

/**
 * Request schemas for WeWire.
 *
 * Field names and types transcribed from the request tables at
 * docs.wewire.com (read 2026-08-29): the payout body from
 * /common-workflows/send-a-payout, the Africa bodies from /ghana/collections
 * and /ghana/disbursements, the list filters from
 * /concepts/transactions/list-transactions.
 *
 * Amounts stay decimal here. They are converted to integer minor units in
 * money.ts, at the one boundary that is allowed to see a float, so a schema
 * failure and a precision failure produce different, accurate messages.
 */

const currency = z.string().length(3).toUpperCase();

/** UUID v4 per WeWire's request format, but not enforced as v4: paybox's own
 *  ids are prefixed tokens, and rejecting them would make the emulator
 *  unusable with the ids it just handed out. */
const id = z.string().min(1);

const decimalAmount = z
  .number()
  .positive('amount must be greater than zero.')
  .finite();

/* ------------------------------ payouts ------------------------------ */

/** `POST /v1/transactions/initiate-payout`. */
export const initiatePayoutSchema = z.object({
  idempotencyKey: z.string().min(1),
  from: z.enum(['USD', 'GBP', 'EUR']),
  to: z.enum(['USD', 'GBP', 'EUR']),
  amount: decimalAmount,
  beneficiaryAccountId: id,
  subCustomerId: id.optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  // POP001-POP032. Enumerated as a pattern rather than 32 literals: the codes
  // are a published reference table, and paybox does not model what each one
  // means, only that one is required offshore.
  purposeCode: z
    .string()
    .regex(/^POP0(0[1-9]|[12]\d|3[0-2])$/, 'purposeCode must be POP001-POP032.')
    .optional(),
  supportingDocuments: z.array(z.string()).max(3).optional(),
  feeBearer: z.enum(['SELF', 'RECIPIENT']).optional(),
});

/* ------------------------------- africa ------------------------------- */

const africaBase = {
  idempotencyKey: z.string().min(1),
  amount: decimalAmount,
  currency,
  channel: z.enum(['MOBILE_MONEY', 'BANK']),
  accountCode: z.string().min(1),
  accountNumber: z.string().min(1),
  accountName: z.string().optional(),
  reference: z.string().optional(),
  memo: z.string().optional(),
};

/** `POST /v1/collections`. `feeBearer` is lowercase here and uppercase on the
 *  payout endpoint; that is WeWire's own inconsistency, transcribed. */
export const collectionSchema = z.object({
  ...africaBase,
  feeBearer: z.enum(['payer', 'business']).optional(),
});

/** `POST /v1/disbursements`. */
export const disbursementSchema = z.object(africaBase);

/** `GET /v1/account-lookup`. */
export const accountLookupSchema = z.object({
  currency,
  accountCode: z.string().min(1),
  accountNumber: z.string().min(1),
});

/* ----------------------------- pagination ----------------------------- */

/**
 * `page` is 1-indexed with a default of 1; `limit` defaults to 30 and caps at
 * 1000 (docs.wewire.com/working-with-the-api/pagination).
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(30),
});

export const transactionListSchema = listQuerySchema.extend({
  type: z.enum(['DEBIT', 'CREDIT']).optional(),
  status: z.enum(['PENDING', 'SUCCESSFUL', 'REVERSED', 'FAILED', 'CANCELLED']).optional(),
  wallet: z.string().optional(),
  subCustomerId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
});

/* --------------------------- beneficiaries --------------------------- */

const accountDetailsSchema = z.object({
  settlementRail: z.enum(['SEPA', 'FPS', 'CHAPS', 'ACH', 'WIRE', 'SWIFT']),
  currency,
  accountName: z.string().min(1).optional(),
  iban: z.string().optional(),
  swiftBic: z.string().optional(),
  sortCode: z.string().optional(),
  accountNumber: z.string().optional(),
  routingNumber: z.string().optional(),
  accountCategory: z.string().optional(),
  bankName: z.string().optional(),
});

/**
 * `POST /v1/beneficiaries`.
 *
 * An individual sends `firstName`/`lastName`; a business sends `name`. The
 * refinement enforces exactly that, because WeWire's docs are explicit about
 * it and a beneficiary with neither would produce a nameless payout.
 */
export const createBeneficiarySchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'BUSINESS']),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().email(),
    // ISO 3166-1 alpha-3.
    country: z.string().length(3).toUpperCase().optional(),
    accountDetails: accountDetailsSchema,
  })
  .refine(
    (value) =>
      value.type === 'BUSINESS'
        ? Boolean(value.name)
        : Boolean(value.firstName && value.lastName),
    {
      message:
        'An INDIVIDUAL beneficiary needs firstName and lastName; a BUSINESS needs name.',
      path: ['name'],
    },
  );

export const updateBeneficiarySchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  country: z.string().length(3).toUpperCase().optional(),
});

export const addAccountSchema = accountDetailsSchema;

/* ---------------------------- sub-customers ---------------------------- */

export const createSubCustomerSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'BUSINESS']).default('INDIVIDUAL'),
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  country: z.string().length(3).toUpperCase(),
  // Occupation codes are a published reference table; paybox stores whatever
  // is sent rather than validating against a list it would have to vendor.
  occupationCode: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/* -------------------------------- rates -------------------------------- */

/** `POST /v1/rates/conversion/preview`. */
export const conversionPreviewSchema = z.object({
  from: currency,
  to: currency,
  amount: decimalAmount,
  purpose: z.string().optional(),
});

/**
 * Emulator-only: credit a wallet so payouts can be tested.
 *
 * WeWire has no such endpoint -- money arrives by someone pushing it at a
 * virtual account. Without this a fresh emulator has a zero balance and every
 * payout fails, so the flow would be untestable locally. It is namespaced
 * under `/paybox/` and listed as emulator-only in the coverage manifest so it
 * can never be mistaken for WeWire surface.
 */
export const creditWalletSchema = z.object({
  currency,
  amount: decimalAmount,
  subCustomerId: id.optional(),
  reason: z.string().optional(),
});

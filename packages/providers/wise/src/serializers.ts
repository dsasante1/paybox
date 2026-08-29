import type { Customer, Subaccount, Transfer } from '@paybox/shared';
import type { TransferRecipient } from '@paybox/core';
import { toMajor } from './money.js';
import { derivedUuid, numericId } from './ids.js';
import { refineProcessing, toWiseTransferStatus } from './status.js';

/**
 * Wise wire shapes (spec §13).
 *
 * Every field is transcribed from the Wise Platform API OpenAPI 3.1.0
 * document, version `2026Q3` (sha256 `a571c1f981ef9701a52a9ccc…`, read
 * 2026-08-29), and the component schema is named beside each function. Where
 * paybox does not model something Wise reports, the field is present with a
 * null or a documented constant rather than invented.
 */

/**
 * A `quote`.
 *
 * Wise's quote is the load-bearing object: a transfer cannot exist without
 * one, and it carries the rate, the fee and the expiry. Schema `quote`.
 *
 * Note the timestamp format. `createdTime` is ISO-8601 with a `Z`
 * (`2019-04-05T13:18:58Z`) while a transfer's `created` is a space-separated
 * local-looking string (`2017-11-24 10:47:49`). That inconsistency is Wise's
 * and both are reproduced verbatim — see `wiseTransferTime` below.
 */
export function serializeQuote(input: {
  id: string;
  profileId: number;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  targetAmount: number;
  rate: number;
  payOut: string;
  providedAmountType: 'SOURCE' | 'TARGET';
  targetAccount: number | null;
  createdAt: string;
  expiresAt: string;
  rateExpiresAt: string;
  status: string;
}): Record<string, unknown> {
  return {
    id: derivedUuid(input.id, 'quote'),
    sourceCurrency: input.sourceCurrency,
    targetCurrency: input.targetCurrency,
    sourceAmount: toMajor(input.sourceAmount, input.sourceCurrency),
    targetAmount: toMajor(input.targetAmount, input.targetCurrency),
    payOut: input.payOut,
    preferredPayIn: 'BALANCE',
    rate: input.rate,
    createdTime: isoSeconds(input.createdAt),
    // paybox is single-tenant, so there is one user and one profile.
    user: LOCAL_USER_ID,
    profile: input.profileId,
    // Wise offers FLOATING and FIXED; a fixed table means the rate genuinely
    // cannot move, so FIXED is the accurate answer rather than the flattering
    // one.
    rateType: 'FIXED',
    rateExpirationTime: isoSeconds(input.rateExpiresAt),
    guaranteedTargetAmountAllowed: true,
    targetAmountAllowed: true,
    guaranteedTargetAmount: false,
    providedAmountType: input.providedAmountType,
    // Wise's pricing engine is not modelled; the shape is kept so a client
    // reading it finds an object rather than undefined.
    pricingConfiguration: { fee: { type: 'OVERRIDE', variableRate: 0, fixedRate: 0 } },
    paymentOptions: [
      {
        // The one pay-in method paybox can actually settle: money already on a
        // balance. Naming BANK_TRANSFER too would imply an inbound rail that
        // does not exist here.
        payIn: 'BALANCE',
        payOut: input.payOut,
        disabled: false,
        sourceCurrency: input.sourceCurrency,
        targetCurrency: input.targetCurrency,
        sourceAmount: toMajor(input.sourceAmount, input.sourceCurrency),
        targetAmount: toMajor(input.targetAmount, input.targetCurrency),
        fee: { transferwise: 0, payIn: 0, discount: 0, total: 0, priceSetId: 0, partner: 0 },
      },
    ],
    status: input.status,
    expirationTime: isoSeconds(input.expiresAt),
    notices: [],
    targetAccount: input.targetAccount,
  };
}

/** paybox is one user with one profile; a stable literal beats a random id. */
export const LOCAL_USER_ID = 1_000_001;

/**
 * A `transfer`.
 *
 * Schema `transfer`. `id` is an integer, `quoteUuid` a UUID, and `created` is
 * space-separated — all three transcribed as published.
 */
export function serializeTransfer(
  transfer: Transfer,
  options: {
    quoteId?: string | null;
    targetAccountId?: number | null;
    targetCurrency?: string;
    targetAmount?: number;
    rate?: number;
    profileId?: number;
  } = {},
): Record<string, unknown> {
  const meta = transfer.metadata;
  const targetCurrency =
    options.targetCurrency ?? (meta.target_currency as string | undefined) ?? transfer.currency;
  const targetAmountMinor =
    options.targetAmount ?? (meta.target_amount as number | undefined) ?? transfer.amount;
  const quoteId = options.quoteId ?? (meta.quote_id as string | undefined) ?? null;

  return {
    id: numericId(transfer.id),
    user: LOCAL_USER_ID,
    targetAccount:
      options.targetAccountId ??
      (meta.target_account_id ? numericId(String(meta.target_account_id)) : null),
    // Wise's v1 numeric quote id. paybox only ever issues v2 UUID quotes, so
    // this is null and `quoteUuid` carries the real reference — which is what
    // the current API tells clients to use.
    quote: null,
    quoteUuid: quoteId ? derivedUuid(quoteId, 'quote') : null,
    status: wiseStatus(transfer),
    // The display reference the client sent. Falls back to null rather than
    // the stored handle, which is the customerTransactionId and not something
    // Wise would ever echo here.
    reference: (meta.reference as string | undefined) ?? null,
    rate: options.rate ?? (meta.fx_rate as number | undefined) ?? 1,
    created: wiseTransferTime(transfer.createdAt),
    business: options.profileId ?? (meta.profile_id as number | undefined) ?? null,
    transferRequest: null,
    details: {
      reference: (meta.reference as string | undefined) ?? null,
      ...(meta.transfer_purpose ? { transferPurpose: meta.transfer_purpose } : {}),
      ...(meta.source_of_funds ? { sourceOfFunds: meta.source_of_funds } : {}),
    },
    hasActiveIssues: false,
    sourceCurrency: transfer.currency,
    sourceValue: toMajor(transfer.amount, transfer.currency),
    targetCurrency,
    targetValue: toMajor(targetAmountMinor, targetCurrency),
    customerTransactionId: (meta.customer_transaction_id as string | undefined) ?? null,
    payinSessionId: null,
  };
}

/**
 * The reported status, refined by whether the FX leg has settled.
 *
 * Wise reports conversion and payout as separate milestones; paybox's
 * canonical `processing` covers both, so the adapter records which on the
 * transfer and reads it back here. See status.ts.
 */
function wiseStatus(transfer: Transfer): string {
  const mapped = toWiseTransferStatus(transfer.status);
  if (mapped !== 'processing') return mapped;
  return refineProcessing(transfer.metadata.funds_converted === true);
}

/**
 * Wise's transfer timestamps are `YYYY-MM-DD HH:mm:ss` — a space, no `Z`,
 * no milliseconds — while its quotes use proper ISO-8601. Reproduced rather
 * than normalised: a client parsing one format and receiving the other is a
 * real Wise integration bug, and it should surface here.
 */
export function wiseTransferTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
}

/** ISO-8601 to second precision, the format Wise uses on quotes. */
export function isoSeconds(iso: string): string {
  return `${iso.slice(0, 19)}Z`;
}

/**
 * A `recipient` (Wise calls the endpoint `/accounts`).
 *
 * Stored canonically as a `TransferRecipient`. `accountSummary` and
 * `longAccountSummary` are display strings Wise composes from the details;
 * they are composed the same way here so a client rendering them gets
 * something sensible.
 */
export function serializeRecipient(
  recipient: TransferRecipient,
  profileId: number,
): Record<string, unknown> {
  const meta = recipient.metadata;
  const details = (meta.details as Record<string, unknown> | undefined) ?? {};
  const last4 = String(recipient.accountNumber ?? '').slice(-4);

  return {
    id: numericId(recipient.id),
    creatorId: LOCAL_USER_ID,
    profileId,
    name: {
      fullName: recipient.name,
      givenName: null,
      familyName: null,
      middleName: null,
      patronymicName: null,
      cannotHavePatronymicName: null,
    },
    currency: recipient.currency,
    country: (meta.country as string | undefined) ?? null,
    type: recipient.type,
    legalEntityType: (meta.legal_entity_type as string | undefined) ?? 'PERSON',
    active: meta.deactivated !== true,
    details,
    commonFieldMap: {
      accountNumberField: 'accountNumber',
      ...(details.sortCode ? { bankCodeField: 'sortCode' } : {}),
      ...(details.routingNumber ? { bankCodeField: 'routingNumber' } : {}),
    },
    // Wise's `hash` is an opaque fingerprint of the account details. Derived
    // here so it is stable for the same details rather than random.
    hash: derivedUuid(recipient.id, 'hash').replace(/-/g, ''),
    accountSummary: accountSummary(details, recipient.accountNumber),
    longAccountSummary: `${recipient.currency} account ending in ${last4}`,
    displayFields: displayFields(details),
    isInternal: false,
    ownedByCustomer: meta.owned_by_customer === true,
    ultimateBeneficiary: null,
    confirmations: null,
  };
}

function accountSummary(details: Record<string, unknown>, accountNumber: string | null): string {
  const last4 = String(accountNumber ?? '').slice(-4);
  const sortCode = details.sortCode;
  if (typeof sortCode === 'string' && sortCode.length === 6) {
    return `(${sortCode.slice(0, 2)}-${sortCode.slice(2, 4)}-${sortCode.slice(4)}) ${last4}`;
  }
  return last4;
}

const FIELD_LABELS: Record<string, string> = {
  sortCode: 'UK sort code',
  accountNumber: 'Account number',
  iban: 'IBAN',
  routingNumber: 'Routing number',
  bic: 'BIC',
  swiftCode: 'SWIFT code',
};

function displayFields(details: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries(details)
    .filter(([key]) => key in FIELD_LABELS)
    .map(([key, value]) => ({
      key: `details/${key}`,
      label: FIELD_LABELS[key] ?? key,
      value: String(value),
    }));
}

/**
 * A `Balance`.
 *
 * Wise nests money as `{value, currency}` objects rather than bare numbers,
 * and reports four of them: `amount`, `reservedAmount`, `cashAmount` and
 * `totalWorth`. paybox has one balance and no investment product, so
 * `reservedAmount` is zero and the other three agree — which is the honest
 * projection, not a coincidence.
 */
export function serializeBalance(input: {
  id: string;
  currency: string;
  amount: number;
  name?: string | null;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  const money = { value: toMajor(input.amount, input.currency), currency: input.currency };
  return {
    id: numericId(input.id),
    currency: input.currency,
    type: 'STANDARD',
    name: input.name ?? null,
    icon: null,
    investmentState: 'NOT_INVESTED',
    amount: money,
    reservedAmount: { value: 0, currency: input.currency },
    cashAmount: money,
    totalWorth: money,
    creationTime: input.createdAt,
    modificationTime: input.updatedAt,
    visible: true,
  };
}

/** A `payment` — the funding leg of a transfer. Schema `payment`. */
export function serializePayment(input: {
  id: string;
  amount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: numericId(input.id),
    method: 'BALANCE',
    pricingVariant: null,
    amount: toMajor(input.amount, input.currency),
    currency: input.currency,
    timeCreated: input.createdAt,
    timeUpdated: input.updatedAt,
  };
}

/**
 * A `profile`.
 *
 * Wise's profile is a `oneOf` over personal and business, discriminated by
 * `type`. paybox models one of each, backed by canonical subaccounts, so a
 * developer can exercise the profile-selection step their real integration
 * has to make.
 */
export function serializeProfile(subaccount: Subaccount): Record<string, unknown> {
  const type = (subaccount.metadata.wise_type as string | undefined) ?? 'PERSONAL';
  const base = {
    id: numericId(subaccount.id),
    type,
    userId: LOCAL_USER_ID,
    // Wise's own value for a fully onboarded profile.
    obfuscated: false,
  };

  if (type === 'BUSINESS') {
    return {
      ...base,
      name: subaccount.businessName,
      registrationNumber: (subaccount.metadata.registration_number as string | undefined) ?? null,
      companyType: (subaccount.metadata.company_type as string | undefined) ?? 'LIMITED',
      companyRole: 'OWNER',
      descriptionOfBusiness: subaccount.description,
      address: addressBlock(subaccount),
    };
  }

  return {
    ...base,
    firstName: (subaccount.metadata.first_name as string | undefined) ?? subaccount.businessName,
    lastName: (subaccount.metadata.last_name as string | undefined) ?? null,
    dateOfBirth: (subaccount.metadata.date_of_birth as string | undefined) ?? null,
    phoneNumber: subaccount.primaryContactPhone,
    address: addressBlock(subaccount),
  };
}

function addressBlock(subaccount: Subaccount): Record<string, unknown> {
  return {
    addressFirstLine: null,
    city: null,
    countryIso2Code: subaccount.countryCode,
    postCode: null,
    stateCode: null,
  };
}

/** A recipient's canonical customer, for the beneficiary's own identity. */
export function recipientName(customer: Customer | null): string | null {
  if (!customer) return null;
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email;
}

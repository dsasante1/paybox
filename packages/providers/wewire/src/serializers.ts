import type {
  Customer,
  LedgerEntry,
  Payment,
  Refund,
  Subaccount,
  Transfer,
} from '@paybox/shared';
import type { TransferRecipient } from '@paybox/core';
import { toMajor, toMajorString } from './money.js';
import { toAfricaStatus, toWewireStatus, toWewireTransferStatus } from './status.js';
import type { WewireChannel, WewireEntryType } from './status.js';

/**
 * WeWire wire shapes (spec §13).
 *
 * Every field below is transcribed from a published example response, and the
 * comments say which. Where WeWire has no equivalent of something paybox
 * models, the field is omitted rather than invented.
 */

/** WeWire's pagination envelope. Field names and order from its docs. */
export interface WewirePage<T> {
  data: T[];
  totalItems: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
}

export function paged<T>(items: T[], page: number, limit: number): WewirePage<T> {
  const start = (page - 1) * limit;
  return {
    data: items.slice(start, start + limit),
    totalItems: items.length,
    currentPage: page,
    pageSize: limit,
    // A zero-item result is one empty page, not zero pages -- which is what
    // WeWire's `currentPage: 1` on an empty list implies.
    totalPages: Math.max(1, Math.ceil(items.length / limit)),
  };
}

/**
 * The running balance around each resource's ledger entries.
 *
 * `balanceBefore` and `balanceAfter` are on every WeWire wallet transaction,
 * and they are the reason this is a fold rather than a stored pair: the same
 * append-only ledger that answers `GET /v1/wallets` answers this, so the two
 * can never drift. A transfer that also books a fee has two entries; the
 * window runs from before the first to after the last.
 */
export interface BalanceWindow {
  before: number;
  after: number;
}

export function balanceWindows(
  entries: readonly LedgerEntry[],
  opening: ReadonlyMap<string, number>,
): Map<string, BalanceWindow> {
  const windows = new Map<string, BalanceWindow>();
  // Per currency, not one running total. A wallet is one balance per currency
  // per holder, so folding EUR and GHS into a single number would produce a
  // `balanceBefore` that belongs to no wallet at all.
  const running = new Map(opening);

  // Oldest first: the repository returns newest first, so callers reverse.
  for (const entry of entries) {
    const before = running.get(entry.currency) ?? 0;
    const after = before + (entry.direction === 'credit' ? entry.amount : -entry.amount);
    running.set(entry.currency, after);
    if (!entry.resourceId) continue;
    const existing = windows.get(entry.resourceId);
    if (existing) existing.after = after;
    else windows.set(entry.resourceId, { before, after });
  }
  return windows;
}

export interface WalletTransactionOptions {
  balance?: BalanceWindow | undefined;
  fee?: number;
  subCustomerId?: string | null;
  channel?: WewireChannel;
}

/**
 * A `WalletTransaction` -- the object `GET /v1/transactions` returns and the
 * one `POST /v1/transactions/initiate-payout` answers with.
 *
 * Shape transcribed from the example responses at
 * docs.wewire.com/concepts/transactions/list-transactions and
 * /common-workflows/send-a-payout (read 2026-08-29). `amount` and `fee` are
 * JSON numbers here; on the Africa objects below they are strings. That
 * inconsistency is WeWire's, and paybox reproduces it rather than picking one.
 */
export function serializeTransfer(
  transfer: Transfer,
  options: WalletTransactionOptions = {},
): Record<string, unknown> {
  const settled = transfer.status === 'successful';
  const balance = options.balance;
  return {
    id: transfer.id,
    amount: toMajor(transfer.amount, transfer.currency),
    fee: toMajor(options.fee ?? 0, transfer.currency),
    balanceBefore: balance ? toMajor(balance.before, transfer.currency) : null,
    balanceAfter: balance ? toMajor(balance.after, transfer.currency) : null,
    reference: transfer.reference,
    type: 'DEBIT' satisfies WewireEntryType,
    channel: options.channel ?? 'AUTOMATED_PAYOUT',
    currency: transfer.currency,
    idempotencyKey: (transfer.metadata.idempotency_key as string | undefined) ?? null,
    subCustomerId: options.subCustomerId ?? transfer.sourceSubaccountId ?? null,
    status: toWewireTransferStatus(transfer.status),
    description: transfer.reason,
    purpose: (transfer.metadata.purpose_code as string | undefined) ?? null,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
    // Null until the rail confirms. paybox stamps it at the transition, so it
    // is the settlement instant in virtual time, not the read instant.
    settledAt: settled ? transfer.updatedAt : null,
  };
}

/** An inbound collection, in the same `WalletTransaction` shape. */
export function serializePaymentTransaction(
  payment: Payment,
  options: WalletTransactionOptions = {},
): Record<string, unknown> {
  const balance = options.balance;
  return {
    id: payment.id,
    amount: toMajor(payment.amount, payment.currency),
    fee: toMajor(options.fee ?? 0, payment.currency),
    balanceBefore: balance ? toMajor(balance.before, payment.currency) : null,
    balanceAfter: balance ? toMajor(balance.after, payment.currency) : null,
    reference: payment.reference,
    type: 'CREDIT' satisfies WewireEntryType,
    channel: options.channel ?? 'COLLECTION',
    currency: payment.currency,
    idempotencyKey: (payment.metadata.idempotency_key as string | undefined) ?? null,
    subCustomerId: options.subCustomerId ?? payment.subaccountId ?? null,
    status: toWewireStatus(payment.status),
    description: (payment.metadata.memo as string | undefined) ?? null,
    purpose: null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    settledAt: payment.status === 'successful' ? payment.updatedAt : null,
  };
}

/** A reversal, which WeWire records as its own row on the wallet. */
export function serializeRefundTransaction(
  refund: Refund,
  options: WalletTransactionOptions = {},
): Record<string, unknown> {
  const balance = options.balance;
  return {
    id: refund.id,
    amount: toMajor(refund.amount, refund.currency),
    fee: 0,
    balanceBefore: balance ? toMajor(balance.before, refund.currency) : null,
    balanceAfter: balance ? toMajor(balance.after, refund.currency) : null,
    reference: refund.id,
    type: 'DEBIT' satisfies WewireEntryType,
    channel: 'REVERSAL' satisfies WewireChannel,
    currency: refund.currency,
    idempotencyKey: null,
    subCustomerId: null,
    status: toWewireRefundRowStatus(refund.status),
    description: refund.reason,
    purpose: null,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
    settledAt: refund.status === 'successful' ? refund.updatedAt : null,
  };
}

function toWewireRefundRowStatus(status: Refund['status']): string {
  return status === 'successful' ? 'SUCCESSFUL' : status === 'failed' ? 'FAILED' : 'PENDING';
}

export interface AfricaOptions {
  fee?: number;
  reason?: string | null;
  /** Present only on webhook payloads, per the Africa webhooks page. */
  occurredAt?: string;
}

/**
 * The Africa (Ghana) collection / disbursement object.
 *
 * A different shape from the wallet transaction above -- flatter, with a
 * `destination` block and stringified money. Transcribed from the `202
 * Accepted` examples at docs.wewire.com/ghana/collections and
 * /ghana/disbursements (read 2026-08-29).
 */
export function serializeAfrica(
  resource: {
    id: string;
    reference: string;
    currency: string;
    createdAt: string;
    updatedAt: string;
  },
  input: {
    type: 'COLLECTION' | 'DISBURSEMENT';
    status: string;
    amount: number;
    channel: string;
    accountCode: string;
    accountNumber: string;
    accountName: string | null;
    memo: string | null;
  },
  options: AfricaOptions = {},
): Record<string, unknown> {
  return {
    id: resource.id,
    reference: resource.reference,
    type: input.type,
    status: input.status,
    amount: toMajorString(input.amount, resource.currency),
    fee: toMajorString(options.fee ?? 0, resource.currency),
    currency: resource.currency,
    channel: input.channel,
    destination: {
      accountCode: input.accountCode,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
    },
    // `reason` and `occurredAt` appear on webhook payloads only.
    ...(options.occurredAt === undefined
      ? {}
      : { reason: options.reason ?? null, occurredAt: options.occurredAt }),
    memo: input.memo,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

/** Africa status for a payment or transfer, narrowed to the corridor's three. */
export function africaStatus(resource: { status: string }): string {
  return toAfricaStatus(resource.status as Parameters<typeof toAfricaStatus>[0]);
}

/**
 * A wallet.
 *
 * WeWire publishes no example body for `GET /v1/wallets` -- only that it
 * "returns your business wallets" and that there is one per currency per
 * holder. The fields below are the minimum that statement implies, and
 * docs/wewire.md marks the shape unverified rather than presenting a guess as
 * transcription.
 */
export function serializeWallet(input: {
  id: string;
  currency: string;
  balance: number;
  subCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    currency: input.currency,
    balance: toMajor(input.balance, input.currency),
    // paybox settles instantly, so nothing is ever held pending. Reporting a
    // plausible non-zero figure would invite a "wait for funds" flow that
    // could never complete here.
    pendingBalance: 0,
    availableBalance: toMajor(input.balance, input.currency),
    subCustomerId: input.subCustomerId,
    status: 'ACTIVE',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/** A beneficiary -- the recipient party, stored as a canonical customer. */
export function serializeBeneficiary(
  customer: Customer,
  accounts: readonly TransferRecipient[] = [],
): Record<string, unknown> {
  const type = (customer.metadata.wewire_type as string | undefined) ?? 'INDIVIDUAL';
  return {
    id: customer.id,
    type,
    ...(type === 'BUSINESS'
      ? { name: (customer.metadata.wewire_name as string | undefined) ?? customer.firstName }
      : { firstName: customer.firstName, lastName: customer.lastName }),
    email: customer.email,
    // ISO 3166-1 alpha-3, per WeWire's request format.
    country: (customer.metadata.wewire_country as string | undefined) ?? null,
    accounts: accounts.map(serializeBeneficiaryAccount),
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

/** One payout destination on a beneficiary. */
export function serializeBeneficiaryAccount(account: TransferRecipient): Record<string, unknown> {
  const meta = account.metadata;
  const optional = (key: string): Record<string, unknown> =>
    meta[key] === undefined ? {} : { [key]: meta[key] };

  return {
    id: account.id,
    beneficiaryId: (meta.beneficiary_id as string | undefined) ?? null,
    settlementRail: (meta.settlement_rail as string | undefined) ?? null,
    currency: account.currency,
    accountName: account.name,
    ...optional('iban'),
    ...optional('swiftBic'),
    ...optional('sortCode'),
    ...optional('routingNumber'),
    ...optional('accountCategory'),
    // Only when the caller actually sent one. The storage row falls back to
    // the IBAN so a payout has a destination to name, but a SEPA account in
    // WeWire carries `iban` and no `accountNumber`, and echoing the IBAN back
    // under a second field would teach a client the wrong shape.
    ...optional('accountNumber'),
    bankName: account.bankName,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/**
 * A sub-customer.
 *
 * Stored as a canonical subaccount: WeWire's sub-customer is a party whose
 * balance the platform holds and settles on behalf of, which is what the
 * subaccount model already is. That is why this adapter needs no migration --
 * the ledger's owner column already separates one sub-customer's money from
 * another's.
 */
export function serializeSubCustomer(subaccount: Subaccount): Record<string, unknown> {
  return {
    id: subaccount.id,
    type: (subaccount.metadata.wewire_type as string | undefined) ?? 'INDIVIDUAL',
    name: subaccount.businessName,
    email: subaccount.primaryContactEmail,
    phone: subaccount.primaryContactPhone,
    country: subaccount.countryCode,
    // WeWire's documented KYC states. paybox starts a sub-customer at
    // APPROVED unless the caller asks otherwise; docs/wewire.md says so.
    kycStatus: (subaccount.metadata.wewire_kyc_status as string | undefined) ?? 'APPROVED',
    status: subaccount.active ? 'ACTIVE' : 'ARCHIVED',
    createdAt: subaccount.createdAt,
    updatedAt: subaccount.updatedAt,
  };
}

/**
 * A currency pair rate.
 *
 * WeWire quotes `bid` and `ask` around a mid rate and refreshes on a
 * 30-minute cycle. paybox's rates are a fixed table (rates.ts) with a fixed
 * spread: a rate that moved between two runs would break determinism, which
 * is the one property this project will not trade away. docs/wewire.md is
 * explicit that these are not market rates.
 */
export function serializeRate(input: {
  base: string;
  destination: string;
  bid: number;
  ask: number;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    pair: `${input.base}/${input.destination}`,
    baseCurrency: input.base,
    destinationCurrency: input.destination,
    bid: input.bid,
    ask: input.ask,
    updatedAt: input.updatedAt,
  };
}

/**
 * The webhook form of a wallet transaction.
 *
 * Deliberately **not** the same function as `serializeTransfer` above, because
 * WeWire's webhook payload is not the same object as its API response. The
 * differences are real and transcribed from the examples at
 * docs.wewire.com/working-with-the-api/webhooks (read 2026-08-29):
 *
 *   API                      webhook
 *   ----------------------   ------------------------------
 *   id                       transactionId
 *   description              description *and* memo
 *   channel AUTOMATED_PAYOUT channel PAYOUT
 *   settledAt                (absent)
 *   -                        walletId, businessId, quoteId
 *
 * Unifying them would be tidier and wrong: a developer whose handler reads
 * `data.id` needs to find out here that WeWire sends `transactionId`.
 */
export function serializeWebhookTransaction(input: {
  id: string;
  amount: number;
  fee: number;
  currency: string;
  reference: string;
  status: string;
  type: WewireEntryType;
  channel: string;
  description: string | null;
  memo: string | null;
  purpose: string | null;
  walletId: string;
  subCustomerId: string | null;
  balance?: BalanceWindow | undefined;
  senderInfo?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    transactionId: input.id,
    amount: toMajor(input.amount, input.currency),
    balanceBefore: input.balance ? toMajor(input.balance.before, input.currency) : null,
    balanceAfter: input.balance ? toMajor(input.balance.after, input.currency) : null,
    fee: toMajor(input.fee, input.currency),
    reference: input.reference,
    memo: input.memo,
    currency: input.currency,
    status: input.status,
    type: input.type,
    channel: input.channel,
    // paybox does not model FX quote objects, so there is no quote to name.
    quoteId: null,
    walletId: input.walletId,
    description: input.description,
    purpose: input.purpose,
    // A single-tenant emulator has one business; a stable literal is more
    // honest than a random UUID that means nothing.
    businessId: 'paybox-local-business',
    ...(input.senderInfo ? { senderInfo: input.senderInfo } : {}),
    subCustomerId: input.subCustomerId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/** The wallet id a transaction belongs to. Matches `serializeWallet`'s id. */
export function walletIdFor(subCustomerId: string | null, currency: string): string {
  return `wal_${subCustomerId ?? 'business'}_${currency.toLowerCase()}`;
}

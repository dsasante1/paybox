import type { Storage } from '@paybox/core';
import type { QuiddpayRail } from './rails.js';

/**
 * Short-lived Quid-specific state, in the provider key/value store.
 *
 * Quid's model has resources the engine has no concept of and should not
 * acquire one for: a payment *attempt* on a session, a merchant's invoice and
 * service-code catalogue, a saved payout recipient, a fee quote, a cash
 * deposit slip. None of them is a payment, a refund or a transfer, and giving
 * `core` a table for each would be provider knowledge leaking inward — exactly
 * what spec §30 forbids.
 *
 * `storage.providerState` is the seam Wise added for the same reason. Values
 * are JSON under a prefixed key, scoped to this provider, and cleared by
 * `paybox reset` along with everything else.
 */
const PROVIDER = 'quiddpay' as const;

/* ------------------------------- attempts ------------------------------- */

/**
 * One try at paying a session.
 *
 * A session can carry several: a declined mobile-money prompt, then a bank
 * transfer. Quid addresses them by `attempt_reference` and reports the
 * session's state alongside the attempt's, which is why both live here.
 */
export interface StoredAttempt {
  reference: string;
  paymentId: string;
  sessionReference: string;
  rail: QuiddpayRail;
  providerReference: string;
  amountMinor: number;
  currency: string;
  /** Quid's own attempt vocabulary: pending, paid, failed, … */
  status: string;
  /** The verbatim rail response Quid echoes as `raw_status`. */
  rawStatus: string;
  instructions: Record<string, unknown>;
  createdAt: string;
  /** When the payer said they had sent a bank transfer. Null until declared. */
  declaredAt: string | null;
  /** Set only when the test simulator decided this attempt's fate. */
  outcome: string | null;
  synthetic: boolean;
}

/* ------------------------------- catalogue ------------------------------- */

export interface StoredInvoiceLine {
  code: string;
  name: string;
  amountMinor: number;
  currency: string;
  remitted: boolean;
}

export interface StoredInvoice {
  invoiceRef: string;
  currency: string;
  lines: StoredInvoiceLine[];
  updatedAt: string;
}

/** A merchant service code — Quid's `revenue-lines`. */
export interface StoredServiceCode {
  id: string;
  code: string;
  name: string;
  active: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------- payouts -------------------------------- */

export interface StoredRecipient {
  id: string;
  accountType: 'bank' | 'momo';
  accountName: string;
  accountNumber: string;
  bankId: string;
  bankName: string;
  phone: string;
  network: string;
  networkName: string;
  environment: string;
  verified: boolean;
  verificationStatus: string;
  status: string;
  version: number;
  rejectionReason: string;
  channelId: string;
  customerId: string;
  createdAt: string;
}

export interface StoredQuote {
  id: string;
  recipientId: string;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  expiresAt: string;
}

export interface StoredCashSlip {
  token: string;
  reference: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  createdAt: string;
}

/* ------------------------------- accessors ------------------------------- */

/**
 * A typed view over the store.
 *
 * One object rather than a dozen loose functions so a route reads
 * `state.attempts.get(ref)` and the key spellings stay in one file.
 */
export function quiddpayState(storage: Storage, now: () => string) {
  async function read<T>(key: string): Promise<T | null> {
    const value = await storage.providerState.get(PROVIDER, key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async function write(key: string, value: unknown): Promise<void> {
    await storage.providerState.put(PROVIDER, key, JSON.stringify(value), now());
  }

  async function all<T>(prefix: string): Promise<T[]> {
    const rows = await storage.providerState.listByPrefix(PROVIDER, prefix);
    return rows.map((row) => JSON.parse(row.value) as T);
  }

  return {
    attempts: {
      get: (reference: string) => read<StoredAttempt>(`attempt:${reference}`),
      put: (attempt: StoredAttempt) => write(`attempt:${attempt.reference}`, attempt),
      all: () => all<StoredAttempt>('attempt:'),
      /** Every attempt against one session, oldest first. */
      async forSession(paymentId: string): Promise<StoredAttempt[]> {
        const rows = await all<StoredAttempt>('attempt:');
        return rows
          .filter((attempt) => attempt.paymentId === paymentId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
    },
    invoices: {
      get: (invoiceRef: string) => read<StoredInvoice>(`invoice:${invoiceRef}`),
      put: (invoice: StoredInvoice) => write(`invoice:${invoice.invoiceRef}`, invoice),
    },
    serviceCodes: {
      get: (code: string) => read<StoredServiceCode>(`revenue:${code}`),
      put: (row: StoredServiceCode) => write(`revenue:${row.code}`, row),
      all: () => all<StoredServiceCode>('revenue:'),
    },
    recipients: {
      get: (id: string) => read<StoredRecipient>(`recipient:${id}`),
      put: (recipient: StoredRecipient) => write(`recipient:${recipient.id}`, recipient),
      all: () => all<StoredRecipient>('recipient:'),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `recipient:${id}`),
    },
    quotes: {
      get: (id: string) => read<StoredQuote>(`quote:${id}`),
      put: (quote: StoredQuote) => write(`quote:${quote.id}`, quote),
    },
    cashSlips: {
      get: (token: string) => read<StoredCashSlip>(`slip:${token}`),
      put: (slip: StoredCashSlip) => write(`slip:${slip.token}`, slip),
      all: () => all<StoredCashSlip>('slip:'),
    },
    receiptEmail: {
      get: (paymentId: string) => read<{ email: string }>(`receipt-email:${paymentId}`),
      put: (paymentId: string, email: string) => write(`receipt-email:${paymentId}`, { email }),
    },
  };
}

export type QuiddpayState = ReturnType<typeof quiddpayState>;

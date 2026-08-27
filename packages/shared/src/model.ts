import type {
  PaymentStatus,
  PaymentMethod,
  ProviderId,
  RefundStatus,
  TransferStatus,
} from './status.js';

export type Metadata = Record<string, unknown>;

/**
 * The canonical payment (spec §4).
 *
 * Amounts are always integer minor units. `providerStatus` holds the verbatim
 * provider string so the adapter can echo exactly what the real API would,
 * without the engine having to know that Paystack says "success" where Stripe
 * says "succeeded".
 */
export interface Payment {
  id: string;
  provider: ProviderId;
  /** Developer-supplied or generated reference, unique per provider. */
  reference: string;
  /** The id this provider would have minted (e.g. Paystack's numeric id). */
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  providerStatus: string;
  paymentMethod: PaymentMethod | null;
  /** Free-form per-method detail: masked card, momo network, bank code. */
  paymentMethodDetails: Metadata;
  customerId: string | null;
  /** Where the developer wants the payer sent after checkout. */
  callbackUrl: string | null;
  amountRefunded: number;
  /** Set once the payment reaches a terminal successful/failed state. */
  failureCode: string | null;
  failureMessage: string | null;
  metadata: Metadata;
  /** Virtual-time ISO strings throughout. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  authorizedAt: string | null;
  paidAt: string | null;
}

export interface Refund {
  id: string;
  paymentId: string;
  provider: ProviderId;
  providerRefundId: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  providerStatus: string;
  reason: string | null;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface Transfer {
  id: string;
  provider: ProviderId;
  providerTransferId: string;
  reference: string;
  amount: number;
  currency: string;
  status: TransferStatus;
  providerStatus: string;
  recipientName: string | null;
  recipientAccount: string | null;
  recipientBankCode: string | null;
  reason: string | null;
  failureReason: string | null;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: string;
  provider: ProviderId;
  providerCustomerId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/**
 * An entry in the append-only event log (spec §8).
 *
 * The event log -- not the payment row -- is the source of truth for history.
 * The payment row is a projection updated in the same transaction as the
 * append, which is what makes the §23 timeline and webhook replay free rather
 * than three separate audit mechanisms.
 */
export interface PayboxEvent {
  id: string;
  type: string;
  provider: ProviderId;
  /** Canonical id of the subject (payment, refund, transfer...). */
  resourceId: string;
  resourceType: 'payment' | 'refund' | 'transfer' | 'customer';
  /** Monotonic per-resource, so replay ordering is total and stable. */
  sequence: number;
  data: Metadata;
  /** Populated for state transitions; null for informational events. */
  previousStatus: string | null;
  currentStatus: string | null;
  createdAt: string;
}

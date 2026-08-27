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
 * A stored authorization: the reusable handle a provider hands back after a
 * successful charge so the merchant can debit the same instrument again
 * without the customer present (spec §5).
 *
 * This is a canonical resource, not a Paystack one -- Stripe's payment method
 * and Flutterwave's card token are the same idea, and the engine must be able
 * to model recurring billing without learning any provider's name for it.
 *
 * `reusable` is the load-bearing flag. Cards are reusable; mobile money is not,
 * because the customer has to approve each prompt on their handset. Charging a
 * non-reusable authorization is refused rather than silently succeeding, which
 * is the failure a developer needs to discover locally rather than in
 * production.
 *
 * Only masked fragments are ever stored: a BIN and a last four. The PAN is
 * discarded at the API boundary and the CVV is never read at all (spec §29).
 */
export interface Authorization {
  id: string;
  provider: ProviderId;
  /** The code the provider would mint, e.g. Paystack's `AUTH_...` suffix. */
  providerAuthorizationCode: string;
  customerId: string | null;
  /** The payment that first produced this authorization, if any. */
  paymentId: string | null;
  channel: PaymentMethod;
  bin: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;
  cardType: string | null;
  bank: string | null;
  brand: string | null;
  countryCode: string | null;
  /** Provider-side fingerprint; stable per instrument, used for dedupe. */
  signature: string | null;
  /** False for channels that require the customer at every charge. */
  reusable: boolean;
  /** Cleared by an explicit deactivation; a deactivated code cannot charge. */
  active: boolean;
  /** Set for mobile-money authorizations so the wire format can echo it. */
  accountName: string | null;
  mobileMoneyNumber: string | null;
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
  resourceType:
    | 'payment'
    | 'refund'
    | 'transfer'
    | 'customer'
    | 'authorization'
    | 'subscription'
    | 'invoice'
    | 'dispute'
    | 'subaccount'
    | 'dedicated_account';
  /** Monotonic per-resource, so replay ordering is total and stable. */
  sequence: number;
  data: Metadata;
  /** Populated for state transitions; null for informational events. */
  previousStatus: string | null;
  currentStatus: string | null;
  createdAt: string;
}

import type {
  DisputeResolution,
  DisputeStatus,
  InvoiceStatus,
  PaymentStatus,
  PaymentMethod,
  PlanInterval,
  ProviderId,
  RefundStatus,
  SubscriptionStatus,
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
  /**
   * Bank details supplied to recover a `needs_attention` refund.
   *
   * Synthetic, like every account number in the emulator: nothing is ever
   * transmitted anywhere and no money can move through it (spec §29).
   */
  accountDetails: Metadata | null;
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
 * A dedicated virtual account: a bank account number minted for one customer,
 * so money transferred into it is attributed to them automatically.
 *
 * Canonical rather than Paystack-specific -- Flutterwave and Kora both mint
 * the same thing, and the engine models it as "an inbound rail bound to a
 * customer" without knowing whose product it is.
 *
 * The account number is synthetic and belongs to no bank. Nothing in the
 * emulator can move real money into or out of it (spec §29).
 */
export interface DedicatedAccount {
  id: string;
  provider: ProviderId;
  providerAccountId: string;
  customerId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankSlug: string;
  currency: string;
  active: boolean;
  assigned: boolean;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/** A recurring price. Canonical: Stripe and Flutterwave both have one. */
export interface Plan {
  id: string;
  provider: ProviderId;
  providerPlanCode: string;
  name: string;
  amount: number;
  currency: string;
  interval: PlanInterval;
  description: string | null;
  /** How many invoices to raise before the subscription completes. 0 = forever. */
  invoiceLimit: number;
  sendInvoices: boolean;
  sendSms: boolean;
  active: boolean;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/**
 * A customer's ongoing commitment to a plan.
 *
 * `nextPaymentDate` is the load-bearing field: it is virtual-time ISO, and the
 * scheduler compares it against virtual time, which is what makes
 * `paybox time advance 1y` run a year of billing instantly and in order.
 */
export interface Subscription {
  id: string;
  provider: ProviderId;
  providerSubscriptionCode: string;
  customerId: string;
  planId: string;
  /** The stored instrument each renewal debits. */
  authorizationId: string;
  status: SubscriptionStatus;
  providerStatus: string;
  quantity: number;
  amount: number;
  currency: string;
  startDate: string;
  /** Null once the subscription stops renewing. */
  nextPaymentDate: string | null;
  invoiceLimit: number;
  /** How many invoices have been raised, for the `invoiceLimit` check. */
  invoiceCount: number;
  /** Paystack's token for the customer-facing management link. */
  emailToken: string;
  cancelledAt: string | null;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/** One billing attempt. Links a subscription period to the payment that paid it. */
export interface Invoice {
  id: string;
  provider: ProviderId;
  providerInvoiceCode: string;
  subscriptionId: string;
  customerId: string;
  /** Null until the charge is attempted. */
  paymentId: string | null;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  providerStatus: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  paidAt: string | null;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/**
 * A marketplace participant that receives a share of transactions.
 *
 * Canonical: Stripe calls it a connected account, Flutterwave a subaccount.
 * The bank details are synthetic and nothing is ever settled to them for real.
 */
export interface Subaccount {
  id: string;
  provider: ProviderId;
  providerSubaccountCode: string;
  businessName: string;
  settlementBank: string;
  accountNumber: string;
  /** Percentage of each transaction this subaccount keeps. */
  percentageCharge: number;
  description: string | null;
  primaryContactEmail: string | null;
  primaryContactName: string | null;
  primaryContactPhone: string | null;
  currency: string;
  active: boolean;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/** How a transaction is divided between subaccounts. */
export interface Split {
  id: string;
  provider: ProviderId;
  providerSplitCode: string;
  name: string;
  type: 'percentage' | 'flat';
  currency: string;
  /** Who absorbs the processing fee. */
  bearerType: 'subaccount' | 'account' | 'all-proportional' | 'all';
  bearerSubaccountId: string | null;
  active: boolean;
  entries: SplitEntry[];
  createdAt: string;
  updatedAt: string;
}

/** One subaccount's stake in a split. `share` is a percent or a flat amount. */
export interface SplitEntry {
  subaccountId: string;
  subaccountCode: string;
  share: number;
}

/**
 * One movement in the merchant's balance.
 *
 * Append-only, and the balance is a fold over it -- never a stored mutable
 * number. Same reasoning as the event log: a running total you can only
 * recompute is a total you can always audit, and one you cannot silently
 * corrupt with a missed update.
 */
export interface LedgerEntry {
  id: string;
  provider: ProviderId;
  currency: string;
  direction: 'credit' | 'debit';
  amount: number;
  reason: string;
  /** The payment, refund or transfer that caused the movement. */
  resourceId: string | null;
  createdAt: string;
}

/**
 * A chargeback raised against a payment.
 *
 * The merchant has a deadline to respond; missing it is itself an outcome, so
 * `dueAt` is virtual-time ISO and a reminder is a scheduled job -- which makes
 * "what happens if nobody answers in time" a `time advance` away.
 */
export interface Dispute {
  id: string;
  provider: ProviderId;
  providerDisputeId: string;
  paymentId: string;
  customerId: string | null;
  /** What the payer is disputing, e.g. `fraud` or `chargeback`. */
  category: string;
  status: DisputeStatus;
  providerStatus: string;
  resolution: DisputeResolution | null;
  /** Amount under dispute; the refund raised on a merchant-accepted outcome. */
  refundAmount: number;
  currency: string;
  dueAt: string;
  resolvedAt: string | null;
  /** Merchant-supplied rebuttal, shaped by `DisputeEvidence`. */
  evidence: Metadata | null;
  message: string | null;
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

import type {
  Authorization,
  Customer,
  DedicatedAccount,
  Dispute,
  DisputeStatus,
  InstrumentSetup,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  LedgerEntry,
  Metadata,
  Payment,
  PayboxEvent,
  PaymentStatus,
  Plan,
  Product,
  ProviderId,
  Refund,
  RefundStatus,
  SetupStatus,
  Split,
  Subaccount,
  Subscription,
  SubscriptionItem,
  SubscriptionStatus,
  Transfer,
  TransferStatus,
} from '@paybox/shared';

/* ------------------------------------------------------------------ *
 * Webhooks (spec §9, §10)
 * ------------------------------------------------------------------ */

export interface WebhookEndpoint {
  id: string;
  provider: ProviderId;
  url: string;
  /** Secret used to sign deliveries. Per-endpoint so a developer can test
   *  signature rotation without restarting the emulator. */
  secret: string;
  enabled: boolean;
  /** Empty means "all events for this provider". */
  eventTypes: string[];
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted';

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  provider: ProviderId;
  eventType: string;
  url: string;
  /** The exact bytes we POST. Stored so a replay is byte-identical and so the
   *  dashboard can show what the developer's app actually received. */
  payload: string;
  headers: Record<string, string>;
  status: DeliveryStatus;
  attempt: number;
  maxAttempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  nextRetryAt: string | null;
  /** Set when this delivery was produced by an explicit replay of another. */
  replayOfDeliveryId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Durable job queue (replaces BullMQ; see docs/architecture.md)
 * ------------------------------------------------------------------ */

export type JobStatus = 'ready' | 'leased' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  /** Handler key, e.g. "webhook.deliver" or "payment.expire". */
  kind: string;
  payload: Metadata;
  status: JobStatus;
  /** Virtual-time ISO. Compared against clock.now(), never Date.now(). */
  runAt: string;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAt: string | null;
  lastError: string | null;
  /** Groups jobs so cancelling a payment can cancel its pending expiry. */
  groupKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A payout destination (spec §19). Never a real account: the emulator will
 *  not transmit these anywhere. */
export interface TransferRecipient {
  id: string;
  provider: ProviderId;
  providerRecipientId: string;
  type: string;
  name: string;
  accountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
  currency: string;
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Idempotency (spec §16)
 * ------------------------------------------------------------------ */

export interface IdempotencyRecord {
  provider: ProviderId;
  key: string;
  /** Hash of method+path+body. A replay with the same key but a different
   *  body is a conflict, not a cache hit -- that is what real providers do. */
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface PaymentFilter extends ListOptions {
  provider?: ProviderId;
  status?: PaymentStatus;
  /** Match any of these. Ignored when `status` is set. */
  statuses?: readonly PaymentStatus[];
  reference?: string;
  customerId?: string;
  /** Inclusive ISO bounds on `createdAt`. */
  from?: string;
  to?: string;
}

/** One currency's share of an aggregate. */
export interface CurrencyTotal {
  currency: string;
  amount: number;
  count: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<Payment>;
  byId(id: string): Promise<Payment | null>;
  byReference(provider: ProviderId, reference: string): Promise<Payment | null>;
  byProviderTransactionId(provider: ProviderId, id: string): Promise<Payment | null>;
  update(id: string, patch: Partial<Payment>): Promise<Payment>;
  list(filter?: PaymentFilter): Promise<Page<Payment>>;
  countByStatus(): Promise<Record<string, number>>;
  /**
   * Sum amounts per currency across **every** matching row.
   *
   * Aggregated in SQL rather than by adding up a page: a totals endpoint that
   * sums only the first page reports a number that is silently wrong, and
   * quietly disagrees with the count beside it.
   */
  sumByCurrency(filter?: Omit<PaymentFilter, 'limit' | 'offset'>): Promise<CurrencyTotal[]>;
}

export interface RefundRepository {
  insert(refund: Refund): Promise<Refund>;
  byId(id: string): Promise<Refund | null>;
  byProviderRefundId(provider: ProviderId, id: string): Promise<Refund | null>;
  update(id: string, patch: Partial<Refund>): Promise<Refund>;
  listByPayment(paymentId: string): Promise<Refund[]>;
  list(filter?: ListOptions & { status?: RefundStatus }): Promise<Page<Refund>>;
  /** Sum of refunds that are not in a failed state, used by the §18 guard. */
  totalRefunded(paymentId: string): Promise<number>;
}

export interface TransferRepository {
  insert(transfer: Transfer): Promise<Transfer>;
  byId(id: string): Promise<Transfer | null>;
  byReference(provider: ProviderId, reference: string): Promise<Transfer | null>;
  byProviderTransferId(provider: ProviderId, id: string): Promise<Transfer | null>;
  update(id: string, patch: Partial<Transfer>): Promise<Transfer>;
  list(filter?: ListOptions & { status?: TransferStatus }): Promise<Page<Transfer>>;
}

export interface RecipientRepository {
  insert(recipient: TransferRecipient): Promise<TransferRecipient>;
  byId(id: string): Promise<TransferRecipient | null>;
  byProviderRecipientId(provider: ProviderId, id: string): Promise<TransferRecipient | null>;
  list(filter?: ListOptions): Promise<Page<TransferRecipient>>;
}

export interface CustomerFilter extends ListOptions {
  provider?: ProviderId;
  /** Case-insensitive substring match on email, first name or last name. */
  search?: string;
}

export interface CustomerRepository {
  insert(customer: Customer): Promise<Customer>;
  byId(id: string): Promise<Customer | null>;
  byProviderCustomerId(provider: ProviderId, id: string): Promise<Customer | null>;
  byEmail(provider: ProviderId, email: string): Promise<Customer | null>;
  update(id: string, patch: Partial<Customer>): Promise<Customer>;
  list(filter?: CustomerFilter): Promise<Page<Customer>>;
  /** Batch fetch, so listing N payments does not cost N customer queries. */
  byIds(ids: readonly string[]): Promise<Map<string, Customer>>;
}

export interface AuthorizationRepository {
  insert(authorization: Authorization): Promise<Authorization>;
  byId(id: string): Promise<Authorization | null>;
  byCode(provider: ProviderId, code: string): Promise<Authorization | null>;
  /** Batch form of `byCode`, keyed by provider authorization code. */
  byCodes(provider: ProviderId, codes: readonly string[]): Promise<Map<string, Authorization>>;
  /**
   * Deduping lookup, **scoped to one customer**.
   *
   * One customer saving the same card twice has one stored instrument. Two
   * different customers saving the same card have two, because a stored
   * instrument belongs to a customer at every provider we model -- Paystack
   * mints a separate `authorization_code` per customer, and a Stripe
   * PaymentMethod attaches to exactly one. Deduping across customers would
   * hand one customer's saved card to another.
   */
  bySignature(
    provider: ProviderId,
    signature: string,
    customerId: string,
  ): Promise<Authorization | null>;
  /** Most recent first -- a subscription with no explicit authorization uses
   *  the customer's latest, which is what Paystack documents. */
  listByCustomer(customerId: string): Promise<Authorization[]>;
  update(id: string, patch: Partial<Authorization>): Promise<Authorization>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<Authorization>>;
}

export interface DedicatedAccountRepository {
  insert(account: DedicatedAccount): Promise<DedicatedAccount>;
  byId(id: string): Promise<DedicatedAccount | null>;
  byProviderAccountId(provider: ProviderId, id: string): Promise<DedicatedAccount | null>;
  /** The inbound rail: money arriving at this number belongs to its customer. */
  byAccountNumber(provider: ProviderId, accountNumber: string): Promise<DedicatedAccount | null>;
  byCustomer(customerId: string): Promise<DedicatedAccount | null>;
  update(id: string, patch: Partial<DedicatedAccount>): Promise<DedicatedAccount>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<DedicatedAccount>>;
}

export interface InstrumentSetupRepository {
  insert(setup: InstrumentSetup): Promise<InstrumentSetup>;
  byId(id: string): Promise<InstrumentSetup | null>;
  byProviderSetupId(provider: ProviderId, id: string): Promise<InstrumentSetup | null>;
  listByCustomer(customerId: string): Promise<InstrumentSetup[]>;
  update(id: string, patch: Partial<InstrumentSetup>): Promise<InstrumentSetup>;
  list(
    filter?: ListOptions & { provider?: ProviderId; status?: SetupStatus; customerId?: string },
  ): Promise<Page<InstrumentSetup>>;
}

export interface ProductRepository {
  insert(product: Product): Promise<Product>;
  byId(id: string): Promise<Product | null>;
  byProviderProductId(provider: ProviderId, id: string): Promise<Product | null>;
  update(id: string, patch: Partial<Product>): Promise<Product>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<Product>>;
}

export interface PlanRepository {
  insert(plan: Plan): Promise<Plan>;
  byId(id: string): Promise<Plan | null>;
  byCode(provider: ProviderId, code: string): Promise<Plan | null>;
  update(id: string, patch: Partial<Plan>): Promise<Plan>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<Plan>>;
}

export interface SubscriptionRepository {
  insert(subscription: Subscription): Promise<Subscription>;
  byId(id: string): Promise<Subscription | null>;
  byCode(provider: ProviderId, code: string): Promise<Subscription | null>;
  update(id: string, patch: Partial<Subscription>): Promise<Subscription>;
  listByCustomer(customerId: string): Promise<Subscription[]>;
  list(
    filter?: ListOptions & { provider?: ProviderId; status?: SubscriptionStatus },
  ): Promise<Page<Subscription>>;
}

export interface SubscriptionItemRepository {
  insert(item: SubscriptionItem): Promise<SubscriptionItem>;
  byId(id: string): Promise<SubscriptionItem | null>;
  byProviderItemId(provider: ProviderId, id: string): Promise<SubscriptionItem | null>;
  /** In insertion order, so a subscription's prices read as they were added. */
  listBySubscription(subscriptionId: string): Promise<SubscriptionItem[]>;
  /** Batch form of `listBySubscription`, keyed by subscription id. */
  listBySubscriptions(ids: readonly string[]): Promise<Map<string, SubscriptionItem[]>>;
  update(id: string, patch: Partial<SubscriptionItem>): Promise<SubscriptionItem>;
  delete(id: string): Promise<void>;
  nextPosition(): Promise<number>;
}

export interface InvoiceRepository {
  insert(invoice: Invoice): Promise<Invoice>;
  byId(id: string): Promise<Invoice | null>;
  byCode(provider: ProviderId, code: string): Promise<Invoice | null>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  /** Oldest first, so a billing history reads in the order it happened. */
  listBySubscription(subscriptionId: string): Promise<Invoice[]>;
  list(
    filter?: ListOptions & {
      provider?: ProviderId;
      status?: InvoiceStatus;
      customerId?: string;
      subscriptionId?: string;
    },
  ): Promise<Page<Invoice>>;
}

/**
 * Invoice line items.
 *
 * `listPending` is the load-bearing query: items with no invoice yet, waiting
 * to be swept onto the next one. That is how a mid-cycle change is carried
 * forward rather than billed immediately.
 */
export interface InvoiceItemRepository {
  insert(item: InvoiceItem): Promise<InvoiceItem>;
  /** The next insertion position. Monotonic across the whole table. */
  nextPosition(): Promise<number>;
  byId(id: string): Promise<InvoiceItem | null>;
  byProviderItemId(provider: ProviderId, id: string): Promise<InvoiceItem | null>;
  /** Oldest first, so an invoice reads in the order it was assembled. */
  listByInvoice(invoiceId: string): Promise<InvoiceItem[]>;
  /** Batch form of `listByInvoice`, keyed by invoice id. */
  listByInvoices(invoiceIds: readonly string[]): Promise<Map<string, InvoiceItem[]>>;
  /** Unbilled items for a customer, optionally narrowed to one subscription. */
  listPending(customerId: string, subscriptionId?: string | null): Promise<InvoiceItem[]>;
  update(id: string, patch: Partial<InvoiceItem>): Promise<InvoiceItem>;
  delete(id: string): Promise<void>;
  /** Sum of a single invoice's lines. The invoice total is a fold over these. */
  totalFor(invoiceId: string): Promise<number>;
  list(
    filter?: ListOptions & { provider?: ProviderId; customerId?: string; pending?: boolean },
  ): Promise<Page<InvoiceItem>>;
}

export interface SubaccountRepository {
  insert(subaccount: Subaccount): Promise<Subaccount>;
  byId(id: string): Promise<Subaccount | null>;
  byCode(provider: ProviderId, code: string): Promise<Subaccount | null>;
  update(id: string, patch: Partial<Subaccount>): Promise<Subaccount>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<Subaccount>>;
}

export interface SplitRepository {
  /** Writes the split and its subaccount entries in one transaction. */
  insert(split: Split): Promise<Split>;
  byId(id: string): Promise<Split | null>;
  byCode(provider: ProviderId, code: string): Promise<Split | null>;
  /** Batch form of `byCode`, keyed by provider split code. */
  byCodes(provider: ProviderId, codes: readonly string[]): Promise<Map<string, Split>>;
  update(id: string, patch: Partial<Omit<Split, 'entries'>>): Promise<Split>;
  addSubaccount(splitId: string, subaccountId: string, share: number): Promise<Split>;
  removeSubaccount(splitId: string, subaccountId: string): Promise<Split>;
  list(filter?: ListOptions & { provider?: ProviderId }): Promise<Page<Split>>;
}

/**
 * The balance ledger. Append-only: there is no update or delete, because the
 * balance is a fold over these rows rather than a stored number.
 */
export interface LedgerRepository {
  append(entry: LedgerEntry): Promise<LedgerEntry>;
  /** Net of credits and debits, per currency. Excludes any opening float. */
  net(provider: ProviderId, currency: string): Promise<number>;
  list(
    filter?: ListOptions & { provider?: ProviderId; currency?: string },
  ): Promise<Page<LedgerEntry>>;
  /** Distinct currencies that have seen movement. */
  currencies(provider: ProviderId): Promise<string[]>;
}

export interface DisputeRepository {
  insert(dispute: Dispute): Promise<Dispute>;
  byId(id: string): Promise<Dispute | null>;
  byProviderDisputeId(provider: ProviderId, id: string): Promise<Dispute | null>;
  listByPayment(paymentId: string): Promise<Dispute[]>;
  update(id: string, patch: Partial<Dispute>): Promise<Dispute>;
  list(
    filter?: ListOptions & { provider?: ProviderId; status?: DisputeStatus },
  ): Promise<Page<Dispute>>;
}

export interface EventFilter extends ListOptions {
  provider?: ProviderId;
  type?: string;
  resourceId?: string;
}

export interface EventRepository {
  append(event: PayboxEvent): Promise<PayboxEvent>;
  byId(id: string): Promise<PayboxEvent | null>;
  listByResource(resourceId: string): Promise<PayboxEvent[]>;
  /** Batch form of `listByResource`, keyed by resource id and ordered. */
  listByResources(resourceIds: readonly string[]): Promise<Map<string, PayboxEvent[]>>;
  list(filter?: EventFilter): Promise<Page<PayboxEvent>>;
  /** Next per-resource sequence number. Must be called inside a transaction. */
  nextSequence(resourceId: string): Promise<number>;
}

export interface WebhookRepository {
  createEndpoint(endpoint: WebhookEndpoint): Promise<WebhookEndpoint>;
  updateEndpoint(id: string, patch: Partial<WebhookEndpoint>): Promise<WebhookEndpoint>;
  deleteEndpoint(id: string): Promise<void>;
  endpointById(id: string): Promise<WebhookEndpoint | null>;
  endpointsFor(provider: ProviderId, eventType: string): Promise<WebhookEndpoint[]>;
  listEndpoints(): Promise<WebhookEndpoint[]>;

  createDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>;
  updateDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<WebhookDelivery>;
  deliveryById(id: string): Promise<WebhookDelivery | null>;
  listDeliveries(
    filter?: ListOptions & { status?: DeliveryStatus; eventId?: string },
  ): Promise<Page<WebhookDelivery>>;
  countDeliveriesByStatus(): Promise<Record<string, number>>;
}

export interface JobRepository {
  enqueue(job: Job): Promise<Job>;
  /** Atomically lease up to `limit` jobs whose runAt <= now. */
  claimDue(nowISO: string, leaseUntilISO: string, limit: number): Promise<Job[]>;
  complete(id: string): Promise<void>;
  /** Reschedule for another attempt, or mark failed if attempts are spent. */
  reschedule(id: string, runAtISO: string, error: string | null): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  cancelGroup(groupKey: string): Promise<number>;
  byId(id: string): Promise<Job | null>;
  /** Earliest runAt among ready jobs, or null. Lets the scheduler idle. */
  nextRunAt(): Promise<string | null>;
  list(filter?: ListOptions & { status?: JobStatus }): Promise<Page<Job>>;
  /** Return leases that expired (crashed worker) to the ready pool. */
  reclaimExpiredLeases(nowISO: string): Promise<number>;
}

export interface IdempotencyRepository {
  get(provider: ProviderId, key: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<void>;
}

/**
 * The storage port. `transaction` hands back a Storage bound to the open
 * transaction, so the engine can append an event and update the payment
 * projection atomically -- the invariant the whole event-log design rests on.
 */
export interface Storage {
  readonly payments: PaymentRepository;
  readonly refunds: RefundRepository;
  readonly transfers: TransferRepository;
  readonly customers: CustomerRepository;
  readonly authorizations: AuthorizationRepository;
  readonly dedicatedAccounts: DedicatedAccountRepository;
  readonly instrumentSetups: InstrumentSetupRepository;
  readonly products: ProductRepository;
  readonly plans: PlanRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly subscriptionItems: SubscriptionItemRepository;
  readonly invoices: InvoiceRepository;
  readonly invoiceItems: InvoiceItemRepository;
  readonly subaccounts: SubaccountRepository;
  readonly splits: SplitRepository;
  readonly ledger: LedgerRepository;
  readonly disputes: DisputeRepository;
  readonly recipients: RecipientRepository;
  readonly events: EventRepository;
  readonly webhooks: WebhookRepository;
  readonly jobs: JobRepository;
  readonly idempotency: IdempotencyRepository;
  transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;
  /** Drop all rows but keep the schema (spec §27 `paybox reset`). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

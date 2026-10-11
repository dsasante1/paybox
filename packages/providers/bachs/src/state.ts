import type { Storage } from '@paybox/core';
import type { Corridor } from './fees.js';

/**
 * What Bachs knows that the engine has no column for.
 *
 * Everything here lives in the provider-scoped key/value store
 * (`storage.providerState`), which `paybox reset` clears together with the
 * payments it describes. Core resources -- payments, customers, products,
 * refunds, webhook endpoints -- stay in core; these records carry only the
 * Bachs-specific remainder, keyed by the Bachs id.
 */
const PROVIDER = 'bachs' as const;

/**
 * Creation order, per storage.
 *
 * Bachs lists everything "newest first", and under a frozen clock every row
 * written in one test shares a `created_at` to the millisecond, so neither a
 * timestamp nor a random id can order them (CLAUDE.md, "Every list query
 * sorts on a second, unique column"). Each record gets a number from this
 * counter when it is created. It is held in memory so two concurrent creates
 * cannot draw the same one, and seeded from the stored high-water mark so it
 * survives a restart.
 */
const counters = new WeakMap<Storage, { next: number }>();

export type PriceType = 'fixed' | 'custom' | 'free';

/** A price, in minor units of `currency`. */
export interface StoredPrice {
  currency: string;
  priceType: PriceType;
  amount: number | null;
  preset: number | null;
  minimum: number | null;
  maximum: number | null;
  /** Other currencies, same price type, in that currency's minor units. */
  currencyOptions: Array<{
    currency: string;
    amount: number | null;
    preset: number | null;
    minimum: number | null;
    maximum: number | null;
  }>;
}

export interface Cadence {
  interval: 'day' | 'week' | 'month' | 'year';
  frequency: number;
}

export interface StoredProduct {
  /** Creation order; see `counters`. Absent on records written by paybox's own tooling. */
  seq?: number;
  /** `prod_…`, the id Bachs returns. The core product's own id is `engineId`. */
  id: string;
  engineId: string;
  price: StoredPrice;
  billingCycle: Cadence | null;
  trialPeriod: Cadence | null;
  archivedAt: string | null;
}

export interface StoredCustomer {
  /** Creation order; see `counters`. Absent on records written by paybox's own tooling. */
  seq?: number;
  /** `cust_…`. */
  id: string;
  engineId: string;
  /** Bachs keeps one `name`; the engine splits it, so the original is kept. */
  name: string | null;
  billingAddress: Record<string, unknown> | null;
}

/** A resolved line of a cart, priced at the moment the checkout was created. */
export interface StoredLine {
  productId: string;
  productName: string;
  quantity: number;
  unitAmount: number;
  currency: string;
  priceType: PriceType;
  minimum: number | null;
  maximum: number | null;
}

/** What a checkout is for. `payment` when absent: every pre-billing record. */
export type CheckoutMode = 'payment' | 'subscription' | 'setup';

/** The recurring product a subscription checkout sells, priced when the checkout was made. */
export interface StoredRecurring {
  productId: string;
  productName: string;
  cycle: Cadence;
  trial: Cadence | null;
  /** Per unit, minor units of `currency`; an ad hoc override when the cart set one. */
  unitAmount: number;
  quantity: number;
  currency: string;
  /** True when the cart overrode the catalog price ("an archived, one-off price"). */
  override: boolean;
}

export interface StoredCheckout {
  /** `chk_…`. */
  id: string;
  /** Absent on checkouts stored before subscriptions existed: `payment`. */
  mode?: CheckoutMode;
  /** `save_payment_method`. */
  savePaymentMethod?: boolean;
  /** Set for a subscription checkout. */
  recurring?: StoredRecurring | null;
  /** The hosted page's URL token; addresses the session from a payer's browser. */
  token: string;
  /** Null until the payer starts paying -- Bachs' `charge: null` while open. */
  paymentId: string | null;
  /** Creation order of that payment, for the newest-first payments list. */
  paymentSeq?: number;
  /** Lifecycle of a session with no payment behind it (free, or never attempted). */
  status: 'open' | 'completed' | 'expired' | 'cancelled';
  sessionMode: 'CART';
  /** Which pricing source the request used: a cart, or a raw `pricing` object. */
  source: 'cart' | 'pricing';
  priceType: PriceType;
  currency: string;
  /** Total in minor units. Null for pay-what-you-want until the payer picks. */
  amount: number | null;
  preset: number | null;
  minimum: number | null;
  maximum: number | null;
  currencyOptions: Record<string, number>;
  lines: StoredLine[];
  /** Corridors the hosted page offers, after `payment_method_types` narrowed them. */
  corridors: Corridor[];
  billingCurrency: string | null;
  customerId: string | null;
  customerDetails: { email: string; name: string | null } | null;
  customerCreation: 'always' | 'if_required';
  successUrl: string | null;
  cancelUrl: string | null;
  reference: string | null;
  metadata: Record<string, unknown>;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRefund {
  /** Creation order; see `counters`. Absent on records written by paybox's own tooling. */
  seq?: number;
  /** The UUID refund id. */
  id: string;
  engineId: string;
  chargeId: string;
  reference: string;
  requestedAmount: number;
  currency: string;
  feeBearer: 'org' | 'customer';
  reason: string | null;
  simulatedOutcome: 'success' | 'failed';
  createdAt: string;
}

export interface StoredEndpoint {
  /** Creation order; see `counters`. Absent on records written by paybox's own tooling. */
  seq?: number;
  /** `whe_…`, also the core endpoint id. */
  id: string;
  name: string | null;
  eventSource: 'account' | 'connect' | 'all';
  disabledAt: string | null;
  disabledReason: string | null;
}

/** What a checkout's completion produced, written once by whichever path completed it. */
export interface StoredFulfilment {
  paymentMethodId: string | null;
  subscriptionId: string | null;
  at: string;
}

/**
 * A saved card (`pm_…`). The card itself is a core Authorization
 * (`engineId`); this is the Bachs remainder.
 */
export interface StoredPaymentMethod {
  seq?: number;
  id: string;
  engineId: string;
  /** Core customer id. "Cards are scoped to one customer." */
  customerId: string;
  /** The currency the card bills in: USD for a USD_CARD save, NGN for NGN_CARD. */
  currency: string;
  /**
   * What later off-session charges do. Bachs' sandbox card 4000000000000341
   * "Saves, and later charges are declined"; every other saved card succeeds.
   */
  behaviour: 'succeeds' | 'declines';
  createdAt: string;
}

/** A Bachs subscription's remainder over the core Subscription (`engineId`). */
export interface StoredSubscription {
  seq?: number;
  /** `sub_…`, also the core row's providerSubscriptionCode. */
  id: string;
  engineId: string;
  /** Core customer id. */
  customerId: string;
  productId: string;
  priceId: string;
  /** The price is an ad hoc override: "an archived, one-off price ... kept out of your catalog". */
  overridePrice: boolean;
  itemId: string;
  checkoutId: string | null;
  paymentMethodId: string | null;
  unitAmount: number;
  quantity: number;
  currency: string;
  cycle: Cadence;
  trialEnd: string | null;
  /** Periods are measured from here: the start, or the end of the trial. */
  anchor: string;
  /** Periods elapsed since `anchor`; the current period ends at boundary `cycles`. */
  cycles: number;
  periodStart: string;
  periodEnd: string;
  /** When the next renewal job is due; null once nothing more is scheduled. */
  nextRenewalAt: string | null;
  previouslyBilledAt: string | null;
  /**
   * Whether the current period was invoiced. False for a trial and for a
   * period that began while recovery was running, which no invoice covers:
   * a plan change prorates nothing there, so no credit is given for time
   * nobody paid for. Absent on records written before it existed: true.
   */
  periodBilled?: boolean;
  /**
   * A charge failed and its invoice is still owed. Bachs' `past_due` (or
   * `unpaid` once `exhausted`) is read from this as much as from canonical
   * `attention`: paybox's tooling can move the core row (to `non_renewing`,
   * say) without paying anything, and the status must not claim `active`
   * while money is owed. Set before the core row moves, cleared on recovery.
   */
  owing?: boolean;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  cancellationReason: string | null;
  /** Recovery ran out and the account keeps unpaid subscriptions: Bachs' `unpaid`. */
  exhausted: boolean;
  /** `next_cycle` proration carried into the next renewal invoice, signed minor units. */
  deferredProration: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  priceCreatedAt: string;
}

/** A Bachs invoice's remainder over the core Invoice, keyed by the core id. */
export interface StoredInvoice {
  /** `inv_…`. */
  id: string;
  engineId: string;
  subscriptionId: string | null;
  kind: 'cycle' | 'proration';
  /** Customer credit taken off this invoice, minor units. */
  creditApplied: number;
  /** Retries already made after the first failure (0-3). */
  retries: number;
  nextPaymentAttempt: string | null;
  createdAt: string;
}

/** Why a payment that no checkout made exists: renewals, prorations, off-session charges. */
export interface StoredPaymentMeta {
  seq?: number;
  billingReason: 'purchase' | 'subscription_create' | 'subscription_cycle' | 'subscription_update';
  /** `api` for POST /v1/charges, `subscription` for renewals and prorations. */
  channel: string;
  subscriptionId: string | null;
  invoiceEngineId: string | null;
  reference: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  /** Set when the card billed a different currency than the charge settles in. */
  conversion: { cardCurrency: string; cardAmount: number; ngnPerUsd: number } | null;
}

/** One movement of a customer's credit balance; the balance is their sum. */
export interface CreditEntry {
  /** Positive: credit granted. Negative: credit applied to an invoice. */
  amount: number;
  reason: 'downgrade' | 'applied';
  invoiceEngineId: string | null;
  subscriptionId: string | null;
  at: string;
}

export interface StoredProductGroup {
  seq?: number;
  /** `pgrp_…`. */
  id: string;
  name: string;
  productIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredPortalSession {
  /** `psn_…`. */
  id: string;
  token: string;
  /** Core customer id. */
  customerId: string;
  expiresAt: string;
  createdAt: string;
}

/** A payout destination (`pd_…`). Bachs-owned: the engine has no saved-destination model that fits. */
export interface StoredDestination {
  seq?: number;
  id: string;
  name: string | null;
  type: 'bank_account' | 'mobile_money' | 'crypto_wallet';
  currency: string;
  /** Sandbox destinations "are approved automatically". */
  status: 'pending_review' | 'approved' | 'rejected';
  statusReason: string | null;
  /** DELETE deactivates: the record stays, unusable. */
  deleted: boolean;
  routing: Record<string, unknown>;
  metadata: Record<string, unknown>;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A payout quote (`pqt_…`) or a conversion quote (`cqt_…`): single-use, 30 s. */
export interface StoredQuote {
  kind: 'payout' | 'conversion';
  id: string;
  fromCurrency: string;
  toCurrency: string;
  /** Minor units of `fromCurrency`: what leaves the balance. */
  fromAmount: number;
  /** Minor units of `toCurrency`: what arrives. */
  toAmount: number;
  /** Payout quotes only: the withdrawal fee, taken from `fromAmount` before converting. */
  fee: number;
  rate: string;
  expiresAt: string;
  usedBy: string | null;
  /** Payout quotes: the rail the fee was priced for; the payout's destination must match. */
  rail?: StoredDestination['type'] | null;
  createdAt: string;
}

/** A conversion (`cvt_…`). */
export interface StoredConversion {
  seq?: number;
  id: string;
  quoteId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  rate: string;
  status: 'pending' | 'completed' | 'failed';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** One balance currency's payout schedule (`/v1/balance_settings`). */
export interface StoredSchedule {
  currency: string;
  payoutCurrency: string;
  interval: 'manual' | 'instant' | 'daily' | 'weekly' | 'monthly';
  weeklyDays: string[] | null;
  monthlyDays: number[] | null;
  anchorHour: number | null;
  /** Minor units of the balance currency; null for no floor. */
  minimum: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastWithdrawalId: string | null;
  disabledReason: string | null;
  /** Consecutive runs that could not create a payout. Three turn the schedule off. */
  failures: number;
  /** Bumped on every write, so a job queued for an older schedule does nothing. */
  version: number;
}

/** The account's virtual account in one currency (`va_…`). */
export interface StoredVirtualAccount {
  id: string;
  currency: string;
  accountNumber: string;
  bankName: string;
  bankCode: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface StoredIdempotency {
  fingerprint: string;
  state: 'in_progress' | 'done';
  status: number | null;
  body: string | null;
  /** Virtual time the response was stored; the 24-hour window runs from here. */
  storedAt: string | null;
}

export function bachsState(storage: Storage, now: () => string) {
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
    /** The next creation-order number. */
    async nextSeq(): Promise<number> {
      let entry = counters.get(storage);
      if (!entry) {
        const stored = await read<{ next: number }>('sequence');
        // Another caller may have initialised it while this one awaited.
        entry = counters.get(storage) ?? { next: stored?.next ?? 1 };
        counters.set(storage, entry);
      }
      const value = entry.next;
      entry.next += 1;
      await write('sequence', { next: entry.next });
      return value;
    },
    checkouts: {
      get: (id: string) => read<StoredCheckout>(`checkout:${id}`),
      put: (checkout: StoredCheckout) => write(`checkout:${checkout.id}`, checkout),
      async byToken(token: string): Promise<StoredCheckout | null> {
        const index = await read<{ id: string }>(`checkout-token:${token}`);
        return index ? read<StoredCheckout>(`checkout:${index.id}`) : null;
      },
      indexToken: (token: string, id: string) => write(`checkout-token:${token}`, { id }),
      async byPayment(paymentId: string): Promise<StoredCheckout | null> {
        const index = await read<{ id: string }>(`checkout-payment:${paymentId}`);
        return index ? read<StoredCheckout>(`checkout:${index.id}`) : null;
      },
      indexPayment: (paymentId: string, id: string) =>
        write(`checkout-payment:${paymentId}`, { id }),
      /**
       * Whether a merchant reference has ever been used. Bachs: "Unique per
       * organization for good, including checkouts that expired."
       */
      referenceTaken: async (reference: string) =>
        (await read(`checkout-ref:${reference}`)) !== null,
      indexReference: (reference: string, id: string) => write(`checkout-ref:${reference}`, { id }),
      all: () => all<StoredCheckout>('checkout:'),
    },
    products: {
      get: (id: string) => read<StoredProduct>(`product:${id}`),
      put: (product: StoredProduct) => write(`product:${product.id}`, product),
    },
    customers: {
      get: (id: string) => read<StoredCustomer>(`customer:${id}`),
      put: (customer: StoredCustomer) => write(`customer:${customer.id}`, customer),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `customer:${id}`),
    },
    refunds: {
      get: (id: string) => read<StoredRefund>(`refund:${id}`),
      put: (refund: StoredRefund) => write(`refund:${refund.id}`, refund),
      async byEngineId(engineId: string): Promise<StoredRefund | null> {
        const index = await read<{ id: string }>(`refund-engine:${engineId}`);
        return index ? read<StoredRefund>(`refund:${index.id}`) : null;
      },
      indexEngine: (engineId: string, id: string) => write(`refund-engine:${engineId}`, { id }),
      referenceTaken: async (reference: string) =>
        (await read(`refund-ref:${reference}`)) !== null,
      indexReference: (reference: string, id: string) => write(`refund-ref:${reference}`, { id }),
      all: () => all<StoredRefund>('refund:'),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `refund:${id}`),
    },
    endpoints: {
      get: (id: string) => read<StoredEndpoint>(`endpoint:${id}`),
      put: (endpoint: StoredEndpoint) => write(`endpoint:${endpoint.id}`, endpoint),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `endpoint:${id}`),
    },
    fulfilments: {
      get: (checkoutId: string) => read<StoredFulfilment>(`checkout-fulfilment:${checkoutId}`),
      put: (checkoutId: string, fulfilment: StoredFulfilment) =>
        write(`checkout-fulfilment:${checkoutId}`, fulfilment),
    },
    paymentMethods: {
      get: (id: string) => read<StoredPaymentMethod>(`pm:${id}`),
      put: (method: StoredPaymentMethod) => write(`pm:${method.id}`, method),
      /** The customer's default card: "The first card a customer saves becomes their default." */
      async defaultFor(customerId: string): Promise<StoredPaymentMethod | null> {
        const index = await read<{ id: string }>(`pm-default:${customerId}`);
        return index ? read<StoredPaymentMethod>(`pm:${index.id}`) : null;
      },
      setDefault: (customerId: string, id: string) => write(`pm-default:${customerId}`, { id }),
      async forCustomer(customerId: string): Promise<StoredPaymentMethod[]> {
        return (await all<StoredPaymentMethod>('pm:')).filter((method) => method.customerId === customerId);
      },
    },
    subscriptions: {
      get: (id: string) => read<StoredSubscription>(`subscription:${id}`),
      put: (subscription: StoredSubscription) => write(`subscription:${subscription.id}`, subscription),
      all: () => all<StoredSubscription>('subscription:'),
    },
    invoices: {
      get: (engineId: string) => read<StoredInvoice>(`invoice:${engineId}`),
      put: (invoice: StoredInvoice) => write(`invoice:${invoice.engineId}`, invoice),
    },
    paymentMeta: {
      get: (paymentId: string) => read<StoredPaymentMeta>(`payment-meta:${paymentId}`),
      put: (paymentId: string, meta: StoredPaymentMeta) => write(`payment-meta:${paymentId}`, meta),
    },
    credit: {
      async entries(customerId: string, currency: string): Promise<CreditEntry[]> {
        return (await read<CreditEntry[]>(`credit:${customerId}:${currency}`)) ?? [];
      },
      async balance(customerId: string, currency: string): Promise<number> {
        const entries = (await read<CreditEntry[]>(`credit:${customerId}:${currency}`)) ?? [];
        return entries.reduce((sum, entry) => sum + entry.amount, 0);
      },
      async append(customerId: string, currency: string, entry: CreditEntry): Promise<void> {
        const entries = (await read<CreditEntry[]>(`credit:${customerId}:${currency}`)) ?? [];
        await write(`credit:${customerId}:${currency}`, [...entries, entry]);
      },
    },
    groups: {
      get: (id: string) => read<StoredProductGroup>(`group:${id}`),
      put: (group: StoredProductGroup) => write(`group:${group.id}`, group),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `group:${id}`),
      all: () => all<StoredProductGroup>('group:'),
    },
    portals: {
      get: (id: string) => read<StoredPortalSession>(`portal:${id}`),
      put: (session: StoredPortalSession) => write(`portal:${session.id}`, session),
      async byToken(token: string): Promise<StoredPortalSession | null> {
        const index = await read<{ id: string }>(`portal-token:${token}`);
        return index ? read<StoredPortalSession>(`portal:${index.id}`) : null;
      },
      indexToken: (token: string, id: string) => write(`portal-token:${token}`, { id }),
    },
    destinations: {
      get: (id: string) => read<StoredDestination>(`destination:${id}`),
      put: (destination: StoredDestination) => write(`destination:${destination.id}`, destination),
      all: () => all<StoredDestination>('destination:'),
      /** "The first destination an account registers for a currency becomes that currency's default". */
      async defaultFor(currency: string): Promise<StoredDestination | null> {
        const index = await read<{ id: string }>(`destination-default:${currency}`);
        return index ? read<StoredDestination>(`destination:${index.id}`) : null;
      },
      setDefault: (currency: string, id: string) => write(`destination-default:${currency}`, { id }),
      clearDefault: (currency: string) => storage.providerState.delete(PROVIDER, `destination-default:${currency}`),
    },
    quotes: {
      get: (id: string) => read<StoredQuote>(`quote:${id}`),
      put: (quote: StoredQuote) => write(`quote:${quote.id}`, quote),
    },
    conversions: {
      get: (id: string) => read<StoredConversion>(`conversion:${id}`),
      put: (conversion: StoredConversion) => write(`conversion:${conversion.id}`, conversion),
      delete: (id: string) => storage.providerState.delete(PROVIDER, `conversion:${id}`),
      all: () => all<StoredConversion>('conversion:'),
    },
    payouts: {
      /** A payout's core transfer id, by its Bachs `pay_` id. */
      async engineIdOf(id: string): Promise<string | null> {
        return (await read<{ engineId: string }>(`payout-id:${id}`))?.engineId ?? null;
      },
      index: (id: string, engineId: string) => write(`payout-id:${id}`, { engineId }),
      referenceTaken: async (reference: string) => (await read(`payout-ref:${reference}`)) !== null,
      indexReference: (reference: string, id: string) => write(`payout-ref:${reference}`, { id }),
    },
    schedules: {
      get: (currency: string) => read<StoredSchedule>(`schedule:${currency}`),
      put: (schedule: StoredSchedule) => write(`schedule:${schedule.currency}`, schedule),
      all: () => all<StoredSchedule>('schedule:'),
      /** Which scheduled payout a collection went out in, so a run takes each collection once. */
      claimOf: (paymentId: string) => read<{ transferId: string }>(`schedule-claim:${paymentId}`),
      claim: (paymentId: string, transferId: string) => write(`schedule-claim:${paymentId}`, { transferId }),
      release: (paymentId: string) => storage.providerState.delete(PROVIDER, `schedule-claim:${paymentId}`),
      claims: () => storage.providerState.listByPrefix(PROVIDER, 'schedule-claim:'),
    },
    virtualAccounts: {
      get: (currency: string) => read<StoredVirtualAccount>(`va:${currency}`),
      put: (account: StoredVirtualAccount) => write(`va:${account.currency}`, account),
      async byId(id: string): Promise<StoredVirtualAccount | null> {
        const index = await read<{ currency: string }>(`va-id:${id}`);
        return index ? read<StoredVirtualAccount>(`va:${index.currency}`) : null;
      },
      indexId: (id: string, currency: string) => write(`va-id:${id}`, { currency }),
    },
    idempotency: {
      get: (scope: string) => read<StoredIdempotency>(`idem:${scope}`),
      put: (scope: string, entry: StoredIdempotency) => write(`idem:${scope}`, entry),
      delete: (scope: string) => storage.providerState.delete(PROVIDER, `idem:${scope}`),
    },
  };
}

export type BachsState = ReturnType<typeof bachsState>;

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

export interface StoredCheckout {
  /** `chk_…`. */
  id: string;
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
    idempotency: {
      get: (scope: string) => read<StoredIdempotency>(`idem:${scope}`),
      put: (scope: string, entry: StoredIdempotency) => write(`idem:${scope}`, entry),
      delete: (scope: string) => storage.providerState.delete(PROVIDER, `idem:${scope}`),
    },
  };
}

export type BachsState = ReturnType<typeof bachsState>;

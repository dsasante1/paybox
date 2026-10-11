import type { FastifyRequest } from 'fastify';
import type { Clock, Customer, IdFactory, Payment } from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import type { PaymentSimulator } from '@paybox/simulator';
import type { WebhookDispatcher } from '@paybox/webhooks';
import type { BachsBilling } from './billing.js';
import type { BachsDisputes } from './disputes.js';
import type { BachsTreasury } from './treasury.js';
import type { PaymentContext } from './serializers.js';
import type { BachsState, StoredCustomer } from './state.js';

/** Everything the Bachs route modules share, built once by the plugin. */
export interface RouteContext {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  state: BachsState;
  dispatcher: WebhookDispatcher;
  organizationId: string;
  /** Public origin of the emulator, for the hosted checkout URL. */
  baseUrl: string;
  /** Where the adapter is mounted, e.g. `/bachs`. */
  basePath: string;
  authenticate: (request: FastifyRequest) => string;
  /** Everything a payment's serialisers need beyond the payment row. */
  paymentContext(payment: Payment): Promise<PaymentContext>;
  /** Subscriptions, invoices and off-session charges. */
  billing: BachsBilling;
  /** Settlement, payouts, conversions and schedules. */
  treasury: BachsTreasury;
  /** Disputes: evidence, submission, and paybox's own network side. */
  disputes: BachsDisputes;
  /** Set by the catalog routes: a product's running totals for `ProductResponse`. */
  productTotals(productId: string): Promise<{ totalPayments: number; totalAmount: number }>;
  /** Set by the catalog routes; used by checkout to create or match a buyer. */
  customers: {
    create(input: {
      email: string;
      name: string | null;
      phone: string | null;
      metadata: Record<string, unknown>;
      address: Record<string, unknown> | null;
    }): Promise<{ customer: Customer; stored: StoredCustomer }>;
    update(
      customer: Customer,
      patch: { name?: string | null; phone_number?: string | null },
    ): Promise<{ customer: Customer; stored: StoredCustomer }>;
  };
}

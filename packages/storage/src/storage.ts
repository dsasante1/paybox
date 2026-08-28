import { Kysely, sql, type Transaction } from 'kysely';
import { PayboxError, type Customer, type Payment, type PayboxEvent, type ProviderId, type Refund, type Split, type Transfer } from '@paybox/shared';
import type {
  AuthorizationRepository,
  CustomerRepository,
  DedicatedAccountRepository,
  InstrumentSetupRepository,
  InvoiceItemRepository,
  SubscriptionItemRepository,
  DisputeRepository,
  InvoiceRepository,
  LedgerRepository,
  PlanRepository,
  ProductRepository,
  SplitRepository,
  SubaccountRepository,
  SubscriptionRepository,
  EventFilter,
  EventRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  Job,
  JobRepository,
  ListOptions,
  Page,
  PaymentFilter,
  PaymentRepository,
  RecipientRepository,
  RefundRepository,
  Storage,
  TransferRepository,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookRepository,
} from '@paybox/core';
import { NodeSqliteDialect } from './node-sqlite-dialect.js';
import { MIGRATIONS } from './migrations.js';
import type { InvoiceItem, SubscriptionItem } from '@paybox/shared';
import type { Database } from './schema.js';
import * as map from './mappers.js';

type DB = Kysely<Database> | Transaction<Database>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function page(options?: ListOptions): { limit: number; offset: number } {
  return {
    limit: Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    offset: Math.max(options?.offset ?? 0, 0),
  };
}

function notFound(kind: string, id: string): never {
  throw new PayboxError('not_found', `No ${kind} with id ${id}.`, { details: { id } });
}

/**
 * SQLite-backed storage.
 *
 * Repositories are plain objects closing over a Kysely handle, so the exact
 * same code runs against a connection or a transaction -- which is what makes
 * `transaction(tx => ...)` in the engine work without a second set of methods.
 */
class SqliteStorage implements Storage {
  readonly #db: DB;
  readonly #inTransaction: boolean;

  constructor(db: DB, inTransaction = false) {
    this.#db = db;
    this.#inTransaction = inTransaction;
  }

  async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    // Reentrant: the engine composes operations that each open a transaction,
    // and SQLite has no true nesting. Joining the outer transaction keeps the
    // atomicity guarantee the engine relies on (event + projection together).
    if (this.#inTransaction) return fn(this);
    return (this.#db as Kysely<Database>)
      .transaction()
      .execute((trx) => fn(new SqliteStorage(trx, true)));
  }

  async reset(): Promise<void> {
    const tables = [
      'webhook_deliveries',
      'webhook_endpoints',
      'jobs',
      'events',
      'event_sequences',
      'idempotency_keys',
      'refunds',
      'transfers',
      'transfer_recipients',
      // Invoices reference subscriptions, which reference plans and
      // authorizations; drop them in dependency order.
      'invoice_items',
      'invoices',
      'subscription_items',
      'subscriptions',
      'plans',
      'products',
      'disputes',
      'split_subaccounts',
      'splits',
      'subaccounts',
      'balance_ledger',
      // Setups reference authorizations, which reference payments and
      // customers; drop them first.
      'instrument_setups',
      // Before payments and customers: these reference both.
      'authorizations',
      'dedicated_accounts',
      'payments',
      'customers',
    ] as const;
    for (const table of tables) {
      await sql`DELETE FROM ${sql.ref(table)}`.execute(this.#db);
    }
  }

  async close(): Promise<void> {
    if (!this.#inTransaction) await (this.#db as Kysely<Database>).destroy();
  }

  /* ---------------------------------------------------------------- */

  readonly payments: PaymentRepository = {
    insert: async (payment: Payment) => {
      await this.#db.insertInto('payments').values(map.fromPayment(payment)).execute();
      return payment;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toPayment(row) : null;
    },
    byReference: async (provider, reference) => {
      const row = await this.#db
        .selectFrom('payments')
        .selectAll()
        .where('provider', '=', provider)
        .where('reference', '=', reference)
        .executeTakeFirst();
      return row ? map.toPayment(row) : null;
    },
    byProviderTransactionId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('payments')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_transaction_id', '=', id)
        .executeTakeFirst();
      return row ? map.toPayment(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.paymentPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('payments').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toPayment(row) : notFound('payment', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('payments').selectAll();
      let count = this.#db
        .selectFrom('payments')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      } else if (filter?.statuses && filter.statuses.length > 0) {
        const statuses = [...filter.statuses];
        query = query.where('status', 'in', statuses);
        count = count.where('status', 'in', statuses);
      }
      if (filter?.reference) {
        query = query.where('reference', '=', filter.reference);
        count = count.where('reference', '=', filter.reference);
      }
      if (filter?.customerId) {
        query = query.where('customer_id', '=', filter.customerId);
        count = count.where('customer_id', '=', filter.customerId);
      }
      // Inclusive bounds. Timestamps are ISO-8601 UTC, which sorts
      // lexicographically, so a string comparison is a date comparison.
      if (filter?.from) {
        query = query.where('created_at', '>=', filter.from);
        count = count.where('created_at', '>=', filter.from);
      }
      if (filter?.to) {
        query = query.where('created_at', '<=', filter.to);
        count = count.where('created_at', '<=', filter.to);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toPayment), total: Number(total?.total ?? 0) };
    },
    sumByCurrency: async (filter) => {
      let query = this.#db
        .selectFrom('payments')
        .select(['currency'])
        .select(({ fn }) => [
          fn.sum<number>('amount').as('amount'),
          fn.countAll<number>().as('count'),
        ])
        .groupBy('currency');
      if (filter?.provider) query = query.where('provider', '=', filter.provider);
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
      } else if (filter?.statuses && filter.statuses.length > 0) {
        query = query.where('status', 'in', [...filter.statuses]);
      }
      if (filter?.customerId) query = query.where('customer_id', '=', filter.customerId);
      if (filter?.from) query = query.where('created_at', '>=', filter.from);
      if (filter?.to) query = query.where('created_at', '<=', filter.to);
      const rows = await query.execute();
      return rows.map((r) => ({
        currency: r.currency,
        amount: Number(r.amount ?? 0),
        count: Number(r.count ?? 0),
      }));
    },
    countByStatus: async () => {
      const rows = await this.#db
        .selectFrom('payments')
        .select(['status'])
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .groupBy('status')
        .execute();
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    },
  };

  readonly refunds: RefundRepository = {
    insert: async (refund: Refund) => {
      await this.#db.insertInto('refunds').values(map.fromRefund(refund)).execute();
      return refund;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('refunds')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toRefund(row) : null;
    },
    byProviderRefundId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('refunds')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_refund_id', '=', id)
        .executeTakeFirst();
      return row ? map.toRefund(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.refundPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('refunds').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('refunds')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toRefund(row) : notFound('refund', id);
    },
    listByPayment: async (paymentId) => {
      const rows = await this.#db
        .selectFrom('refunds')
        .selectAll()
        .where('payment_id', '=', paymentId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map(map.toRefund);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('refunds').selectAll();
      if (filter?.status) query = query.where('status', '=', filter.status);
      const rows = await query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute();
      const total = await this.#db
        .selectFrom('refunds')
        .select(({ fn }) => fn.countAll<number>().as('total'))
        .executeTakeFirst();
      return { items: rows.map(map.toRefund), total: Number(total?.total ?? 0) };
    },
    totalRefunded: async (paymentId) => {
      // Failed refunds release their hold on the refundable balance; anything
      // else (pending, processing, successful) still counts against it. This
      // is what stops two concurrent partial refunds over-refunding a payment.
      const row = await this.#db
        .selectFrom('refunds')
        .select(({ fn }) => fn.sum<number>('amount').as('total'))
        .where('payment_id', '=', paymentId)
        .where('status', '!=', 'failed')
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },
  };

  readonly transfers: TransferRepository = {
    insert: async (transfer: Transfer) => {
      await this.#db.insertInto('transfers').values(map.fromTransfer(transfer)).execute();
      return transfer;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('transfers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toTransfer(row) : null;
    },
    byReference: async (provider, reference) => {
      const row = await this.#db
        .selectFrom('transfers')
        .selectAll()
        .where('provider', '=', provider)
        .where('reference', '=', reference)
        .executeTakeFirst();
      return row ? map.toTransfer(row) : null;
    },
    byProviderTransferId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('transfers')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_transfer_id', '=', id)
        .executeTakeFirst();
      return row ? map.toTransfer(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.transferPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('transfers').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('transfers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toTransfer(row) : notFound('transfer', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('transfers').selectAll();
      if (filter?.status) query = query.where('status', '=', filter.status);
      const rows = await query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute();
      const total = await this.#db
        .selectFrom('transfers')
        .select(({ fn }) => fn.countAll<number>().as('total'))
        .executeTakeFirst();
      return { items: rows.map(map.toTransfer), total: Number(total?.total ?? 0) };
    },
  };

  readonly customers: CustomerRepository = {
    insert: async (customer: Customer) => {
      await this.#db.insertInto('customers').values(map.fromCustomer(customer)).execute();
      return customer;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('customers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toCustomer(row) : null;
    },
    byProviderCustomerId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('customers')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_customer_id', '=', id)
        .executeTakeFirst();
      return row ? map.toCustomer(row) : null;
    },
    byEmail: async (provider, email) => {
      const row = await this.#db
        .selectFrom('customers')
        .selectAll()
        .where('provider', '=', provider)
        .where('email', '=', email)
        .executeTakeFirst();
      return row ? map.toCustomer(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.customerPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('customers').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('customers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toCustomer(row) : notFound('customer', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('customers').selectAll();
      let count = this.#db
        .selectFrom('customers')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.search) {
        // SQLite's LIKE is already case-insensitive for ASCII, which is what
        // an email search needs; lowering the term keeps it predictable.
        const term = `%${filter.search.toLowerCase()}%`;
        const matches = (qb: typeof query) =>
          qb.where((eb) =>
            eb.or([
              eb('email', 'like', term),
              eb('first_name', 'like', term),
              eb('last_name', 'like', term),
            ]),
          );
        query = matches(query);
        count = count.where((eb) =>
          eb.or([
            eb('email', 'like', term),
            eb('first_name', 'like', term),
            eb('last_name', 'like', term),
          ]),
        );
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toCustomer), total: Number(total?.total ?? 0) };
    },
    byIds: async (ids) => {
      if (ids.length === 0) return new Map();
      const rows = await this.#db
        .selectFrom('customers')
        .selectAll()
        .where('id', 'in', [...new Set(ids)])
        .execute();
      return new Map(rows.map((row) => [row.id, map.toCustomer(row)]));
    },
  };

  readonly authorizations: AuthorizationRepository = {
    insert: async (authorization) => {
      await this.#db
        .insertInto('authorizations')
        .values(map.fromAuthorization(authorization))
        .execute();
      return authorization;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toAuthorization(row) : null;
    },
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_authorization_code', '=', code)
        .executeTakeFirst();
      return row ? map.toAuthorization(row) : null;
    },
    bySignature: async (provider, signature, customerId) => {
      const row = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('provider', '=', provider)
        .where('signature', '=', signature)
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      return row ? map.toAuthorization(row) : null;
    },
    byCodes: async (provider, codes) => {
      if (codes.length === 0) return new Map();
      const rows = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_authorization_code', 'in', [...new Set(codes)])
        .execute();
      return new Map(
        rows.map((row) => [row.provider_authorization_code, map.toAuthorization(row)]),
      );
    },
    listByCustomer: async (customerId) => {
      const rows = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map(map.toAuthorization);
    },
    update: async (id, patch) => {
      const columns = map.authorizationPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('authorizations')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toAuthorization(row) : notFound('authorization', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('authorizations').selectAll();
      let count = this.#db
        .selectFrom('authorizations')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toAuthorization), total: Number(total?.total ?? 0) };
    },
  };

  readonly dedicatedAccounts: DedicatedAccountRepository = {
    insert: async (account) => {
      await this.#db
        .insertInto('dedicated_accounts')
        .values(map.fromDedicatedAccount(account))
        .execute();
      return account;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('dedicated_accounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDedicatedAccount(row) : null;
    },
    byProviderAccountId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('dedicated_accounts')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_account_id', '=', id)
        .executeTakeFirst();
      return row ? map.toDedicatedAccount(row) : null;
    },
    byAccountNumber: async (provider, accountNumber) => {
      const row = await this.#db
        .selectFrom('dedicated_accounts')
        .selectAll()
        .where('provider', '=', provider)
        .where('account_number', '=', accountNumber)
        .executeTakeFirst();
      return row ? map.toDedicatedAccount(row) : null;
    },
    byCustomer: async (customerId) => {
      const row = await this.#db
        .selectFrom('dedicated_accounts')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row ? map.toDedicatedAccount(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.dedicatedAccountPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('dedicated_accounts')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('dedicated_accounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDedicatedAccount(row) : notFound('dedicated account', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('dedicated_accounts').selectAll();
      let count = this.#db
        .selectFrom('dedicated_accounts')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toDedicatedAccount), total: Number(total?.total ?? 0) };
    },
  };

  readonly instrumentSetups: InstrumentSetupRepository = {
    insert: async (setup) => {
      await this.#db
        .insertInto('instrument_setups')
        .values(map.fromInstrumentSetup(setup))
        .execute();
      return setup;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('instrument_setups')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInstrumentSetup(row) : null;
    },
    byProviderSetupId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('instrument_setups')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_setup_id', '=', id)
        .executeTakeFirst();
      return row ? map.toInstrumentSetup(row) : null;
    },
    listByCustomer: async (customerId) => {
      const rows = await this.#db
        .selectFrom('instrument_setups')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map(map.toInstrumentSetup);
    },
    update: async (id, patch) => {
      const columns = map.instrumentSetupPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('instrument_setups')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('instrument_setups')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInstrumentSetup(row) : notFound('instrument setup', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('instrument_setups').selectAll();
      let count = this.#db
        .selectFrom('instrument_setups')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      }
      if (filter?.customerId) {
        query = query.where('customer_id', '=', filter.customerId);
        count = count.where('customer_id', '=', filter.customerId);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toInstrumentSetup), total: Number(total?.total ?? 0) };
    },
  };

  readonly products: ProductRepository = {
    insert: async (product) => {
      await this.#db.insertInto('products').values(map.fromProduct(product)).execute();
      return product;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('products')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toProduct(row) : null;
    },
    byProviderProductId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('products')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_product_id', '=', id)
        .executeTakeFirst();
      return row ? map.toProduct(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.productPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('products').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('products')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toProduct(row) : notFound('product', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('products').selectAll();
      let count = this.#db
        .selectFrom('products')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toProduct), total: Number(total?.total ?? 0) };
    },
  };

  readonly plans: PlanRepository = {
    insert: async (plan) => {
      await this.#db.insertInto('plans').values(map.fromPlan(plan)).execute();
      return plan;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('plans')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toPlan(row) : null;
    },
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('plans')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_plan_code', '=', code)
        .executeTakeFirst();
      return row ? map.toPlan(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.planPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('plans').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('plans')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toPlan(row) : notFound('plan', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('plans').selectAll();
      let count = this.#db.selectFrom('plans').select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toPlan), total: Number(total?.total ?? 0) };
    },
  };

  readonly subscriptions: SubscriptionRepository = {
    insert: async (subscription) => {
      await this.#db
        .insertInto('subscriptions')
        .values(map.fromSubscription(subscription))
        .execute();
      return subscription;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('subscriptions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubscription(row) : null;
    },
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('subscriptions')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_subscription_code', '=', code)
        .executeTakeFirst();
      return row ? map.toSubscription(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.subscriptionPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('subscriptions').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('subscriptions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubscription(row) : notFound('subscription', id);
    },
    listByCustomer: async (customerId) => {
      const rows = await this.#db
        .selectFrom('subscriptions')
        .selectAll()
        .where('customer_id', '=', customerId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(map.toSubscription);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('subscriptions').selectAll();
      let count = this.#db
        .selectFrom('subscriptions')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toSubscription), total: Number(total?.total ?? 0) };
    },
  };

  readonly subscriptionItems: SubscriptionItemRepository = {
    insert: async (item) => {
      await this.#db
        .insertInto('subscription_items')
        .values(map.fromSubscriptionItem(item))
        .execute();
      return item;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('subscription_items')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubscriptionItem(row) : null;
    },
    byProviderItemId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('subscription_items')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_item_id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubscriptionItem(row) : null;
    },
    listBySubscription: async (subscriptionId) => {
      const rows = await this.#db
        .selectFrom('subscription_items')
        .selectAll()
        .where('subscription_id', '=', subscriptionId)
        .orderBy('position', 'asc')
        .execute();
      return rows.map(map.toSubscriptionItem);
    },
    listBySubscriptions: async (ids) => {
      const grouped = new Map<string, SubscriptionItem[]>();
      if (ids.length === 0) return grouped;
      const rows = await this.#db
        .selectFrom('subscription_items')
        .selectAll()
        .where('subscription_id', 'in', [...ids])
        .orderBy('position', 'asc')
        .execute();
      for (const row of rows) {
        const item = map.toSubscriptionItem(row);
        const bucket = grouped.get(item.subscriptionId);
        if (bucket) bucket.push(item);
        else grouped.set(item.subscriptionId, [item]);
      }
      return grouped;
    },
    update: async (id, patch) => {
      const columns = map.subscriptionItemPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('subscription_items')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('subscription_items')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubscriptionItem(row) : notFound('subscription item', id);
    },
    delete: async (id) => {
      await this.#db.deleteFrom('subscription_items').where('id', '=', id).execute();
    },
    nextPosition: async () => {
      const row = await this.#db
        .selectFrom('subscription_items')
        .select(({ fn }) => fn.max<number>('position').as('highest'))
        .executeTakeFirst();
      return Number(row?.highest ?? 0) + 1;
    },
  };

  readonly invoices: InvoiceRepository = {
    insert: async (invoice) => {
      await this.#db.insertInto('invoices').values(map.fromInvoice(invoice)).execute();
      return invoice;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInvoice(row) : null;
    },
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('invoices')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_invoice_code', '=', code)
        .executeTakeFirst();
      return row ? map.toInvoice(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.invoicePatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('invoices').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInvoice(row) : notFound('invoice', id);
    },
    listBySubscription: async (subscriptionId) => {
      const rows = await this.#db
        .selectFrom('invoices')
        .selectAll()
        .where('subscription_id', '=', subscriptionId)
        .orderBy('period_start', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map(map.toInvoice);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('invoices').selectAll();
      let count = this.#db
        .selectFrom('invoices')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      }
      if (filter?.customerId) {
        query = query.where('customer_id', '=', filter.customerId);
        count = count.where('customer_id', '=', filter.customerId);
      }
      if (filter?.subscriptionId) {
        query = query.where('subscription_id', '=', filter.subscriptionId);
        count = count.where('subscription_id', '=', filter.subscriptionId);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toInvoice), total: Number(total?.total ?? 0) };
    },
  };

  readonly invoiceItems: InvoiceItemRepository = {
    insert: async (item) => {
      await this.#db.insertInto('invoice_items').values(map.fromInvoiceItem(item)).execute();
      return item;
    },
    nextPosition: async () => {
      const row = await this.#db
        .selectFrom('invoice_items')
        .select(({ fn }) => fn.max<number>('position').as('highest'))
        .executeTakeFirst();
      return Number(row?.highest ?? 0) + 1;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInvoiceItem(row) : null;
    },
    byProviderItemId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_item_id', '=', id)
        .executeTakeFirst();
      return row ? map.toInvoiceItem(row) : null;
    },
    listByInvoice: async (invoiceId) => {
      const rows = await this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('invoice_id', '=', invoiceId)
        .orderBy('position', 'asc')
        .execute();
      return rows.map(map.toInvoiceItem);
    },
    listByInvoices: async (invoiceIds) => {
      const grouped = new Map<string, InvoiceItem[]>();
      if (invoiceIds.length === 0) return grouped;
      const rows = await this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('invoice_id', 'in', [...invoiceIds])
        .orderBy('position', 'asc')
        .execute();
      for (const row of rows) {
        const item = map.toInvoiceItem(row);
        if (!item.invoiceId) continue;
        const bucket = grouped.get(item.invoiceId);
        if (bucket) bucket.push(item);
        else grouped.set(item.invoiceId, [item]);
      }
      return grouped;
    },
    listPending: async (customerId, subscriptionId) => {
      let query = this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('invoice_id', 'is', null);
      // A subscription's invoice sweeps up that subscription's pending items
      // *and* the customer's unattached ones -- a one-off charge added for a
      // customer belongs on their next bill, whichever bill that is. Another
      // subscription's prorations do not, or a customer with two
      // subscriptions would see one billed on the other's invoice.
      if (subscriptionId) {
        query = query.where((eb) =>
          eb.or([
            eb('subscription_id', '=', subscriptionId),
            eb('subscription_id', 'is', null),
          ]),
        );
      }
      const rows = await query.orderBy('position', 'asc').execute();
      return rows.map(map.toInvoiceItem);
    },
    update: async (id, patch) => {
      const columns = map.invoiceItemPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('invoice_items').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('invoice_items')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toInvoiceItem(row) : notFound('invoice item', id);
    },
    delete: async (id) => {
      await this.#db.deleteFrom('invoice_items').where('id', '=', id).execute();
    },
    totalFor: async (invoiceId) => {
      // Summed in SQL rather than by adding up a page: a total that only counts
      // the first page is a total that is silently wrong.
      const row = await this.#db
        .selectFrom('invoice_items')
        .select(({ fn }) => fn.sum<number>('amount').as('total'))
        .where('invoice_id', '=', invoiceId)
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('invoice_items').selectAll();
      let count = this.#db
        .selectFrom('invoice_items')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.customerId) {
        query = query.where('customer_id', '=', filter.customerId);
        count = count.where('customer_id', '=', filter.customerId);
      }
      if (filter?.pending) {
        query = query.where('invoice_id', 'is', null);
        count = count.where('invoice_id', 'is', null);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toInvoiceItem), total: Number(total?.total ?? 0) };
    },
  };

  readonly subaccounts: SubaccountRepository = {
    insert: async (subaccount) => {
      await this.#db.insertInto('subaccounts').values(map.fromSubaccount(subaccount)).execute();
      return subaccount;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('subaccounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubaccount(row) : null;
    },
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('subaccounts')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_subaccount_code', '=', code)
        .executeTakeFirst();
      return row ? map.toSubaccount(row) : null;
    },
    update: async (id, patch) => {
      const columns = map.subaccountPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('subaccounts').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('subaccounts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toSubaccount(row) : notFound('subaccount', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('subaccounts').selectAll();
      let count = this.#db
        .selectFrom('subaccounts')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toSubaccount), total: Number(total?.total ?? 0) };
    },
  };

  readonly splits: SplitRepository = {
    insert: async (split) => {
      return this.transaction(async (tx) => {
        const inner = (tx as SqliteStorage).#db;
        await inner.insertInto('splits').values(map.fromSplit(split)).execute();
        for (const entry of split.entries) {
          await inner
            .insertInto('split_subaccounts')
            .values({
              split_id: split.id,
              subaccount_id: entry.subaccountId,
              share: entry.share,
            })
            .execute();
        }
        return split;
      });
    },
    byId: async (id) => this.#loadSplit('id', id),
    byCode: async (provider, code) => {
      const row = await this.#db
        .selectFrom('splits')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_split_code', '=', code)
        .executeTakeFirst();
      return row ? map.toSplit(row, await this.#splitEntries(row.id)) : null;
    },
    byCodes: async (provider, codes) => {
      if (codes.length === 0) return new Map();
      const rows = await this.#db
        .selectFrom('splits')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_split_code', 'in', [...new Set(codes)])
        .execute();
      const out = new Map<string, Split>();
      for (const row of rows) {
        out.set(row.provider_split_code, map.toSplit(row, await this.#splitEntries(row.id)));
      }
      return out;
    },
    update: async (id, patch) => {
      const columns: Record<string, unknown> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.bearerType !== undefined) columns.bearer_type = patch.bearerType;
      if (patch.bearerSubaccountId !== undefined) {
        columns.bearer_subaccount_id = patch.bearerSubaccountId;
      }
      if (patch.active !== undefined) columns.active = patch.active ? 1 : 0;
      if (patch.updatedAt !== undefined) columns.updated_at = patch.updatedAt;
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('splits')
          .set(columns as never)
          .where('id', '=', id)
          .execute();
      }
      return (await this.#loadSplit('id', id)) ?? notFound('split', id);
    },
    addSubaccount: async (splitId, subaccountId, share) => {
      await sql`
        INSERT INTO split_subaccounts (split_id, subaccount_id, share)
        VALUES (${splitId}, ${subaccountId}, ${share})
        ON CONFLICT (split_id, subaccount_id) DO UPDATE SET share = ${share}
      `.execute(this.#db);
      return (await this.#loadSplit('id', splitId)) ?? notFound('split', splitId);
    },
    removeSubaccount: async (splitId, subaccountId) => {
      await this.#db
        .deleteFrom('split_subaccounts')
        .where('split_id', '=', splitId)
        .where('subaccount_id', '=', subaccountId)
        .execute();
      return (await this.#loadSplit('id', splitId)) ?? notFound('split', splitId);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('splits').selectAll();
      let count = this.#db
        .selectFrom('splits')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const items = await Promise.all(
        rows.map(async (row) => map.toSplit(row, await this.#splitEntries(row.id))),
      );
      const total = await count.executeTakeFirst();
      return { items, total: Number(total?.total ?? 0) };
    },
  };

  readonly ledger: LedgerRepository = {
    append: async (entry) => {
      await this.#db.insertInto('balance_ledger').values(map.fromLedgerEntry(entry)).execute();
      return entry;
    },
    net: async (provider, currency) => {
      const row = await sql<{ net: number }>`
        SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)
               AS net
          FROM balance_ledger
         WHERE provider = ${provider} AND currency = ${currency}
      `.execute(this.#db);
      return Number(row.rows[0]?.net ?? 0);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('balance_ledger').selectAll();
      let count = this.#db
        .selectFrom('balance_ledger')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.currency) {
        query = query.where('currency', '=', filter.currency);
        count = count.where('currency', '=', filter.currency);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toLedgerEntry), total: Number(total?.total ?? 0) };
    },
    currencies: async (provider) => {
      const rows = await this.#db
        .selectFrom('balance_ledger')
        .select('currency')
        .distinct()
        .where('provider', '=', provider)
        .execute();
      return rows.map((r) => r.currency);
    },
  };

  async #splitEntries(splitId: string) {
    const rows = await this.#db
      .selectFrom('split_subaccounts')
      .innerJoin('subaccounts', 'subaccounts.id', 'split_subaccounts.subaccount_id')
      .select([
        'split_subaccounts.subaccount_id as subaccountId',
        'subaccounts.provider_subaccount_code as subaccountCode',
        'split_subaccounts.share as share',
      ])
      .where('split_subaccounts.split_id', '=', splitId)
      .execute();
    return rows.map((r) => ({
      subaccountId: r.subaccountId,
      subaccountCode: r.subaccountCode,
      share: r.share,
    }));
  }

  async #loadSplit(column: 'id', value: string) {
    const row = await this.#db
      .selectFrom('splits')
      .selectAll()
      .where(column, '=', value)
      .executeTakeFirst();
    return row ? map.toSplit(row, await this.#splitEntries(row.id)) : null;
  }

  readonly disputes: DisputeRepository = {
    insert: async (dispute) => {
      await this.#db.insertInto('disputes').values(map.fromDispute(dispute)).execute();
      return dispute;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('disputes')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDispute(row) : null;
    },
    byProviderDisputeId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('disputes')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_dispute_id', '=', id)
        .executeTakeFirst();
      return row ? map.toDispute(row) : null;
    },
    listByPayment: async (paymentId) => {
      const rows = await this.#db
        .selectFrom('disputes')
        .selectAll()
        .where('payment_id', '=', paymentId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map(map.toDispute);
    },
    update: async (id, patch) => {
      const columns = map.disputePatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db.updateTable('disputes').set(columns).where('id', '=', id).execute();
      }
      const row = await this.#db
        .selectFrom('disputes')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDispute(row) : notFound('dispute', id);
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('disputes').selectAll();
      let count = this.#db
        .selectFrom('disputes')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toDispute), total: Number(total?.total ?? 0) };
    },
  };

  readonly recipients: RecipientRepository = {
    insert: async (recipient) => {
      await this.#db
        .insertInto('transfer_recipients')
        .values(map.fromRecipient(recipient))
        .execute();
      return recipient;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('transfer_recipients')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toRecipient(row) : null;
    },
    byProviderRecipientId: async (provider, id) => {
      const row = await this.#db
        .selectFrom('transfer_recipients')
        .selectAll()
        .where('provider', '=', provider)
        .where('provider_recipient_id', '=', id)
        .executeTakeFirst();
      return row ? map.toRecipient(row) : null;
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      const rows = await this.#db
        .selectFrom('transfer_recipients')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await this.#db
        .selectFrom('transfer_recipients')
        .select(({ fn }) => fn.countAll<number>().as('total'))
        .executeTakeFirst();
      return { items: rows.map(map.toRecipient), total: Number(total?.total ?? 0) };
    },
  };

  readonly events: EventRepository = {
    append: async (event: PayboxEvent) => {
      await this.#db.insertInto('events').values(map.fromEvent(event)).execute();
      return event;
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toEvent(row) : null;
    },
    listByResource: async (resourceId) => {
      const rows = await this.#db
        .selectFrom('events')
        .selectAll()
        .where('resource_id', '=', resourceId)
        .orderBy('sequence', 'asc')
        .execute();
      return rows.map(map.toEvent);
    },
    list: async (filter?: EventFilter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('events').selectAll();
      let count = this.#db
        .selectFrom('events')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.provider) {
        query = query.where('provider', '=', filter.provider);
        count = count.where('provider', '=', filter.provider);
      }
      if (filter?.type) {
        query = query.where('type', '=', filter.type);
        count = count.where('type', '=', filter.type);
      }
      if (filter?.resourceId) {
        query = query.where('resource_id', '=', filter.resourceId);
        count = count.where('resource_id', '=', filter.resourceId);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('sequence', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toEvent), total: Number(total?.total ?? 0) };
    },
    listByResources: async (resourceIds) => {
      const grouped = new Map<string, PayboxEvent[]>();
      if (resourceIds.length === 0) return grouped;
      const rows = await this.#db
        .selectFrom('events')
        .selectAll()
        .where('resource_id', 'in', [...new Set(resourceIds)])
        .orderBy('resource_id', 'asc')
        .orderBy('sequence', 'asc')
        .execute();
      for (const row of rows) {
        const list = grouped.get(row.resource_id) ?? [];
        list.push(map.toEvent(row));
        grouped.set(row.resource_id, list);
      }
      return grouped;
    },
    nextSequence: async (resourceId) => {
      // Upsert-and-return in one statement so concurrent appends to the same
      // resource cannot hand out a duplicate sequence number.
      const result = await sql<{ next_sequence: number }>`
        INSERT INTO event_sequences (resource_id, next_sequence)
        VALUES (${resourceId}, 1)
        ON CONFLICT (resource_id)
          DO UPDATE SET next_sequence = next_sequence + 1
        RETURNING next_sequence
      `.execute(this.#db);
      return Number(result.rows[0]?.next_sequence ?? 1);
    },
  };

  readonly webhooks: WebhookRepository = {
    createEndpoint: async (endpoint: WebhookEndpoint) => {
      await this.#db.insertInto('webhook_endpoints').values(map.fromEndpoint(endpoint)).execute();
      return endpoint;
    },
    updateEndpoint: async (id, patch) => {
      const columns = map.endpointPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('webhook_endpoints')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toEndpoint(row) : notFound('webhook endpoint', id);
    },
    deleteEndpoint: async (id) => {
      await this.#db.deleteFrom('webhook_endpoints').where('id', '=', id).execute();
    },
    endpointById: async (id) => {
      const row = await this.#db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toEndpoint(row) : null;
    },
    endpointsFor: async (provider, eventType) => {
      const rows = await this.#db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('provider', '=', provider)
        .where('enabled', '=', 1)
        .execute();
      // An empty eventTypes list means "everything for this provider", which
      // is the default a developer wants when they register one URL.
      return rows
        .map(map.toEndpoint)
        .filter((e) => e.eventTypes.length === 0 || e.eventTypes.includes(eventType));
    },
    listEndpoints: async () => {
      const rows = await this.#db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map(map.toEndpoint);
    },
    createDelivery: async (delivery: WebhookDelivery) => {
      await this.#db.insertInto('webhook_deliveries').values(map.fromDelivery(delivery)).execute();
      return delivery;
    },
    updateDelivery: async (id, patch) => {
      const columns = map.deliveryPatch(patch);
      if (Object.keys(columns).length > 0) {
        await this.#db
          .updateTable('webhook_deliveries')
          .set(columns)
          .where('id', '=', id)
          .execute();
      }
      const row = await this.#db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDelivery(row) : notFound('webhook delivery', id);
    },
    deliveryById: async (id) => {
      const row = await this.#db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toDelivery(row) : null;
    },
    listDeliveries: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('webhook_deliveries').selectAll();
      let count = this.#db
        .selectFrom('webhook_deliveries')
        .select(({ fn }) => fn.countAll<number>().as('total'));
      if (filter?.status) {
        query = query.where('status', '=', filter.status);
        count = count.where('status', '=', filter.status);
      }
      if (filter?.eventId) {
        query = query.where('event_id', '=', filter.eventId);
        count = count.where('event_id', '=', filter.eventId);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await count.executeTakeFirst();
      return { items: rows.map(map.toDelivery), total: Number(total?.total ?? 0) };
    },
    countDeliveriesByStatus: async () => {
      const rows = await this.#db
        .selectFrom('webhook_deliveries')
        .select(['status'])
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .groupBy('status')
        .execute();
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    },
  };

  readonly jobs: JobRepository = {
    enqueue: async (job: Job) => {
      await this.#db.insertInto('jobs').values(map.fromJob(job)).execute();
      return job;
    },
    claimDue: async (nowISO, leaseUntilISO, limit) => {
      // Lease inside a transaction so the select-then-update is atomic. With
      // BEGIN IMMEDIATE (see the dialect) no other writer can slip between.
      return this.transaction(async (tx) => {
        const inner = (tx as SqliteStorage).#db;
        const candidates = await inner
          .selectFrom('jobs')
          .select('id')
          .where('status', '=', 'ready')
          .where('run_at', '<=', nowISO)
          .orderBy('run_at', 'asc')
          .limit(limit)
          .execute();
        const ids = candidates.map((c) => c.id);
        if (ids.length === 0) return [];

        await inner
          .updateTable('jobs')
          .set({ status: 'leased', lease_expires_at: leaseUntilISO, updated_at: nowISO })
          .where('id', 'in', ids)
          .execute();

        const rows = await inner
          .selectFrom('jobs')
          .selectAll()
          .where('id', 'in', ids)
          .orderBy('run_at', 'asc')
          .execute();
        return rows.map(map.toJob);
      });
    },
    complete: async (id) => {
      await this.#db
        .updateTable('jobs')
        .set({ status: 'done', lease_expires_at: null })
        .where('id', '=', id)
        .execute();
    },
    reschedule: async (id, runAtISO, error) => {
      await sql`
        UPDATE jobs
           SET status = 'ready',
               run_at = ${runAtISO},
               attempt = attempt + 1,
               lease_expires_at = NULL,
               last_error = ${error},
               updated_at = ${runAtISO}
         WHERE id = ${id}
      `.execute(this.#db);
    },
    fail: async (id, error) => {
      await this.#db
        .updateTable('jobs')
        .set({ status: 'failed', last_error: error, lease_expires_at: null })
        .where('id', '=', id)
        .execute();
    },
    cancelGroup: async (groupKey) => {
      const result = await this.#db
        .updateTable('jobs')
        .set({ status: 'cancelled', lease_expires_at: null })
        .where('group_key', '=', groupKey)
        .where('status', 'in', ['ready', 'leased'])
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    byId: async (id) => {
      const row = await this.#db
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? map.toJob(row) : null;
    },
    nextRunAt: async () => {
      const row = await this.#db
        .selectFrom('jobs')
        .select('run_at')
        .where('status', '=', 'ready')
        .orderBy('run_at', 'asc')
        .limit(1)
        .executeTakeFirst();
      return row?.run_at ?? null;
    },
    list: async (filter) => {
      const { limit, offset } = page(filter);
      let query = this.#db.selectFrom('jobs').selectAll();
      if (filter?.status) query = query.where('status', '=', filter.status);
      const rows = await query.orderBy('run_at', 'asc').limit(limit).offset(offset).execute();
      const total = await this.#db
        .selectFrom('jobs')
        .select(({ fn }) => fn.countAll<number>().as('total'))
        .executeTakeFirst();
      return { items: rows.map(map.toJob), total: Number(total?.total ?? 0) };
    },
    reclaimExpiredLeases: async (nowISO) => {
      const result = await this.#db
        .updateTable('jobs')
        .set({ status: 'ready', lease_expires_at: null })
        .where('status', '=', 'leased')
        .where('lease_expires_at', '<', nowISO)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
  };

  readonly idempotency: IdempotencyRepository = {
    get: async (provider: ProviderId, key: string) => {
      const row = await this.#db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('provider', '=', provider)
        .where('key', '=', key)
        .executeTakeFirst();
      if (!row) return null;
      return {
        provider: row.provider as ProviderId,
        key: row.key,
        requestHash: row.request_hash,
        responseStatus: row.response_status,
        responseBody: row.response_body,
        createdAt: row.created_at,
      } satisfies IdempotencyRecord;
    },
    put: async (record: IdempotencyRecord) => {
      await this.#db
        .insertInto('idempotency_keys')
        .values({
          provider: record.provider,
          key: record.key,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: record.responseBody,
          created_at: record.createdAt,
        })
        .execute();
    },
  };
}

export interface OpenStorageOptions {
  /** File path, or ':memory:'. */
  database: string;
}

export interface OpenedStorage {
  storage: Storage;
  db: Kysely<Database>;
}

/** Open the database, apply pending migrations, and return the storage port. */
export async function openStorage(options: OpenStorageOptions): Promise<OpenedStorage> {
  const db = new Kysely<Database>({
    dialect: new NodeSqliteDialect({ database: options.database }),
  });
  await migrate(db);
  return { storage: new SqliteStorage(db), db };
}

export async function migrate(db: Kysely<Database>): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `.execute(db);

  const applied = new Set(
    (await db.selectFrom('schema_migrations').select('id').execute()).map((r) => r.id),
  );

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.transaction().execute(async (trx) => {
      // Migration bodies contain several statements; Kysely's raw sql sends one
      // at a time, so split on semicolons at statement boundaries.
      for (const statement of splitStatements(migration.sql)) {
        await sql.raw(statement).execute(trx);
      }
      await trx
        .insertInto('schema_migrations')
        // A migration's applied_at is genuinely wall-clock provenance — when
        // this schema was written to this file — not simulated time.
        // eslint-disable-next-line no-restricted-syntax
        .values({ id: migration.id, applied_at: new Date().toISOString() })
        .execute();
    });
    ran.push(migration.id);
  }
  return ran;
}

function splitStatements(script: string): string[] {
  return script
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

import { Kysely, sql, type Transaction } from 'kysely';
import { PayboxError, type Customer, type Payment, type PayboxEvent, type ProviderId, type Refund, type Transfer } from '@paybox/shared';
import type {
  AuthorizationRepository,
  CustomerRepository,
  DedicatedAccountRepository,
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
      }
      if (filter?.reference) {
        query = query.where('reference', '=', filter.reference);
        count = count.where('reference', '=', filter.reference);
      }
      if (filter?.customerId) {
        query = query.where('customer_id', '=', filter.customerId);
        count = count.where('customer_id', '=', filter.customerId);
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
      const rows = await this.#db
        .selectFrom('customers')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
      const total = await this.#db
        .selectFrom('customers')
        .select(({ fn }) => fn.countAll<number>().as('total'))
        .executeTakeFirst();
      return { items: rows.map(map.toCustomer), total: Number(total?.total ?? 0) };
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
    bySignature: async (provider, signature) => {
      const row = await this.#db
        .selectFrom('authorizations')
        .selectAll()
        .where('provider', '=', provider)
        .where('signature', '=', signature)
        .executeTakeFirst();
      return row ? map.toAuthorization(row) : null;
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

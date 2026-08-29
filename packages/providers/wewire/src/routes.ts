import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  minorUnitExponent,
  type Clock,
  type IdFactory,
  type LedgerEntry,
  type Random,
  type Subaccount,
} from '@paybox/shared';
import type { PaymentEngine, Storage, TransferRecipient } from '@paybox/core';
import type { PaymentSimulator } from '@paybox/simulator';
import { assertWewireCredentials } from './auth.js';
import { toWewireError } from './errors.js';
import { toMinor, toMajor } from './money.js';
import { assertReferenceForRail, fallbackReference } from './reference.js';
import { assertAccountDetails, type SettlementRail } from './validation.js';
import {
  BANK_CODES,
  MOBILE_MONEY_CODES,
  assertDestination,
  resolveAccountName,
  sandboxOutcome,
  type AfricaChannel,
} from './ghana.js';
import { allPairs, convertMinor, quote } from './rates.js';
import {
  africaStatus,
  balanceWindows,
  paged,
  serializeAfrica,
  serializeBeneficiary,
  serializeBeneficiaryAccount,
  serializePaymentTransaction,
  serializeRate,
  serializeRefundTransaction,
  serializeSubCustomer,
  serializeTransfer,
  serializeWallet,
  type BalanceWindow,
} from './serializers.js';
import {
  accountLookupSchema,
  addAccountSchema,
  collectionSchema,
  conversionPreviewSchema,
  createBeneficiarySchema,
  createSubCustomerSchema,
  creditWalletSchema,
  disbursementSchema,
  initiatePayoutSchema,
  listQuerySchema,
  transactionListSchema,
  updateBeneficiarySchema,
} from './schemas.js';

export interface WewirePluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  random: Random;
  baseUrl: string;
  basePath: string;
  allowAnyKey?: boolean;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'wewire' as const;

/**
 * WeWire-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a WeWire request can never be answered in another provider's envelope.
 * Every route translates a request into engine calls and translates the
 * result back; no payment behaviour lives here (spec §30).
 *
 * Shapes verified against docs.wewire.com (read 2026-08-29); the section is
 * cited beside each group. Coverage is documented honestly in
 * docs/wewire.md.
 *
 * Two structural notes:
 *
 *   - WeWire has no notion of a hosted checkout page, so unlike the other
 *     four adapters there is no `checkout.ts` here. It is an
 *     account-to-account API end to end.
 *   - A **sub-customer** is stored as a canonical subaccount and a
 *     **beneficiary** as a canonical customer with its accounts as transfer
 *     recipients. Both are honest fits for models that already exist, which
 *     is why this adapter needs no migration.
 */
export const wewirePlugin: FastifyPluginAsync<WewirePluginOptions> = async (fastify, options) => {
  const { engine, simulator, storage, clock, ids, random } = options;
  const autoAdvance = options.autoAdvance ?? true;
  const autoAdvanceDelayMs = options.autoAdvanceDelayMs ?? 3_000;

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toWewireError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      success: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: `Unknown endpoint (${request.method} ${request.url}).`,
        statusCode: 404,
      },
    }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertWewireCredentials(request.headers as Record<string, string | string[] | undefined>, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  /* ---------------------------- idempotency ---------------------------- */

  /**
   * WeWire's idempotency, which is unlike everyone else's.
   *
   * *"WeWire supports idempotency on `POST /v1/transactions/initiate-payout`
   * only. On that endpoint, `idempotencyKey` is a body field, not a header."*
   * (docs.wewire.com/working-with-the-api/idempotency.) The Africa endpoints
   * document the same replay semantics in their own pages, so all three go
   * through here.
   *
   * That body-field placement is why the shared `idempotencyPlugin` cannot do
   * this job: it reads a header. Rather than teach the shared hook a
   * provider-specific quirk, the quirk stays in the adapter that has it.
   */
  async function idempotent(
    request: FastifyRequest,
    reply: FastifyReply,
    key: string,
    run: () => Promise<{ status: number; body: unknown }>,
  ): Promise<unknown> {
    const hash = createHash('sha256')
      .update(`${request.method}:${request.url}:${JSON.stringify(request.body ?? {})}`)
      .digest('hex');

    const existing = await storage.idempotency.get(PROVIDER, key);
    if (existing) {
      if (existing.requestHash !== hash) {
        // A replayed key with a different body is a conflict, not a cache
        // hit. WeWire returns 409 ALREADY_EXISTS for exactly this.
        throw new PayboxError(
          'idempotency_conflict',
          `idempotencyKey "${key}" was already used with a different request body.`,
          { details: { wewireCode: 'RESOURCE_ALREADY_EXISTS' } },
        );
      }
      return reply.status(existing.responseStatus).send(JSON.parse(existing.responseBody));
    }

    const result = await run();
    await storage.idempotency.put({
      provider: PROVIDER,
      key,
      requestHash: hash,
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
      createdAt: clock.nowISO(),
    });
    return reply.status(result.status).send(result.body);
  }

  /* ------------------------------ helpers ------------------------------ */

  function assertCurrency(value: string): string {
    if (!isSupportedCurrency(value)) {
      throw new PayboxError('unsupported_currency', `Currency "${value}" is not supported.`, {
        details: { wewireCode: 'CURRENCY_NOT_SUPPORTED' },
      });
    }
    return value;
  }

  /**
   * The whole ledger, oldest first, with each resource's balance window.
   *
   * Every wallet transaction carries `balanceBefore` and `balanceAfter`, and
   * folding the append-only ledger is the only way to produce them that
   * cannot disagree with the balance itself.
   */
  async function ledgerWindows(
    subaccountId: string | null,
  ): Promise<{ windows: Map<string, BalanceWindow>; entries: LedgerEntry[] }> {
    const { items } = await storage.ledger.list({
      provider: PROVIDER,
      subaccountId,
      limit: 10_000,
    });
    const oldestFirst = [...items].reverse();

    // The opening float is a config value, not a ledger row, so it cannot be
    // read off the ledger -- it is recovered per currency by subtracting that
    // currency's net movement from the balance the engine reports.
    const opening = new Map<string, number>();
    for (const currency of new Set(oldestFirst.map((entry) => entry.currency))) {
      const net = oldestFirst.reduce(
        (sum, entry) =>
          entry.currency === currency
            ? sum + (entry.direction === 'credit' ? entry.amount : -entry.amount)
            : sum,
        0,
      );
      opening.set(currency, (await engine.getBalance(PROVIDER, currency, subaccountId)) - net);
    }

    return { windows: balanceWindows(oldestFirst, opening), entries: oldestFirst };
  }

  async function requireSubCustomer(id: string): Promise<Subaccount> {
    const subaccount = await storage.subaccounts.byId(id);
    if (!subaccount || subaccount.provider !== PROVIDER) {
      throw new PayboxError('not_found', `No sub-customer "${id}".`);
    }
    return subaccount;
  }

  async function beneficiaryAccounts(beneficiaryId: string): Promise<TransferRecipient[]> {
    const { items } = await storage.recipients.list({ limit: 1000 });
    return items.filter(
      (recipient) =>
        recipient.provider === PROVIDER && recipient.metadata.beneficiary_id === beneficiaryId,
    );
  }

  async function requireAccount(accountId: string): Promise<TransferRecipient> {
    const account = await storage.recipients.byId(accountId);
    if (!account || account.provider !== PROVIDER) {
      throw new PayboxError('not_found', `No beneficiary account "${accountId}".`);
    }
    return account;
  }

  /**
   * Settle a payout or disbursement the way the rail eventually would.
   *
   * A scheduled job rather than an immediate transition, because WeWire
   * returns `PENDING` and settles asynchronously — and because a job is the
   * one thing `paybox time advance` can drive. `outcome` is decided at
   * enqueue time from the sandbox number, so the answer is deterministic
   * before the clock ever moves.
   */
  async function scheduleTransferOutcome(
    transferId: string,
    outcome: 'successful' | 'failed',
    reason: string | null,
  ): Promise<void> {
    if (!autoAdvance) return;
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: 'transfer.settle',
      payload: { transferId, outcome, ...(reason ? { reason } : {}) },
      status: 'ready',
      runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `transfer:${transferId}`,
      createdAt: clock.nowISO(),
      updatedAt: clock.nowISO(),
    });
  }

  async function schedulePaymentOutcome(
    paymentId: string,
    outcome: 'success' | 'declined',
  ): Promise<void> {
    if (!autoAdvance) return;
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: 'payment.simulate',
      payload: { paymentId, outcome },
      status: 'ready',
      runAt: new Date(clock.now() + autoAdvanceDelayMs).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `payment:${paymentId}`,
      createdAt: clock.nowISO(),
      updatedAt: clock.nowISO(),
    });
  }

  /* ------------------------------ payouts ------------------------------ */

  /**
   * `POST /v1/transactions/initiate-payout` — the offshore payout.
   *
   * Request table and response body from
   * docs.wewire.com/common-workflows/send-a-payout (read 2026-08-29).
   */
  fastify.post('/v1/transactions/initiate-payout', async (request, reply) => {
    authenticate(request);
    const body = initiatePayoutSchema.parse(request.body);

    return idempotent(request, reply, body.idempotencyKey, async () => {
      // Offshore payouts require both, per the request table.
      if (!body.description) {
        throw new PayboxError('validation_failed', 'description is required for offshore payouts.', {
          details: { wewireCode: 'VALIDATION_FAILED', field: 'description' },
        });
      }
      if (!body.purposeCode) {
        throw new PayboxError('validation_failed', 'purposeCode is required for offshore payouts.', {
          details: { wewireCode: 'VALIDATION_FAILED', field: 'purposeCode' },
        });
      }
      if (body.feeBearer === 'RECIPIENT') {
        // Documented as gated behind a feature flag paybox does not model.
        throw new PayboxError(
          'unsupported_operation',
          'feeBearer RECIPIENT requires the CONFIGURABLE_FEE_BEARER feature flag.',
          { details: { wewireCode: 'FEATURE_NOT_ENABLED' } },
        );
      }

      const account = await requireAccount(body.beneficiaryAccountId);
      if (account.currency !== body.to) {
        throw new PayboxError(
          'validation_failed',
          `The beneficiary account settles in ${account.currency}, not ${body.to}.`,
          { details: { wewireCode: 'VALIDATION_FAILED', field: 'beneficiaryAccountId' } },
        );
      }

      const reference = body.reference ?? fallbackReference((max) => random.int(0, max - 1));
      if (body.reference !== undefined) assertReferenceForRail(body.reference, body.to);

      const sourceMinor = toMinor(body.amount, body.from);
      const subCustomerId = body.subCustomerId ?? null;
      if (subCustomerId) await requireSubCustomer(subCustomerId);

      // Cross-currency: the adapter quotes, the engine records. Two integer
      // amounts and the rate that produced them — core never converts.
      const converted =
        body.from === body.to
          ? { amount: sourceMinor, rate: 1 }
          : convertMinor(
              sourceMinor,
              body.from,
              body.to,
              minorUnitExponent(body.to) - minorUnitExponent(body.from),
            );

      const transfer = await engine.createTransfer({
        provider: PROVIDER,
        amount: sourceMinor,
        currency: body.from,
        reference,
        recipientName: account.name,
        recipientAccount: account.accountNumber,
        recipientBankCode: account.bankCode,
        reason: body.description,
        status: 'pending',
        sourceSubaccountId: subCustomerId,
        metadata: {
          idempotency_key: body.idempotencyKey,
          purpose_code: body.purposeCode,
          beneficiary_account_id: account.id,
          fee_bearer: body.feeBearer ?? 'SELF',
          destination_currency: body.to,
          destination_amount: converted.amount,
          fx_rate: converted.rate,
          ...(body.supportingDocuments
            ? { supporting_documents: body.supportingDocuments.length }
            : {}),
        },
      });

      await scheduleTransferOutcome(transfer.id, 'successful', null);

      const { windows } = await ledgerWindows(subCustomerId);
      return {
        status: 200,
        body: serializeTransfer(transfer, {
          balance: windows.get(transfer.id),
          subCustomerId,
        }),
      };
    });
  });

  /**
   * `GET /v1/transactions` — every wallet movement, newest first.
   *
   * Filters and envelope from
   * docs.wewire.com/concepts/transactions/list-transactions.
   */
  fastify.get('/v1/transactions', async (request, reply) => {
    authenticate(request);
    const query = transactionListSchema.parse(request.query ?? {});
    const owner = query.subCustomerId ?? null;
    const { windows } = await ledgerWindows(owner);

    const [transfers, payments, refunds] = await Promise.all([
      storage.transfers.list({ limit: 1000 }),
      storage.payments.list({ provider: PROVIDER, limit: 1000 }),
      storage.refunds.list({ limit: 1000 }),
    ]);

    const rows = [
      ...transfers.items
        .filter((transfer) => transfer.provider === PROVIDER)
        .map((transfer) => ({
          createdAt: transfer.createdAt,
          type: 'DEBIT',
          subCustomerId: transfer.sourceSubaccountId,
          body: serializeTransfer(transfer, { balance: windows.get(transfer.id) }),
        })),
      ...payments.items.map((payment) => ({
        createdAt: payment.createdAt,
        type: 'CREDIT',
        subCustomerId: payment.subaccountId,
        body: serializePaymentTransaction(payment, { balance: windows.get(payment.id) }),
      })),
      ...refunds.items
        .filter((refund) => refund.provider === PROVIDER)
        .map((refund) => ({
          createdAt: refund.createdAt,
          type: 'DEBIT',
          subCustomerId: null,
          body: serializeRefundTransaction(refund, { balance: windows.get(refund.id) }),
        })),
    ];

    const filtered = rows
      .filter((row) => (query.type ? row.type === query.type : true))
      .filter((row) => (query.status ? row.body.status === query.status : true))
      .filter((row) => (query.subCustomerId ? row.subCustomerId === query.subCustomerId : true))
      .filter((row) => (query.from ? row.createdAt >= startOfDay(query.from) : true))
      .filter((row) => (query.to ? row.createdAt <= endOfDay(query.to) : true))
      .filter((row) =>
        query.search
          ? JSON.stringify([row.body.reference, row.body.id, row.body.description])
              .toLowerCase()
              .includes(query.search.toLowerCase())
          : true,
      )
      // "Results are ordered by createdAt descending."
      .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1))
      .map((row) => row.body);

    return reply.send(paged(filtered, query.page, query.limit));
  });

  /** `GET /v1/transactions/:transactionId`. */
  fastify.get<{ Params: { transactionId: string } }>(
    '/v1/transactions/:transactionId',
    async (request, reply) => {
      authenticate(request);
      const { transactionId } = request.params;

      const transfer = await storage.transfers.byId(transactionId);
      if (transfer && transfer.provider === PROVIDER) {
        const { windows } = await ledgerWindows(transfer.sourceSubaccountId);
        return reply.send(serializeTransfer(transfer, { balance: windows.get(transfer.id) }));
      }

      const payment = await storage.payments.byId(transactionId);
      if (payment && payment.provider === PROVIDER) {
        const { windows } = await ledgerWindows(payment.subaccountId);
        return reply.send(
          serializePaymentTransaction(payment, { balance: windows.get(payment.id) }),
        );
      }

      const refund = await storage.refunds.byId(transactionId);
      if (refund && refund.provider === PROVIDER) {
        const { windows } = await ledgerWindows(null);
        return reply.send(serializeRefundTransaction(refund, { balance: windows.get(refund.id) }));
      }

      throw new PayboxError('not_found', `No transaction "${transactionId}".`);
    },
  );

  /* ------------------------------ wallets ------------------------------ */

  /**
   * `GET /v1/wallets` — the business's own balances, one per currency.
   *
   * WeWire publishes no example body for this endpoint, only that there is
   * one wallet per currency per holder. docs/wewire.md marks the shape
   * unverified.
   */
  fastify.get('/v1/wallets', async (request, reply) => {
    authenticate(request);
    return reply.send({ data: await walletsFor(null) });
  });

  /** `GET /v1/subcustomers/:subCustomerId/wallets`. */
  fastify.get<{ Params: { subCustomerId: string } }>(
    '/v1/subcustomers/:subCustomerId/wallets',
    async (request, reply) => {
      authenticate(request);
      const subaccount = await requireSubCustomer(request.params.subCustomerId);
      return reply.send({ data: await walletsFor(subaccount.id) });
    },
  );

  async function walletsFor(subaccountId: string | null): Promise<Record<string, unknown>[]> {
    const currencies = await storage.ledger.currencies(PROVIDER, subaccountId);
    const seen = [...new Set(currencies.length > 0 ? currencies : ['USD'])].sort();
    const wallets: Record<string, unknown>[] = [];
    for (const currency of seen) {
      wallets.push(
        serializeWallet({
          // Stable across calls: a wallet is identified by its owner and
          // currency, so the id must not change between two reads.
          id: `wal_${subaccountId ?? 'business'}_${currency.toLowerCase()}`,
          currency,
          balance: await engine.getBalance(PROVIDER, currency, subaccountId),
          subCustomerId: subaccountId,
          createdAt: clock.nowISO(),
          updatedAt: clock.nowISO(),
        }),
      );
    }
    return wallets;
  }

  /**
   * Emulator-only: put money in a wallet (spec §29 note).
   *
   * WeWire has no such endpoint — funds arrive when someone pushes them at a
   * virtual account. Without it a fresh emulator has a zero balance and every
   * payout fails on `INSUFFICIENT_BALANCE`, so the entire payout flow would be
   * untestable locally. Namespaced under `/paybox/` and marked `emulator-only`
   * in the coverage manifest so it can never be read as WeWire surface.
   */
  fastify.post('/paybox/wallets/credit', async (request, reply) => {
    authenticate(request);
    const body = creditWalletSchema.parse(request.body);
    const currency = assertCurrency(body.currency);
    const subaccountId = body.subCustomerId ?? null;
    if (subaccountId) await requireSubCustomer(subaccountId);

    await engine.creditBalance({
      provider: PROVIDER,
      currency,
      amount: toMinor(body.amount, currency),
      reason: body.reason ?? 'paybox.wallet_credit',
      subaccountId,
    });

    return reply.send({ data: await walletsFor(subaccountId) });
  });

  /* ------------------------------- rates ------------------------------- */

  /** `GET /v1/rates` — every supported pair. */
  fastify.get('/v1/rates', async (request, reply) => {
    authenticate(request);
    const now = clock.nowISO();
    return reply.send({
      data: allPairs().map((pair) =>
        serializeRate({
          base: pair.base,
          destination: pair.destination,
          bid: pair.quote.bid,
          ask: pair.quote.ask,
          updatedAt: now,
        }),
      ),
    });
  });

  /** `GET /v1/rates/:pair` — e.g. `USD-GHS`. */
  fastify.get<{ Params: { pair: string } }>('/v1/rates/:pair', async (request, reply) => {
    authenticate(request);
    const [base, destination] = request.params.pair.toUpperCase().split(/[-/]/);
    if (!base || !destination) {
      throw new PayboxError('validation_failed', 'Pair must look like "USD-GHS".', {
        details: { wewireCode: 'VALIDATION_FAILED', field: 'pair' },
      });
    }
    const rate = quote(base, destination);
    return reply.send(
      serializeRate({
        base,
        destination,
        bid: rate.bid,
        ask: rate.ask,
        updatedAt: clock.nowISO(),
      }),
    );
  });

  /**
   * `POST /v1/rates/conversion/preview`.
   *
   * *"applies the rate you would receive when sending from and receiving to
   * ... The response also includes the fee that would apply to the
   * conversion, computed on the converted amount in the destination
   * currency."* paybox models no pricing, so the fee is zero and
   * docs/wewire.md says so rather than inventing a schedule.
   */
  fastify.post('/v1/rates/conversion/preview', async (request, reply) => {
    authenticate(request);
    const body = conversionPreviewSchema.parse(request.body);
    const sourceMinor = toMinor(body.amount, body.from);
    const converted = convertMinor(
      sourceMinor,
      body.from,
      body.to,
      minorUnitExponent(body.to) - minorUnitExponent(body.from),
    );

    return reply.send({
      from: body.from,
      to: body.to,
      amount: body.amount,
      rate: converted.rate,
      convertedAmount: toMajor(converted.amount, body.to),
      fee: 0,
      // The rate is fixed here, so it is honest to say it does not expire.
      expiresAt: null,
    });
  });

  /* --------------------------- beneficiaries --------------------------- */

  /** `POST /v1/beneficiaries` — the recipient plus its first account. */
  fastify.post('/v1/beneficiaries', async (request, reply) => {
    authenticate(request);
    const body = createBeneficiarySchema.parse(request.body);
    const details = body.accountDetails;
    assertCurrency(details.currency);
    assertAccountDetails({
      settlementRail: details.settlementRail as SettlementRail,
      currency: details.currency,
      iban: details.iban,
      swiftBic: details.swiftBic,
      sortCode: details.sortCode,
      accountNumber: details.accountNumber,
      routingNumber: details.routingNumber,
      accountCategory: details.accountCategory,
    });

    const displayName =
      body.type === 'BUSINESS' ? (body.name ?? '') : `${body.firstName} ${body.lastName}`;

    const customer = await engine.createCustomer({
      provider: PROVIDER,
      email: body.email,
      firstName: body.type === 'BUSINESS' ? (body.name ?? null) : (body.firstName ?? null),
      lastName: body.type === 'BUSINESS' ? null : (body.lastName ?? null),
      metadata: {
        wewire_type: body.type,
        ...(body.name ? { wewire_name: body.name } : {}),
        ...(body.country ? { wewire_country: body.country } : {}),
      },
    });

    const account = await insertAccount(customer.id, displayName, details);
    return reply.status(201).send(serializeBeneficiary(customer, [account]));
  });

  async function insertAccount(
    beneficiaryId: string,
    fallbackName: string,
    details: {
      settlementRail: string;
      currency: string;
      accountName?: string | undefined;
      iban?: string | undefined;
      swiftBic?: string | undefined;
      sortCode?: string | undefined;
      accountNumber?: string | undefined;
      routingNumber?: string | undefined;
      accountCategory?: string | undefined;
      bankName?: string | undefined;
    },
  ): Promise<TransferRecipient> {
    const now = clock.nowISO();
    const optional = (key: string, value: string | undefined): Record<string, string> =>
      value === undefined ? {} : { [key]: value };

    return storage.recipients.insert({
      id: ids.next('ben'),
      provider: PROVIDER,
      providerRecipientId: ids.token(12),
      type: details.settlementRail,
      name: details.accountName ?? fallbackName,
      accountNumber: details.accountNumber ?? details.iban ?? null,
      bankCode: details.sortCode ?? details.routingNumber ?? details.swiftBic ?? null,
      bankName: details.bankName ?? null,
      currency: details.currency,
      metadata: {
        beneficiary_id: beneficiaryId,
        settlement_rail: details.settlementRail,
        ...optional('iban', details.iban),
        ...optional('swiftBic', details.swiftBic),
        ...optional('sortCode', details.sortCode),
        ...optional('routingNumber', details.routingNumber),
        ...optional('accountCategory', details.accountCategory),
        ...optional('accountNumber', details.accountNumber),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  /** `GET /v1/beneficiaries`. */
  fastify.get('/v1/beneficiaries', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query ?? {});
    const { items } = await storage.customers.list({ provider: PROVIDER, limit: 1000 });
    const rows = [];
    for (const customer of items) {
      rows.push(serializeBeneficiary(customer, await beneficiaryAccounts(customer.id)));
    }
    return reply.send(paged(rows, query.page, query.limit));
  });

  /** `GET /v1/beneficiaries/:beneficiaryId`. */
  fastify.get<{ Params: { beneficiaryId: string } }>(
    '/v1/beneficiaries/:beneficiaryId',
    async (request, reply) => {
      authenticate(request);
      const customer = await storage.customers.byId(request.params.beneficiaryId);
      if (!customer || customer.provider !== PROVIDER) {
        throw new PayboxError('not_found', `No beneficiary "${request.params.beneficiaryId}".`);
      }
      return reply.send(serializeBeneficiary(customer, await beneficiaryAccounts(customer.id)));
    },
  );

  /** `PATCH /v1/beneficiaries/:beneficiaryId`. */
  fastify.patch<{ Params: { beneficiaryId: string } }>(
    '/v1/beneficiaries/:beneficiaryId',
    async (request, reply) => {
      authenticate(request);
      const body = updateBeneficiarySchema.parse(request.body ?? {});
      const customer = await storage.customers.byId(request.params.beneficiaryId);
      if (!customer || customer.provider !== PROVIDER) {
        throw new PayboxError('not_found', `No beneficiary "${request.params.beneficiaryId}".`);
      }

      const updated = await engine.updateCustomer(customer.id, {
        ...(body.email ? { email: body.email } : {}),
        ...(body.firstName ? { firstName: body.firstName } : {}),
        ...(body.lastName ? { lastName: body.lastName } : {}),
        metadata: {
          ...customer.metadata,
          ...(body.name ? { wewire_name: body.name } : {}),
          ...(body.country ? { wewire_country: body.country } : {}),
        },
      });
      return reply.send(serializeBeneficiary(updated, await beneficiaryAccounts(updated.id)));
    },
  );

  /**
   * `DELETE /v1/beneficiaries/:beneficiaryId`.
   *
   * Soft: the accounts stay so that a historical payout still resolves the
   * destination it was sent to. Deleting them would rewrite the past, which
   * an append-only system should never do.
   */
  fastify.delete<{ Params: { beneficiaryId: string } }>(
    '/v1/beneficiaries/:beneficiaryId',
    async (request, reply) => {
      authenticate(request);
      const customer = await storage.customers.byId(request.params.beneficiaryId);
      if (!customer || customer.provider !== PROVIDER) {
        throw new PayboxError('not_found', `No beneficiary "${request.params.beneficiaryId}".`);
      }
      await engine.updateCustomer(customer.id, {
        metadata: { ...customer.metadata, wewire_deleted: true },
      });
      return reply.status(204).send();
    },
  );

  /** `GET /v1/beneficiaries/:beneficiaryId/accounts`. */
  fastify.get<{ Params: { beneficiaryId: string } }>(
    '/v1/beneficiaries/:beneficiaryId/accounts',
    async (request, reply) => {
      authenticate(request);
      const query = listQuerySchema.parse(request.query ?? {});
      const accounts = await beneficiaryAccounts(request.params.beneficiaryId);
      return reply.send(paged(accounts.map(serializeBeneficiaryAccount), query.page, query.limit));
    },
  );

  /** `POST /v1/beneficiaries/:beneficiaryId/accounts`. */
  fastify.post<{ Params: { beneficiaryId: string } }>(
    '/v1/beneficiaries/:beneficiaryId/accounts',
    async (request, reply) => {
      authenticate(request);
      const body = addAccountSchema.parse(request.body);
      const customer = await storage.customers.byId(request.params.beneficiaryId);
      if (!customer || customer.provider !== PROVIDER) {
        throw new PayboxError('not_found', `No beneficiary "${request.params.beneficiaryId}".`);
      }
      assertCurrency(body.currency);
      assertAccountDetails({
        settlementRail: body.settlementRail as SettlementRail,
        currency: body.currency,
        iban: body.iban,
        swiftBic: body.swiftBic,
        sortCode: body.sortCode,
        accountNumber: body.accountNumber,
        routingNumber: body.routingNumber,
        accountCategory: body.accountCategory,
      });

      const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
      const account = await insertAccount(customer.id, name, body);
      return reply.status(201).send(serializeBeneficiaryAccount(account));
    },
  );

  /** `GET /v1/beneficiaries/:beneficiaryId/accounts/:accountId`. */
  fastify.get<{ Params: { beneficiaryId: string; accountId: string } }>(
    '/v1/beneficiaries/:beneficiaryId/accounts/:accountId',
    async (request, reply) => {
      authenticate(request);
      const account = await requireAccount(request.params.accountId);
      return reply.send(serializeBeneficiaryAccount(account));
    },
  );

  /* ---------------------------- sub-customers ---------------------------- */

  /** `POST /v1/subcustomers`. */
  fastify.post('/v1/subcustomers', async (request, reply) => {
    authenticate(request);
    const body = createSubCustomerSchema.parse(request.body);

    const subaccount = await engine.createSubaccount({
      provider: PROVIDER,
      businessName: body.name,
      // A WeWire sub-customer has no settlement bank of its own: the platform
      // holds the balance and settles from one place.
      settlementBank: 'wewire',
      accountNumber: ids.token(10),
      percentageCharge: 0,
      currency: 'USD',
      primaryContactEmail: body.email,
      primaryContactName: body.name,
      primaryContactPhone: body.phone ?? null,
      countryCode: body.country,
      metadata: {
        wewire_type: body.type,
        wewire_kyc_status: 'APPROVED',
        ...(body.occupationCode ? { wewire_occupation_code: body.occupationCode } : {}),
        ...(body.metadata ?? {}),
      },
    });

    return reply.status(201).send(serializeSubCustomer(subaccount));
  });

  /** `GET /v1/subcustomers`. */
  fastify.get('/v1/subcustomers', async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query ?? {});
    const { items } = await storage.subaccounts.list({ provider: PROVIDER, limit: 1000 });
    return reply.send(paged(items.map(serializeSubCustomer), query.page, query.limit));
  });

  /** `GET /v1/subcustomers/:subCustomerId`. */
  fastify.get<{ Params: { subCustomerId: string } }>(
    '/v1/subcustomers/:subCustomerId',
    async (request, reply) => {
      authenticate(request);
      return reply.send(serializeSubCustomer(await requireSubCustomer(request.params.subCustomerId)));
    },
  );

  /** `PATCH /v1/subcustomers/:subCustomerId/archive`. */
  fastify.patch<{ Params: { subCustomerId: string } }>(
    '/v1/subcustomers/:subCustomerId/archive',
    async (request, reply) => {
      authenticate(request);
      const subaccount = await requireSubCustomer(request.params.subCustomerId);
      const archived = await engine.updateSubaccount(subaccount.id, { active: false });
      return reply.send(serializeSubCustomer(archived));
    },
  );

  /* ------------------------------- africa ------------------------------- */

  /**
   * `POST /v1/collections` — pull from a customer's mobile-money wallet.
   *
   * Returns `202 Accepted` with a `PENDING` collection, exactly as documented
   * at docs.wewire.com/ghana/collections. The outcome is fixed at this
   * moment from the sandbox number, then delivered by a scheduled job — so
   * `paybox time advance` settles it and the answer never depends on when.
   */
  fastify.post('/v1/collections', async (request, reply) => {
    authenticate(request);
    const body = collectionSchema.parse(request.body);

    return idempotent(request, reply, body.idempotencyKey, async () => {
      assertDestination(body.currency, body.channel as AfricaChannel, body.accountCode, body.accountNumber, {
        collection: true,
      });
      const currency = assertCurrency(body.currency);
      const amount = toMinor(body.amount, currency);
      const reference = body.reference ?? fallbackReference((max) => random.int(0, max - 1));

      const payment = await engine.createPayment({
        provider: PROVIDER,
        amount,
        currency,
        reference,
        paymentMethod: 'mobile_money',
        paymentMethodDetails: {
          account_code: body.accountCode,
          account_number: body.accountNumber,
          ...(body.accountName ? { account_name: body.accountName } : {}),
        },
        status: 'pending',
        providerStatus: 'PENDING',
        metadata: {
          idempotency_key: body.idempotencyKey,
          channel: body.channel,
          fee_bearer: body.feeBearer ?? 'payer',
          ...(body.memo ? { memo: body.memo } : {}),
        },
      });

      // The published sandbox numbers decide it; anything else succeeds,
      // which is what paybox does everywhere a provider gives no signal.
      const outcome = sandboxOutcome(body.accountCode, body.accountNumber) ?? 'successful';
      await schedulePaymentOutcome(payment.id, outcome === 'failed' ? 'declined' : 'success');

      return {
        status: 202,
        body: serializeAfrica(payment, {
          type: 'COLLECTION',
          status: africaStatus(payment),
          amount,
          channel: body.channel,
          accountCode: body.accountCode,
          accountNumber: body.accountNumber,
          accountName: body.accountName ?? null,
          memo: body.memo ?? null,
        }),
      };
    });
  });

  /**
   * `POST /v1/disbursements` — pay out on the Ghana corridor.
   *
   * *"The gross amount is debited from your balance immediately into a
   * PENDING row"*, so the transfer is created before the job is queued and
   * the balance reflects it at once.
   */
  fastify.post('/v1/disbursements', async (request, reply) => {
    authenticate(request);
    const body = disbursementSchema.parse(request.body);

    return idempotent(request, reply, body.idempotencyKey, async () => {
      assertDestination(
        body.currency,
        body.channel as AfricaChannel,
        body.accountCode,
        body.accountNumber,
      );
      const currency = assertCurrency(body.currency);
      const amount = toMinor(body.amount, currency);
      const reference = body.reference ?? fallbackReference((max) => random.int(0, max - 1));

      const transfer = await engine.createTransfer({
        provider: PROVIDER,
        amount,
        currency,
        reference,
        recipientName: body.accountName ?? null,
        recipientAccount: body.accountNumber,
        recipientBankCode: body.accountCode,
        reason: body.memo ?? null,
        status: 'pending',
        metadata: {
          idempotency_key: body.idempotencyKey,
          channel: body.channel,
          corridor: 'GH',
        },
      });

      const outcome = sandboxOutcome(body.accountCode, body.accountNumber) ?? 'successful';
      await scheduleTransferOutcome(
        transfer.id,
        outcome,
        outcome === 'failed' ? 'Operator rejected the transfer' : null,
      );

      return {
        status: 202,
        body: serializeAfrica(transfer, {
          type: 'DISBURSEMENT',
          status: africaStatus(transfer),
          amount,
          channel: body.channel,
          accountCode: body.accountCode,
          accountNumber: body.accountNumber,
          accountName: body.accountName ?? null,
          memo: body.memo ?? null,
        }),
      };
    });
  });

  /**
   * `GET /v1/account-lookup` — resolve the name on a destination.
   *
   * There is no operator to ask, so the name is derived from the number: the
   * same input always resolves to the same name. docs/wewire.md states that
   * plainly rather than letting it read as a real lookup.
   */
  fastify.get('/v1/account-lookup', async (request, reply) => {
    authenticate(request);
    const query = accountLookupSchema.parse(request.query ?? {});
    const channel: AfricaChannel = MOBILE_MONEY_CODES[query.accountCode] ? 'MOBILE_MONEY' : 'BANK';
    assertDestination(query.currency, channel, query.accountCode, query.accountNumber);
    return reply.send({ accountName: resolveAccountName(query.accountNumber) });
  });

  /** `GET /v1/banks` is not a documented WeWire endpoint; the codes are a
   *  reference page. Exposed under `/paybox/` so the tables are reachable
   *  without pretending they are provider surface. */
  fastify.get('/paybox/ghana-codes', async (request, reply) => {
    authenticate(request);
    return reply.send({
      mobileMoney: Object.entries(MOBILE_MONEY_CODES).map(([code, name]) => ({ code, name })),
      banks: Object.entries(BANK_CODES).map(([code, name]) => ({ code, name })),
    });
  });

  void simulator;
};

/** Bare dates are start-of-day / end-of-day UTC, per the filter table. */
function startOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

export async function registerWewire(
  fastify: FastifyInstance,
  options: WewirePluginOptions,
): Promise<void> {
  await fastify.register(wewirePlugin, { ...options, prefix: options.basePath });
}

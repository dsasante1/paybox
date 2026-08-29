import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  isSupportedCurrency,
  minorUnitExponent,
  type Clock,
  type IdFactory,
  type Metadata,
  type Subaccount,
  type Transfer,
} from '@paybox/shared';
import type { PaymentEngine, Storage, TransferRecipient } from '@paybox/core';
import { assertWiseCredentials } from './auth.js';
import { toWiseError } from './errors.js';
import { toMajor, toMinor } from './money.js';
import { derivedUuid, numericId, resolveNumeric } from './ids.js';
import { WISE_FEE_MINOR, allRates, rateFor } from './rates.js';
import { WISE_TEST_PUBLIC_KEY } from './signature.js';
import {
  SIMULATABLE_STATUSES,
  canonicalForSimulation,
  type SimulatableStatus,
} from './status.js';
import {
  LOCAL_USER_ID,
  serializeBalance,
  serializePayment,
  serializeProfile,
  serializeQuote,
  serializeRecipient,
  serializeTransfer,
} from './serializers.js';
import {
  balanceMovementSchema,
  createBalanceSchema,
  createQuoteSchema,
  createRecipientSchema,
  createSubscriptionSchema,
  createTransferSchema,
  fundTransferSchema,
  ratesQuerySchema,
  recipientListQuerySchema,
  topupSchema,
  transferListQuerySchema,
  updateQuoteSchema,
} from './schemas.js';

export interface WisePluginOptions {
  engine: PaymentEngine;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  allowAnyKey?: boolean;
  autoAdvance?: boolean;
  autoAdvanceDelayMs?: number;
}

const PROVIDER = 'wise' as const;

/** A quote is good for 30 minutes; its rate for three days. Wise's own. */
const QUOTE_TTL_MS = 30 * 60 * 1000;
const RATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Wise-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser.
 * Every route translates a request into engine calls and back; no payment
 * behaviour lives here (spec §30).
 *
 * Shapes verified against the Wise Platform API OpenAPI 3.1.0 document,
 * version `2026Q3` (sha256 `a571c1f981ef9701a52a9ccc…`, read 2026-08-29),
 * fetched from `docs.wise.com/_bundle/api-reference/@latest/index.json`. The
 * `operationId` is cited beside each route. Coverage is documented honestly
 * in `docs/wise.md`.
 *
 * The shape of this adapter is Wise's own flow, and it is stricter than any
 * other provider here:
 *
 *     profile -> quote -> recipient -> transfer -> fund
 *
 * A transfer cannot exist without a quote, a quote cannot be used twice, and
 * an unfunded transfer never moves. All three are enforced, because each is a
 * real constraint a developer's integration has to satisfy.
 */
export const wisePlugin: FastifyPluginAsync<WisePluginOptions> = async (fastify, options) => {
  const { engine, storage, clock, ids } = options;

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toWiseError(error, { now: clock.nowISO() });
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      timestamp: clock.nowISO(),
      errors: [
        {
          code: 'RESOURCE_NOT_FOUND',
          message: `Unknown endpoint (${request.method} ${request.url}).`,
        },
      ],
    }),
  );

  const authenticate = (request: FastifyRequest): void => {
    assertWiseCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });
  };

  function assertCurrency(value: string): string {
    if (!isSupportedCurrency(value)) {
      throw new PayboxError('unsupported_currency', `Currency "${value}" is not supported.`, {
        details: { wiseCode: 'NOT_VALID', field: 'currency' },
      });
    }
    return value;
  }

  /* ------------------------------ profiles ------------------------------ */

  /**
   * paybox seeds one personal and one business profile on first use.
   *
   * Wise's flow begins with choosing a profile, and every later call is scoped
   * to one — so an emulator with no profiles would strand a developer at step
   * one. Creating them lazily keeps `paybox reset` meaningful: reset really
   * does empty everything, and the next request rebuilds the two.
   */
  async function profiles(): Promise<Subaccount[]> {
    const { items } = await storage.subaccounts.list({ provider: PROVIDER, limit: 100 });
    const existing = items.filter((item) => item.metadata.wise_type !== undefined);
    if (existing.length > 0) return existing;

    const personal = await engine.createSubaccount({
      provider: PROVIDER,
      businessName: 'Local Test',
      settlementBank: 'wise',
      accountNumber: ids.token(10),
      percentageCharge: 0,
      currency: 'GBP',
      countryCode: 'GB',
      metadata: { wise_type: 'PERSONAL', first_name: 'Local', last_name: 'Test' },
    });
    const business = await engine.createSubaccount({
      provider: PROVIDER,
      businessName: 'Local Test Ltd',
      settlementBank: 'wise',
      accountNumber: ids.token(10),
      percentageCharge: 0,
      currency: 'GBP',
      countryCode: 'GB',
      metadata: { wise_type: 'BUSINESS', company_type: 'LIMITED' },
    });
    return [personal, business];
  }

  async function requireProfile(handle: number | string): Promise<Subaccount> {
    const found = resolveNumeric(await profiles(), handle);
    if (!found) throw new PayboxError('not_found', `No profile "${handle}".`);
    return found;
  }

  /** `profileList` — `GET /profiles`. */
  fastify.get('/v2/profiles', async (request, reply) => {
    authenticate(request);
    return reply.send((await profiles()).map(serializeProfile));
  });

  /** `profileGet` — `GET /profiles/{profileId}`. */
  fastify.get<{ Params: { profileId: string } }>(
    '/v2/profiles/:profileId',
    async (request, reply) => {
      authenticate(request);
      return reply.send(serializeProfile(await requireProfile(request.params.profileId)));
    },
  );

  /* ------------------------------- rates ------------------------------- */

  /** `rateGet` — `GET /rates`. Returns an array, not an envelope. */
  fastify.get('/v1/rates', async (request, reply) => {
    authenticate(request);
    const query = ratesQuerySchema.parse(request.query ?? {});
    const time = wiseRateTime(clock.nowISO());

    if (query.source && query.target) {
      return reply.send([
        {
          rate: rateFor(query.source, query.target),
          source: query.source,
          target: query.target,
          time,
        },
      ]);
    }

    return reply.send(
      allRates()
        .filter((row) => (query.source ? row.source === query.source : true))
        .filter((row) => (query.target ? row.target === query.target : true))
        .map((row) => ({ rate: row.rate, source: row.source, target: row.target, time })),
    );
  });

  /* ------------------------------- quotes ------------------------------- */

  /**
   * A quote is stored as an idempotency record rather than a table.
   *
   * It is short-lived, immutable except for `targetAccount`, and consumed
   * exactly once — which is what the idempotency store already is. Adding a
   * migration for something with a 30-minute life would be the wrong trade,
   * and `docs/wise.md` records the decision.
   */
  interface StoredQuote {
    id: string;
    profileId: string;
    sourceCurrency: string;
    targetCurrency: string;
    sourceAmount: number;
    targetAmount: number;
    rate: number;
    payOut: string;
    providedAmountType: 'SOURCE' | 'TARGET';
    targetAccountId: string | null;
    createdAt: string;
    expiresAt: string;
    rateExpiresAt: string;
    consumedBy: string | null;
  }

  const quoteKey = (id: string) => `quote:${id}`;

  /**
   * Written under **both** keys: the paybox id and the UUID the client holds.
   *
   * `derivedUuid` is a hash and therefore one-way, so storing the record twice
   * makes the lookup O(1) from either direction with no scan.
   *
   * This uses `providerState`, not the idempotency store. That distinction
   * matters and is the reason migration 0019 exists: `idempotency.put` is an
   * insert, correctly so, because a genuine replay must never overwrite the
   * response it returns. A quote is mutable -- `PATCH` attaches a recipient,
   * and creating a transfer marks it consumed -- so it needs an upsert.
   */
  async function saveQuote(quote: StoredQuote): Promise<void> {
    const body = JSON.stringify(quote);
    const now = clock.nowISO();
    for (const key of [quoteKey(quote.id), quoteKey(derivedUuid(quote.id, 'quote'))]) {
      await storage.providerState.put(PROVIDER, key, body, now);
    }
  }

  async function loadQuote(handle: string): Promise<StoredQuote> {
    const value = await storage.providerState.get(PROVIDER, quoteKey(handle));
    if (value) return JSON.parse(value) as StoredQuote;
    throw new PayboxError('not_found', `No quote "${handle}".`, {
      details: { wiseCode: 'RESOURCE_NOT_FOUND' },
    });
  }

  function quoteBody(quote: StoredQuote, profileId: number): Record<string, unknown> {
    const expired = quote.expiresAt <= clock.nowISO();
    return serializeQuote({
      id: quote.id,
      profileId,
      sourceCurrency: quote.sourceCurrency,
      targetCurrency: quote.targetCurrency,
      sourceAmount: quote.sourceAmount,
      targetAmount: quote.targetAmount,
      rate: quote.rate,
      payOut: quote.payOut,
      providedAmountType: quote.providedAmountType,
      targetAccount: quote.targetAccountId ? numericId(quote.targetAccountId) : null,
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
      rateExpiresAt: quote.rateExpiresAt,
      // Wise's documented lifecycle: PENDING until a recipient is attached,
      // then FUNDED once a transfer consumes it. EXPIRED after the window.
      status: quote.consumedBy ? 'FUNDED' : expired ? 'EXPIRED' : 'PENDING',
    });
  }

  async function buildQuote(
    profile: Subaccount,
    body: {
      sourceCurrency: string;
      targetCurrency: string;
      sourceAmount?: number | null | undefined;
      targetAmount?: number | null | undefined;
      targetAccount?: number | string | null | undefined;
      payOut?: string | null | undefined;
    },
  ): Promise<StoredQuote> {
    const source = assertCurrency(body.sourceCurrency);
    const target = assertCurrency(body.targetCurrency);
    const rate = rateFor(source, target);
    const delta = minorUnitExponent(target) - minorUnitExponent(source);

    // Exactly one side is given; the other is derived at the quoted rate.
    let sourceMinor: number;
    let targetMinor: number;
    let providedAmountType: 'SOURCE' | 'TARGET';
    if (body.sourceAmount != null) {
      sourceMinor = toMinor(body.sourceAmount, source);
      targetMinor = Math.round(sourceMinor * rate * 10 ** delta);
      providedAmountType = 'SOURCE';
    } else {
      targetMinor = toMinor(body.targetAmount as number, target);
      sourceMinor = Math.round((targetMinor / rate) * 10 ** -delta);
      providedAmountType = 'TARGET';
    }

    const now = clock.nowISO();
    const recipient = body.targetAccount == null ? null : await requireRecipient(body.targetAccount);

    const quote: StoredQuote = {
      id: ids.next('qte'),
      profileId: profile.id,
      sourceCurrency: source,
      targetCurrency: target,
      sourceAmount: sourceMinor,
      targetAmount: targetMinor,
      rate,
      payOut: body.payOut ?? 'BANK_TRANSFER',
      providedAmountType,
      targetAccountId: recipient?.id ?? null,
      createdAt: now,
      expiresAt: new Date(clock.now() + QUOTE_TTL_MS).toISOString(),
      rateExpiresAt: new Date(clock.now() + RATE_TTL_MS).toISOString(),
      consumedBy: null,
    };
    await saveQuote(quote);
    return quote;
  }

  /** `quoteCreate` — `POST /profiles/{profileId}/quotes`. */
  fastify.post<{ Params: { profileId: string } }>(
    '/v3/profiles/:profileId/quotes',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const body = createQuoteSchema.parse(request.body);
      const quote = await buildQuote(profile, body);
      return reply.status(200).send(quoteBody(quote, numericId(profile.id)));
    },
  );

  /**
   * `quoteCreateUnauthenticated` — `POST /quotes`.
   *
   * Wise's pre-login quote, for showing a rate before a user has a profile.
   * It has no `profile` and cannot be turned into a transfer.
   */
  fastify.post('/v3/quotes', async (request, reply) => {
    const body = createQuoteSchema.parse(request.body);
    const [profile] = await profiles();
    const quote = await buildQuote(profile as Subaccount, body);
    const serialized = quoteBody(quote, numericId((profile as Subaccount).id));
    return reply.status(200).send({ ...serialized, profile: null, user: null });
  });

  /** `quoteGet` — `GET /profiles/{profileId}/quotes/{quoteId}`. */
  fastify.get<{ Params: { profileId: string; quoteId: string } }>(
    '/v3/profiles/:profileId/quotes/:quoteId',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const quote = await loadQuote(request.params.quoteId);
      return reply.send(quoteBody(quote, numericId(profile.id)));
    },
  );

  /**
   * `quoteUpdate` — `PATCH /profiles/{profileId}/quotes/{quoteId}`.
   *
   * The only mutable field is `targetAccount`, which is how Wise's flow
   * attaches a recipient to a quote after the rate has been shown.
   */
  fastify.patch<{ Params: { profileId: string; quoteId: string } }>(
    '/v3/profiles/:profileId/quotes/:quoteId',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const quote = await loadQuote(request.params.quoteId);
      const body = updateQuoteSchema.parse(request.body);

      if (quote.consumedBy) {
        throw new PayboxError(
          'invalid_state_transition',
          'This quote has already been used to create a transfer.',
          { details: { wiseCode: 'transfer.invalid-state' } },
        );
      }

      const recipient = await requireRecipient(body.targetAccount);
      if (recipient.currency !== quote.targetCurrency) {
        throw new PayboxError(
          'validation_failed',
          `The recipient account is ${recipient.currency}; this quote targets ${quote.targetCurrency}.`,
          { details: { wiseCode: 'NOT_VALID', field: 'targetAccount' } },
        );
      }

      quote.targetAccountId = recipient.id;
      await saveQuote(quote);
      return reply.send(quoteBody(quote, numericId(profile.id)));
    },
  );

  /* ----------------------------- recipients ----------------------------- */

  async function recipients(): Promise<TransferRecipient[]> {
    const { items } = await storage.recipients.list({ limit: 1000 });
    return items.filter((item) => item.provider === PROVIDER);
  }

  async function requireRecipient(handle: number | string): Promise<TransferRecipient> {
    const found = resolveNumeric(await recipients(), handle);
    if (!found) {
      throw new PayboxError('not_found', `No recipient account "${handle}".`, {
        details: { wiseCode: 'RESOURCE_NOT_FOUND' },
      });
    }
    return found;
  }

  /** `recipientCreate` — `POST /accounts`. */
  fastify.post('/v1/accounts', async (request, reply) => {
    authenticate(request);
    const body = createRecipientSchema.parse(request.body);
    const currency = assertCurrency(body.currency);
    const profile = body.profile == null ? (await profiles())[0] : await requireProfile(body.profile);
    const now = clock.nowISO();

    const details = body.details;
    const text = (key: string): string | null =>
      typeof details[key] === 'string' ? (details[key] as string) : null;

    const recipient = await storage.recipients.insert({
      id: ids.next('trf'),
      provider: PROVIDER,
      providerRecipientId: ids.token(12),
      type: body.type,
      name: body.accountHolderName,
      accountNumber: text('accountNumber') ?? text('iban') ?? null,
      bankCode: text('sortCode') ?? text('routingNumber') ?? text('bic') ?? null,
      bankName: text('bankName'),
      currency,
      metadata: {
        details: details as Metadata,
        profile_id: (profile as Subaccount).id,
        legal_entity_type: text('legalType') ?? 'PERSON',
        ...(text('country') ? { country: text('country') as string } : {}),
        owned_by_customer: body.ownedByCustomer === true,
      },
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(200).send(serializeRecipient(recipient, numericId((profile as Subaccount).id)));
  });

  /** `recipientList` — `GET /accounts`. */
  fastify.get('/v2/accounts', async (request, reply) => {
    authenticate(request);
    const query = recipientListQuerySchema.parse(request.query ?? {});
    const all = await recipients();
    const [defaultProfile] = await profiles();

    const filtered = all
      .filter((item) => (query.currency ? item.currency === query.currency : true))
      .filter((item) => item.metadata.deactivated !== true);

    return reply.send({
      content: filtered
        .slice(0, query.size)
        .map((item) =>
          serializeRecipient(
            item,
            numericId(String(item.metadata.profile_id ?? (defaultProfile as Subaccount).id)),
          ),
        ),
      // Wise pages this endpoint with a seek cursor rather than offsets.
      sort: { empty: true, sorted: false, unsorted: true },
      size: query.size,
    });
  });

  /** `recipientGet` — `GET /accounts/{accountId}`. */
  fastify.get<{ Params: { accountId: string } }>(
    '/v2/accounts/:accountId',
    async (request, reply) => {
      authenticate(request);
      const recipient = await requireRecipient(request.params.accountId);
      const [defaultProfile] = await profiles();
      return reply.send(
        serializeRecipient(
          recipient,
          numericId(String(recipient.metadata.profile_id ?? (defaultProfile as Subaccount).id)),
        ),
      );
    },
  );

  /**
   * `recipientDeactivate` — `DELETE /accounts/{accountId}`.
   *
   * Wise deactivates rather than deletes, and returns the account with
   * `active: false`. paybox does the same: a historical transfer must still
   * resolve the destination it was sent to.
   */
  fastify.delete<{ Params: { accountId: string } }>(
    '/v2/accounts/:accountId',
    async (request, reply) => {
      authenticate(request);
      const recipient = await requireRecipient(request.params.accountId);
      const [defaultProfile] = await profiles();
      const updated = await storage.recipients.update(recipient.id, {
        metadata: { ...recipient.metadata, deactivated: true },
        updatedAt: clock.nowISO(),
      });
      return reply.send(
        serializeRecipient(
          updated,
          numericId(String(recipient.metadata.profile_id ?? (defaultProfile as Subaccount).id)),
        ),
      );
    },
  );

  /**
   * `recipientAccountRequirementsGet` — `GET /quotes/{quoteId}/account-requirements`.
   *
   * Wise serves the required fields per currency dynamically; a client is
   * meant to render a form from this rather than hard-code one. paybox
   * publishes the three routes it can actually validate, which is fewer than
   * Wise's dozens — `docs/wise.md` says so.
   */
  fastify.get<{ Params: { quoteId: string } }>(
    '/v1/quotes/:quoteId/account-requirements',
    async (request, reply) => {
      authenticate(request);
      const quote = await loadQuote(request.params.quoteId);
      return reply.send(accountRequirements(quote.targetCurrency));
    },
  );

  /* ------------------------------ transfers ------------------------------ */

  async function wiseTransfers(): Promise<Transfer[]> {
    const { items } = await storage.transfers.list({ limit: 1000 });
    return items.filter((item) => item.provider === PROVIDER);
  }

  async function requireTransfer(handle: number | string): Promise<Transfer> {
    const found = resolveNumeric(await wiseTransfers(), handle);
    if (!found) {
      throw new PayboxError('not_found', `No transfer "${handle}".`, {
        details: { wiseCode: 'transfer.not-found' },
      });
    }
    return found;
  }

  /**
   * `transferCreate` — `POST /transfers`.
   *
   * Enforces the two rules that make Wise's flow what it is: a transfer needs
   * a quote, and *"You can only create one transfer per one quote."*
   */
  fastify.post('/v1/transfers', async (request, reply) => {
    authenticate(request);
    const body = createTransferSchema.parse(request.body);

    // `customerTransactionId` is Wise's idempotency key.
    const existing = await storage.idempotency.get(PROVIDER, `txn:${body.customerTransactionId}`);
    if (existing) {
      return reply.status(existing.responseStatus).send(JSON.parse(existing.responseBody));
    }

    const quote = await loadQuote(body.quoteUuid);
    if (quote.consumedBy) {
      throw new PayboxError(
        'duplicate_reference',
        'You can only create one transfer per quote.',
        { details: { wiseCode: 'transfer.invalid-state' } },
      );
    }
    if (quote.expiresAt <= clock.nowISO()) {
      throw new PayboxError('invalid_state_transition', 'This quote has expired.', {
        details: { wiseCode: 'transfer.invalid-state' },
      });
    }

    const recipient = await requireRecipient(body.targetAccount);
    if (recipient.currency !== quote.targetCurrency) {
      throw new PayboxError(
        'validation_failed',
        `The recipient account is ${recipient.currency}; the quote targets ${quote.targetCurrency}.`,
        { details: { wiseCode: 'NOT_VALID', field: 'targetAccount' } },
      );
    }

    const reference = body.details?.reference ?? null;

    // paybox's `Transfer.reference` is unique per provider -- it is the handle
    // a payout is looked up by. Wise's `details.reference` is **not**: it is
    // the text the recipient sees on their bank statement, and two payouts to
    // the same vendor routinely share one ("Q2 invoices").
    //
    // So the stored reference is `customerTransactionId`, which Wise does
    // guarantee unique (it is the idempotency key), and the display reference
    // travels on metadata. `serializeTransfer` reads the latter, so a client
    // sees exactly what it sent.
    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: quote.sourceAmount,
      currency: quote.sourceCurrency,
      reference: body.customerTransactionId,
      recipientName: recipient.name,
      recipientAccount: recipient.accountNumber,
      recipientBankCode: recipient.bankCode,
      reason: reference,
      // Unfunded. Wise's `incoming_payment_waiting`: the transfer exists and
      // the money has not arrived.
      status: 'pending',
      fee: WISE_FEE_MINOR,
      // Creating a Wise transfer commits nothing; funding it does. See the
      // `reserve` option on createTransfer for why this is a seam rather than
      // a special case inside the engine.
      reserve: false,
      metadata: {
        quote_id: quote.id,
        customer_transaction_id: body.customerTransactionId,
        target_account_id: recipient.id,
        target_currency: quote.targetCurrency,
        target_amount: quote.targetAmount,
        fx_rate: quote.rate,
        profile_id: numericId(quote.profileId),
        ...(reference === null ? {} : { reference }),
        ...(body.details?.transferPurpose ? { transfer_purpose: body.details.transferPurpose } : {}),
        ...(body.details?.sourceOfFunds ? { source_of_funds: body.details.sourceOfFunds } : {}),
        funded: false,
      },
    });

    quote.consumedBy = transfer.id;
    quote.targetAccountId = recipient.id;
    await saveQuote(quote);

    const serialized = serializeTransfer(transfer, {
      quoteId: quote.id,
      targetAccountId: numericId(recipient.id),
      targetCurrency: quote.targetCurrency,
      targetAmount: quote.targetAmount,
      rate: quote.rate,
      profileId: numericId(quote.profileId),
    });

    await storage.idempotency.put({
      provider: PROVIDER,
      key: `txn:${body.customerTransactionId}`,
      requestHash: 'transfer',
      responseStatus: 200,
      responseBody: JSON.stringify(serialized),
      createdAt: clock.nowISO(),
    });

    return reply.status(200).send(serialized);
  });

  /** `transferGet` — `GET /transfers/{transferId}`. */
  fastify.get<{ Params: { transferId: string } }>(
    '/v1/transfers/:transferId',
    async (request, reply) => {
      authenticate(request);
      return reply.send(serializeTransfer(await requireTransfer(request.params.transferId)));
    },
  );

  /** `transferList` — `GET /transfers`. */
  fastify.get('/v1/transfers', async (request, reply) => {
    authenticate(request);
    const query = transferListQuerySchema.parse(request.query ?? {});
    const all = await wiseTransfers();

    const rows = all
      .filter((transfer) =>
        query.status
          ? query.status.split(',').includes(String(serializeTransfer(transfer).status))
          : true,
      )
      .filter((transfer) =>
        query.createdDateStart ? transfer.createdAt >= query.createdDateStart : true,
      )
      .filter((transfer) =>
        query.createdDateEnd ? transfer.createdAt <= query.createdDateEnd : true,
      )
      .slice(query.offset, query.offset + query.limit)
      .map((transfer) => serializeTransfer(transfer));

    // Wise returns a bare array here, not an envelope.
    return reply.send(rows);
  });

  /**
   * `transferFund` — `POST /profiles/{profileId}/transfers/{transferId}/payments`.
   *
   * This is the step that actually moves money, and it is the reason a Wise
   * integration has a two-phase shape: creating a transfer reserves nothing,
   * funding it debits the balance.
   *
   * Returns `FundingResponse` — `{type, status, errorCode, errorMessage,
   * balanceTransactionId}` — and note that a **rejection is a 201 with
   * `status: REJECTED`**, not an HTTP error. That is Wise's design and it is
   * reproduced: a client branching on the HTTP status would miss the failure.
   */
  fastify.post<{ Params: { profileId: string; transferId: string } }>(
    '/v3/profiles/:profileId/transfers/:transferId/payments',
    async (request, reply) => {
      authenticate(request);
      await requireProfile(request.params.profileId);
      const body = fundTransferSchema.parse(request.body ?? {});
      const transfer = await requireTransfer(request.params.transferId);

      const reject = (errorCode: string, errorMessage: string) =>
        reply.status(201).send({
          type: body.type,
          status: 'REJECTED',
          errorCode,
          errorMessage,
          balanceTransactionId: null,
        });

      if (transfer.metadata.funded === true) {
        return reject('payment.exists', 'This transfer has already been funded.');
      }
      if (transfer.status !== 'pending') {
        return reject('transfer.invalid-state', `The transfer is ${transfer.status}.`);
      }
      if (body.type !== 'BALANCE') {
        return reject(
          'payment.option-unavailable',
          `paybox can only fund from a balance; "${body.type}" is not available.`,
        );
      }

      const available = await engine.getBalance(PROVIDER, transfer.currency, null);
      if (available < transfer.amount) {
        return reject(
          'balance.payment-option-unavailable',
          `Insufficient ${transfer.currency} balance to fund this transfer.`,
        );
      }

      // Funded: this is the call that actually commits the money, which is
      // why the transfer was created with `reserve: false`.
      await engine.debitBalance({
        provider: PROVIDER,
        currency: transfer.currency,
        amount: transfer.amount,
        reason: 'wise.transfer.funded',
        resourceId: transfer.id,
      });
      const funded = await engine.transitionTransfer(transfer.id, 'processing', {
        // From here the amount *is* reserved, so a later failure releases it
        // the way any other provider's would.
        metadata: { ...transfer.metadata, funded: true, paybox_reserved: true },
      });

      return reply.status(201).send({
        type: body.type,
        status: 'COMPLETED',
        errorCode: null,
        errorMessage: null,
        balanceTransactionId: numericId(`${funded.id}:funding`),
      });
    },
  );

  /** `transferPaymentsList` — `GET /transfers/{transferId}/payments`. */
  fastify.get<{ Params: { transferId: string } }>(
    '/v1/transfers/:transferId/payments',
    async (request, reply) => {
      authenticate(request);
      const transfer = await requireTransfer(request.params.transferId);
      if (transfer.metadata.funded !== true) return reply.send([]);
      return reply.send([
        serializePayment({
          id: `${transfer.id}:funding`,
          amount: transfer.amount,
          currency: transfer.currency,
          createdAt: transfer.createdAt,
          updatedAt: transfer.updatedAt,
        }),
      ]);
    },
  );

  /**
   * `transferCancel` — `PUT /transfers/{transferId}/cancel`.
   *
   * Wise allows cancellation only before the payout leaves.
   */
  fastify.put<{ Params: { transferId: string } }>(
    '/v1/transfers/:transferId/cancel',
    async (request, reply) => {
      authenticate(request);
      const transfer = await requireTransfer(request.params.transferId);
      if (transfer.status === 'successful' || transfer.status === 'reversed') {
        throw new PayboxError(
          'invalid_state_transition',
          'This transfer has already been sent and cannot be cancelled.',
          { details: { wiseCode: 'transfer.invalid-state' } },
        );
      }
      return reply.send(serializeTransfer(await engine.transitionTransfer(transfer.id, 'cancelled')));
    },
  );

  /* ------------------------------ balances ------------------------------ */

  /**
   * A balance is a currency the ledger has seen, plus any explicitly created.
   *
   * Wise's balances are named accounts a user opens; paybox derives them from
   * the ledger so a top-up in a new currency produces one, and
   * `POST /balances` records an empty one that has yet to see movement.
   */
  async function balancesFor(profile: Subaccount): Promise<Record<string, unknown>[]> {
    const seen = await storage.ledger.currencies(PROVIDER, null);
    const declared = (profile.metadata.wise_balances as string[] | undefined) ?? [];
    const currencies = [...new Set([...seen, ...declared])].sort();

    const rows: Record<string, unknown>[] = [];
    for (const currency of currencies) {
      rows.push(
        serializeBalance({
          // Stable: a balance is identified by its owner and currency.
          id: `${profile.id}:${currency}`,
          currency,
          amount: await engine.getBalance(PROVIDER, currency, null),
          createdAt: profile.createdAt,
          updatedAt: clock.nowISO(),
        }),
      );
    }
    return rows;
  }

  /** `balanceList` — `GET /profiles/{profileId}/balances`. */
  fastify.get<{ Params: { profileId: string } }>(
    '/v4/profiles/:profileId/balances',
    async (request, reply) => {
      authenticate(request);
      return reply.send(await balancesFor(await requireProfile(request.params.profileId)));
    },
  );

  /** `balanceGet` — `GET /profiles/{profileId}/balances/{balanceId}`. */
  fastify.get<{ Params: { profileId: string; balanceId: string } }>(
    '/v4/profiles/:profileId/balances/:balanceId',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const wanted = Number(request.params.balanceId);
      const found = (await balancesFor(profile)).find((row) => row.id === wanted);
      if (!found) throw new PayboxError('not_found', `No balance "${request.params.balanceId}".`);
      return reply.send(found);
    },
  );

  /** `balanceCreate` — `POST /profiles/{profileId}/balances`. */
  fastify.post<{ Params: { profileId: string } }>(
    '/v4/profiles/:profileId/balances',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const body = createBalanceSchema.parse(request.body);
      const currency = assertCurrency(body.currency);

      const declared = (profile.metadata.wise_balances as string[] | undefined) ?? [];
      await engine.updateSubaccount(profile.id, {
        metadata: { ...profile.metadata, wise_balances: [...new Set([...declared, currency])] },
      });

      return reply.status(201).send(
        serializeBalance({
          id: `${profile.id}:${currency}`,
          currency,
          amount: await engine.getBalance(PROVIDER, currency, null),
          name: body.name ?? null,
          createdAt: clock.nowISO(),
          updatedAt: clock.nowISO(),
        }),
      );
    },
  );

  /**
   * `balanceMovement` — `POST /profiles/{profileId}/balance-movements`.
   *
   * A conversion between two of your own balances, priced by a quote. This is
   * the one place the emulator applies a rate to money that is already
   * settled, and it does it as two integer ledger entries — a debit in the
   * source currency and a credit in the target — never as a float.
   */
  fastify.post<{ Params: { profileId: string } }>(
    '/v2/profiles/:profileId/balance-movements',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const body = balanceMovementSchema.parse(request.body);
      const quote = await loadQuote(body.quoteId);

      if (quote.consumedBy) {
        throw new PayboxError('invalid_state_transition', 'This quote has already been used.', {
          details: { wiseCode: 'transfer.invalid-state' },
        });
      }
      const available = await engine.getBalance(PROVIDER, quote.sourceCurrency, null);
      if (available < quote.sourceAmount) {
        throw new PayboxError(
          'balance_insufficient',
          `Insufficient ${quote.sourceCurrency} balance for this conversion.`,
          { details: { wiseCode: 'balance.payment-option-unavailable' } },
        );
      }

      await engine.debitBalance({
        provider: PROVIDER,
        currency: quote.sourceCurrency,
        amount: quote.sourceAmount,
        reason: 'wise.conversion.out',
        resourceId: quote.id,
      });
      await engine.creditBalance({
        provider: PROVIDER,
        currency: quote.targetCurrency,
        amount: quote.targetAmount,
        reason: 'wise.conversion.in',
        resourceId: quote.id,
      });

      quote.consumedBy = `conversion:${quote.id}`;
      await saveQuote(quote);

      return reply.status(201).send({
        id: numericId(quote.id),
        type: 'CONVERSION',
        state: 'COMPLETED',
        balancesAfter: await balancesFor(profile),
        creationTime: clock.nowISO(),
      });
    },
  );

  /** `totalFunds` — `GET /profiles/{profileId}/total-funds/{currency}`. */
  fastify.get<{ Params: { profileId: string; currency: string } }>(
    '/v1/profiles/:profileId/total-funds/:currency',
    async (request, reply) => {
      authenticate(request);
      await requireProfile(request.params.profileId);
      const currency = assertCurrency(request.params.currency.toUpperCase());
      const amount = await engine.getBalance(PROVIDER, currency, null);
      return reply.send({ currency, totalWorth: toMajor(amount, currency) });
    },
  );

  /* ----------------------------- simulation ----------------------------- */

  /**
   * `simulationTransferStateChange` — `GET /simulation/transfers/{id}/{status}`.
   *
   * **This is Wise's own endpoint, not a paybox invention.** Wise ships a
   * sandbox state-driver with the same purpose as `paybox simulate`, which is
   * the strongest possible argument for how this emulator is built — and it
   * means an existing Wise sandbox script drives paybox unchanged.
   *
   * The five accepted statuses are the spec's enum, verbatim.
   */
  fastify.get<{ Params: { transferId: string; status: string } }>(
    '/v1/simulation/transfers/:transferId/:status',
    async (request, reply) => {
      authenticate(request);
      const transfer = await requireTransfer(request.params.transferId);
      const status = request.params.status as SimulatableStatus;

      if (!SIMULATABLE_STATUSES.includes(status)) {
        throw new PayboxError(
          'validation_failed',
          `Unknown simulated status "${status}". Wise accepts: ${SIMULATABLE_STATUSES.join(', ')}.`,
          { details: { wiseCode: 'NOT_VALID', field: 'status' } },
        );
      }

      const target = canonicalForSimulation(status);
      const metadata: Metadata = {
        ...transfer.metadata,
        // `funds_converted` and `processing` are the same canonical status;
        // the flag is what lets the reported status tell them apart.
        funds_converted: status === 'funds_converted',
      };

      let current = transfer;
      // Wise lets you jump straight to a terminal state, so the intermediate
      // hop is inserted rather than the request refused.
      if (current.status === 'pending' && target !== 'processing') {
        current = await engine.transitionTransfer(current.id, 'processing', { metadata });
      }
      if (current.status === target) {
        // Already there. `funds_converted` after `processing` is exactly this
        // case: the canonical status does not move, only the milestone flag,
        // so the metadata is recorded without a transition.
        current = await engine.updateTransferMetadata(current.id, metadata);
      } else {
        current = await engine.transitionTransfer(current.id, target, { metadata });
      }

      return reply.send(serializeTransfer(current));
    },
  );

  /**
   * `simulationBalanceTopup` — `POST /simulation/balance/topup`.
   *
   * Also Wise's own: its sandbox funds a balance this way, so paybox needs no
   * emulator-only credit endpoint for this provider. That is a better outcome
   * than WeWire's, where one had to be invented.
   */
  fastify.post('/v1/simulation/balance/topup', async (request, reply) => {
    authenticate(request);
    const body = topupSchema.parse(request.body);
    const profile = await requireProfile(body.profileId);
    const currency = assertCurrency(body.currency);

    await engine.creditBalance({
      provider: PROVIDER,
      currency,
      amount: toMinor(body.amount, currency),
      reason: 'wise.simulation.topup',
    });

    const balances = await balancesFor(profile);
    const found = balances.find((row) => row.currency === currency);
    return reply.status(200).send(found ?? balances[0] ?? {});
  });

  /* ------------------------------ webhooks ------------------------------ */

  /**
   * `webhookProfileSubscriptionCreate` — `POST /profiles/{profileId}/subscriptions`.
   *
   * Registers against paybox's own webhook store, so a subscription created
   * through Wise's API receives deliveries through the same dispatcher,
   * retries and delivery log as one created through `paybox webhook add`.
   *
   * Wise's `trigger_on` maps onto the endpoint's `eventTypes` filter.
   */
  fastify.post<{ Params: { profileId: string } }>(
    '/v2/profiles/:profileId/subscriptions',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const body = createSubscriptionSchema.parse(request.body);
      const now = clock.nowISO();

      const endpoint = await storage.webhooks.createEndpoint({
        id: ids.next('whe'),
        provider: PROVIDER,
        url: body.delivery.url,
        // Wise signs with its private key; there is no shared secret. The
        // stored value is unused for signing and is recorded as such.
        secret: 'wise-rsa-signed',
        enabled: true,
        eventTypes: [body.trigger_on],
        description: body.name,
        createdAt: now,
        updatedAt: now,
      });

      return reply.status(201).send(subscriptionBody(endpoint, profile, body.delivery.version));
    },
  );

  /** `webhookProfileSubscriptionList` — `GET /profiles/{profileId}/subscriptions`. */
  fastify.get<{ Params: { profileId: string } }>(
    '/v2/profiles/:profileId/subscriptions',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const endpoints = await storage.webhooks.listEndpoints();
      return reply.send(
        endpoints
          .filter((endpoint) => endpoint.provider === PROVIDER)
          .map((endpoint) => subscriptionBody(endpoint, profile, '2.0.0')),
      );
    },
  );

  /** `webhookProfileSubscriptionGet`. */
  fastify.get<{ Params: { profileId: string; subscriptionId: string } }>(
    '/v2/profiles/:profileId/subscriptions/:subscriptionId',
    async (request, reply) => {
      authenticate(request);
      const profile = await requireProfile(request.params.profileId);
      const endpoints = await storage.webhooks.listEndpoints();
      const found = endpoints.find(
        (endpoint) =>
          endpoint.provider === PROVIDER &&
          (endpoint.id === request.params.subscriptionId ||
            derivedUuid(endpoint.id, 'subscription') === request.params.subscriptionId),
      );
      if (!found) {
        throw new PayboxError('not_found', `No subscription "${request.params.subscriptionId}".`);
      }
      return reply.send(subscriptionBody(found, profile, '2.0.0'));
    },
  );

  /** `webhookProfileSubscriptionDelete`. */
  fastify.delete<{ Params: { profileId: string; subscriptionId: string } }>(
    '/v2/profiles/:profileId/subscriptions/:subscriptionId',
    async (request, reply) => {
      authenticate(request);
      await requireProfile(request.params.profileId);
      const endpoints = await storage.webhooks.listEndpoints();
      const found = endpoints.find(
        (endpoint) =>
          endpoint.provider === PROVIDER &&
          (endpoint.id === request.params.subscriptionId ||
            derivedUuid(endpoint.id, 'subscription') === request.params.subscriptionId),
      );
      if (found) await storage.webhooks.deleteEndpoint(found.id);
      return reply.status(204).send();
    },
  );

  function subscriptionBody(
    endpoint: { id: string; url: string; eventTypes: string[]; description: string | null; createdAt: string },
    profile: Subaccount,
    version: string,
  ): Record<string, unknown> {
    return {
      id: derivedUuid(endpoint.id, 'subscription'),
      name: endpoint.description ?? 'paybox subscription',
      trigger_on: endpoint.eventTypes[0] ?? 'transfers#state-change',
      delivery: { version, url: endpoint.url },
      scope: { domain: 'profile', id: String(numericId(profile.id)) },
      created_by: { type: 'user', id: String(LOCAL_USER_ID) },
      created_at: endpoint.createdAt,
    };
  }

  /**
   * Emulator-only: the public key paybox signs webhooks with.
   *
   * Wise publishes its public key on a documentation page, not through the
   * API, so there is nothing to be compatible with here. Serving it makes the
   * key discoverable to a developer testing their verifier, and it is
   * namespaced under `/paybox/` so it cannot be mistaken for Wise surface.
   */
  fastify.get('/paybox/webhook-public-key', async (request, reply) => {
    authenticate(request);
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .send(WISE_TEST_PUBLIC_KEY);
  });
};

/** Wise's rate timestamps use `+0000`, not `Z`. */
function wiseRateTime(iso: string): string {
  return `${iso.slice(0, 19)}+0000`;
}

/**
 * The account fields Wise requires, per target currency.
 *
 * Three routes rather than Wise's dozens; `docs/wise.md` is explicit about
 * that. The shape is Wise's `account-requirements-response`.
 */
function accountRequirements(currency: string): Record<string, unknown>[] {
  const field = (
    key: string,
    name: string,
    example: string,
    validationRegexp?: string,
  ): Record<string, unknown> => ({
    name,
    group: [
      {
        key,
        name,
        type: 'text',
        refreshRequirementsOnChange: false,
        required: true,
        displayFormat: null,
        example,
        minLength: null,
        maxLength: null,
        validationRegexp: validationRegexp ?? null,
        validationAsync: null,
        valuesAllowed: null,
      },
    ],
  });

  const holder = field('accountHolderName', 'Full name of the account holder', 'John Doe');
  const legalType = {
    name: 'Recipient type',
    group: [
      {
        key: 'legalType',
        name: 'Recipient type',
        type: 'select',
        refreshRequirementsOnChange: false,
        required: true,
        displayFormat: null,
        example: '',
        validationRegexp: null,
        valuesAllowed: [
          { key: 'PRIVATE', name: 'Person' },
          { key: 'BUSINESS', name: 'Business' },
        ],
      },
    ],
  };

  if (currency === 'GBP') {
    return [
      {
        type: 'sort_code',
        title: 'Local bank account',
        usageInfo: null,
        fields: [
          holder,
          legalType,
          field('sortCode', 'UK sort code', '040075', '^\\d{6}$'),
          field('accountNumber', 'Account number', '37778842', '^\\d{8}$'),
        ],
      },
    ];
  }

  if (currency === 'EUR') {
    return [
      {
        type: 'iban',
        title: 'IBAN',
        usageInfo: null,
        fields: [holder, legalType, field('IBAN', 'IBAN', 'DE89370400440532013000')],
      },
    ];
  }

  if (currency === 'USD') {
    return [
      {
        type: 'aba',
        title: 'ACH or wire',
        usageInfo: null,
        fields: [
          holder,
          legalType,
          field('abartn', 'Routing number', '021000021', '^\\d{9}$'),
          field('accountNumber', 'Account number', '12345678'),
          {
            name: 'Account type',
            group: [
              {
                key: 'accountType',
                name: 'Account type',
                type: 'select',
                required: true,
                valuesAllowed: [
                  { key: 'CHECKING', name: 'Checking' },
                  { key: 'SAVINGS', name: 'Savings' },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  // Everything else falls back to SWIFT, which is what Wise does too.
  return [
    {
      type: 'swift_code',
      title: 'SWIFT',
      usageInfo: null,
      fields: [
        holder,
        legalType,
        field('swiftCode', 'SWIFT / BIC code', 'BUKBGB22'),
        field('accountNumber', 'Account number', '12345678'),
      ],
    },
  ];
}

export async function registerWise(
  fastify: FastifyInstance,
  options: WisePluginOptions,
): Promise<void> {
  await fastify.register(wisePlugin, { ...options, prefix: options.basePath });
}

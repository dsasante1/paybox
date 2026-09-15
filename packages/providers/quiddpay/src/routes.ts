import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PayboxError,
  type Clock,
  type IdFactory,
  type Payment,
  type Transfer,
} from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import { resolveInstrument, type PaymentSimulator } from '@paybox/simulator';
import { assertQuiddpayCredentials } from './auth.js';
import { fail, toQuiddpayError } from './errors.js';
import { renderQuiddpayCheckout, renderQuiddpayResult } from './checkout.js';
import { renderPdf } from './pdf.js';
import {
  BRANCH_PAYMENT_METHODS,
  CASH_INSTRUMENTS,
  CASH_SLIP_TTL_MS,
  GHANA_BANKS,
  MOMO_NETWORKS,
  QUIDDPAY_CURRENCY,
  QUIDDPAY_RAILS,
  QUOTE_TTL_MS,
  SESSION_TTL_MS,
  assertCurrency,
  bankName,
  isKnownBank,
  networkForOperator,
  normalisePhone,
  payoutFee,
  phoneLast4,
  type QuiddpayRail,
} from './rails.js';
import { quiddpayState, type StoredAttempt, type StoredRecipient } from './state.js';
import {
  ENVIRONMENT,
  MERCHANT_NAME,
  describeRecipient,
  serializeAttemptInitiation,
  serializeAttemptStatus,
  serializeCashSlip,
  serializeCheckoutQuote,
  serializePayout,
  serializePayoutQuote,
  serializePublicSession,
  serializeReceipt,
  serializeRecipient,
  serializeSession,
} from './serializers.js';
import { isFinalized, toQuiddpaySessionStatus } from './status.js';
import { TEST_ATTEMPT_KEY, TEST_OUTCOME_KEY, TEST_RAIL_KEY } from './webhook.js';
import {
  authorizeAttemptSchema,
  cancelPayoutSchema,
  cashSlipSchema,
  checkoutPaySchema,
  createPayoutSchema,
  createSessionSchema,
  invoiceLinesSchema,
  listQuerySchema,
  payoutQuoteSchema,
  receiptEmailSchema,
  recipientRequestSchema,
  revenueLinesSchema,
  simulateSchema,
  startAttemptSchema,
  verifyMomoSchema,
} from './schemas.js';

export interface QuiddpayPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  baseUrl: string;
  basePath: string;
  allowAnyKey?: boolean;
}

const PROVIDER = 'quiddpay' as const;
/** Quid's API lives under this prefix, which is part of its published URLs. */
const API = '/api/v1';

/**
 * Quid Payments-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a Quid request can never be answered in another provider's envelope. Every
 * route translates a request into engine calls and translates the result back;
 * no payment behaviour lives here (spec §30).
 *
 * Shapes verified against Quid's published OpenAPI document
 * (`docs.quiddpayments.com/openapi.json`, contract `2026-06`), the merchant
 * guide (`/merchant-api.md`) and the webhook, testing and payout pages, all
 * read **2026-09-15**. Coverage is documented honestly in docs/quiddpay.md.
 *
 * The surface splits three ways, which is unusual among these adapters and is
 * the shape of Quid's own product:
 *
 *   merchant   `/sessions`, `/invoice-lines`, `/revenue-lines`, `/payouts`.
 *              Bearer-authenticated with the integration API key.
 *   public     `/checkout/**`. Called by hosted checkout from a payer's
 *              browser, which holds no API key — so these are unauthenticated,
 *              addressed by an unguessable session reference, and answer with
 *              a narrower view of the session than the merchant endpoints do.
 *   test       `/test/payment-attempts/{ref}/simulate`. Quid's own, not an
 *              emulator invention.
 */
export const quiddpayPlugin: FastifyPluginAsync<QuiddpayPluginOptions> = async (
  fastify,
  options,
) => {
  const { engine, simulator, storage, clock, ids } = options;
  const state = quiddpayState(storage, () => clock.nowISO());

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toQuiddpayError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ detail: `Unknown endpoint (${request.method} ${request.url}).` }),
  );

  const authenticate = (request: FastifyRequest): string =>
    assertQuiddpayCredentials(request.headers.authorization, {
      allowAnyKey: options.allowAnyKey ?? false,
    });

  /** A stable label for the key that created a session. Never the key itself. */
  const apiKeyLabel = 'Integration test key';

  /* ------------------------------ lookups ------------------------------ */

  const checkoutUrl = (payment: Payment): string =>
    `${options.baseUrl}${options.basePath}/checkout/${encodeURIComponent(payment.reference)}`;

  async function loadSession(handle: string): Promise<Payment> {
    const payment = await engine.resolvePayment(PROVIDER, handle);
    if (!payment || payment.provider !== PROVIDER) {
      throw new PayboxError('not_found', `No checkout session found for "${handle}".`);
    }
    return payment;
  }

  async function loadAttempt(reference: string): Promise<StoredAttempt> {
    const attempt = await state.attempts.get(reference);
    if (!attempt) {
      throw new PayboxError('not_found', `No payment attempt found for "${reference}".`);
    }
    return attempt;
  }

  async function loadRecipient(id: string): Promise<StoredRecipient> {
    const recipient = await state.recipients.get(id);
    if (!recipient) {
      throw new PayboxError('not_found', `No payout recipient found for "${id}".`);
    }
    return recipient;
  }

  /**
   * Every payout this provider has made.
   *
   * `transfers.list` has no provider filter, so the rows are narrowed here.
   * The cap is generous rather than paged because a local emulator's payout
   * table is small and a missing row would be a silently wrong list.
   */
  async function listPayouts(): Promise<Transfer[]> {
    const { items } = await storage.transfers.list({ limit: 1000 });
    return items.filter((transfer) => transfer.provider === PROVIDER);
  }

  async function loadPayout(id: string): Promise<Transfer> {
    const items = await listPayouts();
    const transfer = items.find((row) => row.providerTransferId === id || row.id === id);
    if (!transfer) throw new PayboxError('not_found', `No payout found for "${id}".`);
    return transfer;
  }

  async function customerFor(payment: Payment) {
    return payment.customerId ? storage.customers.byId(payment.customerId) : null;
  }

  /**
   * The rail that actually paid a session, if one did.
   *
   * Read back from the attempts rather than stored on the payment: a session
   * can carry several attempts and only the settled one is the answer.
   */
  async function paidRail(payment: Payment): Promise<string | null> {
    if (toQuiddpaySessionStatus(payment.status) !== 'success') return null;
    const attempts = await state.attempts.forSession(payment.id);
    return attempts.at(-1)?.rail ?? null;
  }

  /** Quid's guide calls a session that is finalised, or past its expiry, unpayable. */
  function assertPayable(payment: Payment): void {
    if (isFinalized(payment.status)) {
      throw fail(
        'invalid_state_transition',
        'SESSION_NOT_PAYABLE',
        `Checkout session is not open for payment; it is ${toQuiddpaySessionStatus(
          payment.status,
        )}.`,
      );
    }
  }

  /* --------------------------- checkout sessions --------------------------- */

  fastify.post(`${API}/sessions`, async (request, reply) => {
    authenticate(request);
    const body = createSessionSchema.parse(request.body);
    const currency = assertCurrency(body.currency);

    // Quid's session id. `cs_` matches the worked example in its guide
    // (`cs_example`), and it doubles as paybox's reference so a session is
    // addressable by the one handle a merchant actually holds.
    const sessionId = `cs_${ids.token(24)}`;

    const customer = body.customer.email
      ? await upsertCustomer(body.customer.email, body.customer.name)
      : null;

    const payment = await engine.createPayment({
      provider: PROVIDER,
      amount: body.amount_minor,
      currency,
      reference: sessionId,
      providerTransactionId: sessionId,
      customerId: customer?.id ?? null,
      callbackUrl: body.callback_url ?? null,
      metadata: {
        ...(body.metadata ?? {}),
        invoice_ref: body.invoice_ref,
        ...(body.description ? { description: body.description } : {}),
        customer_name: body.customer.name,
        ...(body.customer.reference ? { customer_reference: body.customer.reference } : {}),
        ...(body.customer.phone ? { customer_phone: body.customer.phone } : {}),
      },
      // `open` at Quid: payable, and nobody has tried yet.
      status: 'pending',
      expiresInMs: body.expires_in_seconds ? body.expires_in_seconds * 1000 : SESSION_TTL_MS,
    });

    return reply
      .status(201)
      .send(serializeSession(payment, { checkoutUrl: checkoutUrl(payment), apiKeyLabel }));
  });

  fastify.get<{ Params: { reference: string } }>(
    `${API}/sessions/:reference`,
    async (request, reply) => {
      authenticate(request);
      const payment = await loadSession(request.params.reference);
      return reply.send(
        serializeSession(payment, { checkoutUrl: checkoutUrl(payment), apiKeyLabel }),
      );
    },
  );

  async function upsertCustomer(email: string, name: string) {
    const existing = await storage.customers.byEmail(PROVIDER, email);
    if (existing) return existing;
    const [firstName, ...rest] = name.split(' ');
    return engine.createCustomer({
      provider: PROVIDER,
      email,
      firstName: firstName || null,
      lastName: rest.join(' ') || null,
      phone: null,
    });
  }

  /* ------------------------------ service codes ------------------------------ */

  /**
   * Invoice lines.
   *
   * A merchant records what an invoice is made of before collecting it, so
   * Quid can attribute the money to service codes afterwards. Nothing about
   * this is a payment, which is why it lives in the provider key/value store
   * rather than becoming an engine resource.
   *
   * Quid's response reports `ingested`, `billed_minor` and an `errors` array,
   * and the guide's worked example shows two lines summing to the session
   * amount. Re-ingesting an invoice replaces its lines: the same
   * `Idempotency-Key` with the same body replays, and a *different* body under
   * the same key is a 409 from the shared idempotency hook.
   */
  fastify.post(`${API}/invoice-lines`, async (request, reply) => {
    authenticate(request);
    const body = invoiceLinesSchema.parse(request.body);
    const currency = assertCurrency(body.currency);

    const lines = body.lines.map((line) => ({
      code: line.code,
      name: line.name ?? line.code,
      amountMinor: line.amount_minor,
      currency,
      remitted: false,
    }));

    await state.invoices.put({
      invoiceRef: body.invoice_ref,
      currency,
      lines,
      updatedAt: clock.nowISO(),
    });

    return reply.send({
      object: 'invoice.line_items',
      invoice_ref: body.invoice_ref,
      ingested: lines.length,
      billed_minor: lines.reduce((total, line) => total + line.amountMinor, 0),
      errors: [],
    });
  });

  fastify.get<{ Querystring: { invoice_ref?: string } }>(
    `${API}/invoice-lines`,
    async (request, reply) => {
      authenticate(request);
      const invoiceRef = request.query.invoice_ref;
      if (!invoiceRef) {
        throw fail('validation_failed', 'INVALID_ARGUMENT', 'invoice_ref is required.');
      }
      const invoice = await state.invoices.get(invoiceRef);
      const lines = invoice?.lines ?? [];
      return reply.send({
        object: 'invoice.line_items',
        invoice_ref: invoiceRef,
        lines: lines.map((line) => ({
          code: line.code,
          name: line.name,
          amount_minor: line.amountMinor,
          currency: line.currency,
          remitted: line.remitted,
        })),
        total_minor: lines.reduce((total, line) => total + line.amountMinor, 0),
      });
    },
  );

  /**
   * Revenue lines — the merchant's service-code catalogue.
   *
   * A bulk sync rather than a create: Quid reports how many codes it created,
   * updated, reactivated, deactivated and left alone, which is the shape an
   * ERP export needs. `deactivate_missing` turns the call into a full
   * replacement.
   */
  fastify.post(`${API}/revenue-lines`, async (request, reply) => {
    authenticate(request);
    const body = revenueLinesSchema.parse(request.body);
    const now = clock.nowISO();

    let created = 0;
    let updated = 0;
    let reactivated = 0;
    let unchanged = 0;

    const seen = new Set<string>();
    for (const line of body.lines) {
      seen.add(line.code);
      const existing = await state.serviceCodes.get(line.code);
      if (!existing) {
        created += 1;
        await state.serviceCodes.put({
          id: `sc_${ids.token(20)}`,
          code: line.code,
          name: line.name,
          active: true,
          source: 'sync',
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }
      if (!existing.active) {
        reactivated += 1;
        await state.serviceCodes.put({ ...existing, name: line.name, active: true, updatedAt: now });
      } else if (existing.name !== line.name) {
        updated += 1;
        await state.serviceCodes.put({ ...existing, name: line.name, updatedAt: now });
      } else {
        unchanged += 1;
      }
    }

    let deactivated = 0;
    if (body.deactivate_missing) {
      for (const row of await state.serviceCodes.all()) {
        if (seen.has(row.code) || !row.active) continue;
        deactivated += 1;
        await state.serviceCodes.put({ ...row, active: false, updatedAt: now });
      }
    }

    return reply.send({
      object: 'merchant.revenue_lines',
      created,
      updated,
      reactivated,
      deactivated,
      unchanged,
      total: body.lines.length,
      errors: [],
    });
  });

  fastify.get(`${API}/revenue-lines`, async (request, reply) => {
    authenticate(request);
    const rows = await state.serviceCodes.all();
    return reply.send({
      object: 'merchant.revenue_lines',
      lines: rows.map((row) => ({
        id: row.id,
        merchant_id: 'merchant_paybox_test',
        code: row.code,
        name: row.name,
        active: row.active,
        source: row.source,
        last_synced_at: row.updatedAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      total: rows.length,
    });
  });

  /* ------------------------- public checkout: reads ------------------------- */

  /**
   * Everything hosted checkout needs to render its method picker.
   *
   * Unauthenticated, like the rest of `/checkout/**`: the page runs in a
   * payer's browser and holds no API key.
   */
  fastify.get(`${API}/checkout/options`, async (_request, reply) =>
    reply.send({
      payment_rails: QUIDDPAY_RAILS.map((rail) => ({ value: rail, label: railLabel(rail) })),
      cash_instruments: CASH_INSTRUMENTS.map((instrument) => ({ ...instrument })),
      branch_payment_methods: BRANCH_PAYMENT_METHODS.map((branch) => ({ ...branch })),
      banks: GHANA_BANKS.map((bank) => ({ ...bank })),
    }),
  );

  fastify.get<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const rail = await paidRail(payment);
      return reply.send(
        serializePublicSession(payment, await customerFor(payment), {
          paidRail: rail,
          receipt: rail
            ? serializeReceipt(payment, { rail, emailStatus: await emailStatus(payment) })
            : null,
        }),
      );
    },
  );

  fastify.get<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/quote`,
    async (request, reply) =>
      reply.send(serializeCheckoutQuote(await loadSession(request.params.reference))),
  );

  fastify.get<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/bank-transfer-banks`,
    async (request, reply) => {
      await loadSession(request.params.reference);
      return reply.send({
        banks: GHANA_BANKS.map((bank) => ({
          id: bank.id,
          display_name: bank.display_name,
          country: 'GH',
          currency: QUIDDPAY_CURRENCY,
          active: true,
        })),
      });
    },
  );

  fastify.get<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/receipt`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const rail = await paidRail(payment);
      if (!rail) {
        throw new PayboxError('not_found', 'No receipt: this session has not been paid.');
      }
      return reply.send(
        serializeReceipt(payment, { rail, emailStatus: await emailStatus(payment) }),
      );
    },
  );

  /**
   * Where the payer wants their receipt sent.
   *
   * Quid answers with `receipt_email_available` rather than the address —
   * confirmation that delivery is possible, not an echo of what was just sent.
   * paybox sends no mail, so the flag reports whether an address is on file.
   */
  fastify.put<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/receipt-email`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const body = receiptEmailSchema.parse(request.body);
      await state.receiptEmail.put(payment.id, body.email);
      return reply.send({ receipt_email_available: true });
    },
  );

  async function emailStatus(payment: Payment): Promise<string> {
    const stored = await state.receiptEmail.get(payment.id);
    const customer = await customerFor(payment);
    // `EmailStatusEnum`: not_available, pending, sending, sent,
    // definite_failure, uncertain. paybox never sends mail, so a receipt with
    // an address on file rests at `pending` rather than claiming `sent`.
    return stored?.email || customer?.email ? 'pending' : 'not_available';
  }

  /**
   * Mobile-money account verification.
   *
   * Quid returns the name on the wallet, masked to the last four digits of the
   * number. Nothing is resolved against a real wallet and no number here
   * belongs to anyone (spec §29) — the name comes from the session's own
   * customer, which is what makes the check look right to a payer without the
   * emulator pretending to know anything about the number.
   */
  fastify.post<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/momo-account-verification`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const body = verifyMomoSchema.parse(request.body);
      const customer = await customerFor(payment);
      const name =
        (typeof payment.metadata.customer_name === 'string' && payment.metadata.customer_name) ||
        [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') ||
        'PAYBOX TEST WALLET';
      return reply.send({
        operator: body.operator,
        phone_last4: phoneLast4(body.phone),
        account_name: name.toUpperCase(),
      });
    },
  );

  /* ------------------------ public checkout: attempts ------------------------ */

  /**
   * Start a payment attempt on a rail.
   *
   * This is where Quid's model differs most from every other adapter here. A
   * session is not itself a charge: it is an invitation to pay, and an
   * *attempt* is the thing on a rail. A payer can fail a mobile-money prompt
   * and then pay by bank transfer against the same session, so attempts are
   * plural and the session outlives them.
   *
   * Repeating the same rail while an attempt is in flight returns that attempt
   * with `replayed: true` — Quid publishes the flag, and it is what stops a
   * double-tapped Pay button minting a second prompt. Switching rails while
   * one is live is `PAYMENT_ATTEMPT_PENDING`.
   */
  fastify.post<{ Params: { reference: string } }>(
    `${API}/checkout/sessions/:reference/provider-attempts`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const body = startAttemptSchema.parse(request.body);
      assertPayable(payment);

      if (body.amount_minor !== undefined && body.amount_minor !== payment.amount) {
        throw fail(
          'validation_failed',
          'PAYMENT_AMOUNT_MISMATCH',
          `This session is for ${payment.amount} ${payment.currency}, not ${body.amount_minor}.`,
        );
      }

      const live = (await state.attempts.forSession(payment.id)).find(
        (attempt) => attempt.status === 'pending',
      );
      if (live) {
        if (live.rail === body.rail) {
          return reply.send(serializeAttemptInitiation(live, { replayed: true }));
        }
        throw fail(
          'invalid_state_transition',
          'PAYMENT_ATTEMPT_PENDING',
          `A ${live.rail} attempt is already in flight on this session.`,
        );
      }

      const attempt = await startAttempt(payment, body);
      return reply.status(201).send(serializeAttemptInitiation(attempt, { replayed: false }));
    },
  );

  /**
   * Begin an attempt on one rail.
   *
   * Shared by the API route above and the hosted page below, so the page a
   * payer sees drives exactly the endpoints the real hosted checkout calls
   * rather than a second implementation that could drift from it.
   */
  async function startAttempt(
    payment: Payment,
    body: {
      rail: QuiddpayRail;
      phone?: string | undefined;
      operator?: string | undefined;
      account_name?: string | undefined;
      sender?: { bank_id: string; account_name: string; account_number: string } | undefined;
    },
  ): Promise<StoredAttempt> {
    const reference = `pa_${ids.token(24)}`;
    const providerReference = `TEST-${ids.token(12).toUpperCase()}`;
    const now = clock.nowISO();

    let instructions: Record<string, unknown>;
    let rawStatus: string;

    if (body.rail === 'momo') {
      if (!body.phone || !body.operator) {
        throw fail(
          'validation_failed',
          'INVALID_ARGUMENT',
          'A mobile-money attempt needs both `phone` and `operator`.',
        );
      }
      // The prompt is on the payer's handset now, so the session is `pending`
      // at Quid and `requires_action` canonically: a real step-up, not a
      // status the emulator invented to have something to show.
      await engine.transitionPayment(payment.id, 'requires_action', {
        paymentMethod: 'mobile_money',
        paymentMethodDetails: {
          phone_number: body.phone,
          operator: body.operator,
          network: networkForOperator(body.operator),
        },
      });
      rawStatus = 'PROMPT_SENT';
      instructions = {
        type: 'momo_prompt',
        operator: body.operator,
        network: networkForOperator(body.operator),
        phone: normalisePhone(body.phone),
        message: 'Approve the prompt on your handset, then enter your wallet PIN.',
      };
    } else if (body.rail === 'bank_transfer') {
      if (body.sender && !isKnownBank(body.sender.bank_id)) {
        throw fail(
          'validation_failed',
          'INVALID_ARGUMENT',
          `Unknown bank "${body.sender.bank_id}". See GET ${API}/checkout/options.`,
        );
      }
      await engine.transitionPayment(payment.id, 'processing', {
        paymentMethod: 'bank_transfer',
        paymentMethodDetails: {
          ...(body.sender
            ? {
                sender_bank_id: body.sender.bank_id,
                sender_bank_name: bankName(body.sender.bank_id),
                sender_account_name: body.sender.account_name,
                sender_account_number: body.sender.account_number,
              }
            : {}),
        },
      });
      rawStatus = 'AWAITING_TRANSFER';
      instructions = {
        type: 'bank_transfer',
        transfer_method: 'ghipss',
        bank_name: 'PAYBOX TEST BANK',
        // Synthetic: belongs to no bank, and nothing can be paid into it.
        account_number: syntheticAccountNumber(),
        account_name: MERCHANT_NAME.toUpperCase(),
        narration: providerReference,
        message: 'Transfer the exact amount, then declare the payment to finish.',
      };
    } else {
      await engine.transitionPayment(payment.id, 'processing', {
        paymentMethod: 'cash',
        paymentMethodDetails: { instrument: 'cash' },
      });
      const slip = await mintCashSlip(payment, payment.amount);
      rawStatus = 'SLIP_ISSUED';
      instructions = {
        type: 'cash_slip',
        slip_token: slip.token,
        reference: slip.reference,
        expires_at: slip.expiresAt,
        branches: BRANCH_PAYMENT_METHODS.map((branch) => ({ ...branch })),
        message: 'Take this slip to a branch. The session stays pending until a teller confirms.',
      };
    }

    const attempt: StoredAttempt = {
      reference,
      paymentId: payment.id,
      sessionReference: payment.providerTransactionId,
      rail: body.rail,
      providerReference,
      amountMinor: payment.amount,
      currency: payment.currency,
      status: 'pending',
      rawStatus,
      instructions,
      createdAt: now,
      declaredAt: null,
      outcome: null,
      synthetic: true,
    };
    await state.attempts.put(attempt);
    return attempt;
  }

  fastify.get<{ Params: { reference: string; attemptReference: string } }>(
    `${API}/checkout/sessions/:reference/provider-attempts/:attemptReference`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const attempt = await loadAttempt(request.params.attemptReference);
      // `refreshed` reports whether Quid re-read the rail rather than answering
      // from its own record. paybox has no rail to re-read, and says so.
      return reply.send(serializeAttemptStatus(attempt, payment, { refreshed: false }));
    },
  );

  /**
   * The wallet PIN.
   *
   * The outcome is decided by the **mobile number**, not the PIN: the PIN
   * proves the payer is present, and the wallet decides whether the money
   * moves. That split is why a wrong PIN here does not decline a charge — the
   * same reasoning as the OTP on a card, and the last-four convention on the
   * phone number is what selects the answer.
   */
  fastify.post<{ Params: { reference: string; attemptReference: string } }>(
    `${API}/checkout/sessions/:reference/provider-attempts/:attemptReference/authorize`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const attempt = await loadAttempt(request.params.attemptReference);
      authorizeAttemptSchema.parse(request.body ?? {});

      if (attempt.rail !== 'momo') {
        throw fail(
          'validation_failed',
          'PROVIDER_RAIL_UNSUPPORTED',
          `Only a mobile-money attempt is authorized with a code; this one is ${attempt.rail}.`,
        );
      }
      if (payment.status !== 'requires_action') {
        throw fail(
          'invalid_state_transition',
          'SESSION_NOT_PAYABLE',
          `This attempt is not awaiting authorization; the session is ${toQuiddpaySessionStatus(
            payment.status,
          )}.`,
        );
      }

      const settled = await settleByInstrument(payment, attempt);
      return reply.send(serializeAttemptStatus(settled.attempt, settled.payment, { refreshed: true }));
    },
  );

  /** Re-send the prompt. Quid re-triggers it; nothing about the attempt changes. */
  fastify.post<{ Params: { reference: string; attemptReference: string } }>(
    `${API}/checkout/sessions/:reference/provider-attempts/:attemptReference/resend`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const attempt = await loadAttempt(request.params.attemptReference);
      if (attempt.rail !== 'momo') {
        throw fail(
          'validation_failed',
          'PROVIDER_RAIL_UNSUPPORTED',
          `Only a mobile-money prompt can be re-sent; this attempt is ${attempt.rail}.`,
        );
      }
      assertPayable(payment);
      return reply.send(serializeAttemptStatus(attempt, payment, { refreshed: true }));
    },
  );

  /**
   * "I have sent the transfer."
   *
   * A declaration is the payer's claim, not a confirmation: Quid records when
   * it was made and the session stays pending until the money is actually
   * seen. Reproduced exactly — a merchant that fulfils on a declaration has a
   * bug, and this is where they should find it.
   */
  fastify.post<{ Params: { reference: string; attemptReference: string } }>(
    `${API}/checkout/sessions/:reference/provider-attempts/:attemptReference/payment-declarations`,
    async (request, reply) => {
      const payment = await loadSession(request.params.reference);
      const attempt = await loadAttempt(request.params.attemptReference);
      if (attempt.rail !== 'bank_transfer') {
        throw fail(
          'validation_failed',
          'PROVIDER_RAIL_UNSUPPORTED',
          `Only a bank-transfer attempt can be declared; this one is ${attempt.rail}.`,
        );
      }
      assertPayable(payment);

      const declared: StoredAttempt = { ...attempt, declaredAt: clock.nowISO() };
      await state.attempts.put(declared);
      return reply.send(serializeAttemptStatus(declared, payment, { refreshed: false }));
    },
  );

  /* ------------------------------ cash slips ------------------------------ */

  fastify.post(`${API}/checkout/cash-slips`, async (request, reply) => {
    const body = cashSlipSchema.parse(request.body);
    const payment = await loadSession(body.session_id);
    assertPayable(payment);

    if (body.amount_minor !== payment.amount) {
      throw fail(
        'validation_failed',
        'PAYMENT_AMOUNT_MISMATCH',
        `This session is for ${payment.amount} ${payment.currency}, not ${body.amount_minor}.`,
      );
    }

    // A session has one slip: re-requesting returns the same token with
    // `replayed: true` rather than issuing a second one a teller could also
    // take, which would collect the invoice twice.
    const existing = (await state.cashSlips.all()).find((slip) => slip.paymentId === payment.id);
    const slip = existing ?? (await mintCashSlip(payment, body.amount_minor));
    return reply
      .status(existing ? 200 : 201)
      .send(
        serializeCashSlip(slip, payment, await customerFor(payment), { replayed: Boolean(existing) }),
      );
  });

  async function mintCashSlip(payment: Payment, amountMinor: number) {
    const slip = {
      token: `slip_${ids.token(20)}`,
      reference: `CASH-${ids.token(8).toUpperCase()}`,
      paymentId: payment.id,
      amountMinor,
      currency: payment.currency,
      expiresAt: new Date(clock.now() + CASH_SLIP_TTL_MS).toISOString(),
      createdAt: clock.nowISO(),
    };
    await state.cashSlips.put(slip);
    return slip;
  }

  /* ------------------------------- test mode ------------------------------- */

  /**
   * Quid's own outcome simulator, not an emulator invention.
   *
   * `POST /api/v1/test/payment-attempts/{reference}/simulate` is published,
   * because a bank transfer or a cash deposit has no other way to be settled
   * in test mode — there is no teller to confirm it. It is the same idea as
   * `paybox simulate`, so an existing Quid test script drives the emulator
   * unchanged.
   *
   * Five of the eight outcomes finalise the session. Three — `pending`,
   * `manual_review` and `amount_mismatch` — deliberately do not: none of them
   * is a decision, and Quid's own guide has the order stay pending while
   * `finalized` is false. They move the attempt and leave the session payable,
   * which is why no `checkout.session.*` webhook follows them.
   */
  fastify.post<{ Params: { reference: string } }>(
    `${API}/test/payment-attempts/:reference/simulate`,
    async (request, reply) => {
      authenticate(request);
      const attempt = await loadAttempt(request.params.reference);
      const body = simulateSchema.parse(request.body);
      const payment = await loadSession(attempt.paymentId);

      if (isFinalized(payment.status)) {
        throw fail(
          'invalid_state_transition',
          'SESSION_NOT_PAYABLE',
          `This session is already ${toQuiddpaySessionStatus(payment.status)}.`,
        );
      }

      const settled = await applyTestOutcome(payment, attempt, body.outcome);
      return reply.send({
        attempt_reference: settled.attempt.reference,
        rail: settled.attempt.rail,
        status: settled.attempt.status,
        outcome: body.outcome,
        session_id: settled.payment.providerTransactionId,
        session_status: toQuiddpaySessionStatus(settled.payment.status),
        environment: ENVIRONMENT,
        livemode: false,
      });
    },
  );

  /**
   * Record which outcome the test simulator chose, then apply it.
   *
   * The marker on the payment's metadata is what makes the formatter emit the
   * matching `test.payment.*` event beside the checkout one; it is written
   * *before* the transition so it is already on the row the formatter reads
   * after commit.
   */
  async function applyTestOutcome(
    payment: Payment,
    attempt: StoredAttempt,
    outcome: string,
  ): Promise<{ payment: Payment; attempt: StoredAttempt }> {
    await storage.payments.update(payment.id, {
      metadata: {
        ...payment.metadata,
        [TEST_OUTCOME_KEY]: outcome,
        [TEST_ATTEMPT_KEY]: attempt.reference,
        [TEST_RAIL_KEY]: attempt.rail,
      },
      updatedAt: clock.nowISO(),
    });

    let settled = (await storage.payments.byId(payment.id)) ?? payment;
    let status = attempt.status;
    let rawStatus = attempt.rawStatus;

    switch (outcome) {
      case 'paid':
        settled = await simulator.apply(settled.id, 'success');
        status = 'paid';
        rawStatus = 'SUCCESS';
        break;
      case 'failed':
        settled = await simulator.apply(settled.id, 'declined');
        status = 'failed';
        rawStatus = 'REJECTED';
        break;
      case 'expired':
        settled = await simulator.expire(settled.id);
        status = 'expired';
        rawStatus = 'EXPIRED';
        break;
      case 'cancelled':
        settled = await simulator.apply(settled.id, 'customer_rejected');
        status = 'cancelled';
        rawStatus = 'CANCELLED';
        break;
      case 'reversed':
        // Quid publishes no session status for a reversal — `CheckoutSessionStatusEnum`
        // has five members and none of them is one. The money did not stay, so
        // the session settles `failed` and the attempt carries the word that
        // explains why. docs/quiddpay.md states this plainly.
        settled = await simulator.apply(settled.id, 'declined');
        status = 'reversed';
        rawStatus = 'REVERSED';
        break;
      case 'manual_review':
        status = 'manual_review';
        rawStatus = 'UNDER_REVIEW';
        break;
      case 'amount_mismatch':
        status = 'amount_mismatch';
        rawStatus = 'AMOUNT_MISMATCH';
        break;
      default:
        // `pending`: leave the attempt exactly where it is.
        break;
    }

    const updated: StoredAttempt = { ...attempt, status, rawStatus, outcome };
    await state.attempts.put(updated);
    return { payment: settled, attempt: updated };
  }

  /** Settle a mobile-money attempt from the number the payer gave. */
  async function settleByInstrument(
    payment: Payment,
    attempt: StoredAttempt,
  ): Promise<{ payment: Payment; attempt: StoredAttempt }> {
    const phone = payment.paymentMethodDetails.phone_number;
    const { outcome } = resolveInstrument(
      typeof phone === 'string' ? phone : null,
      payment.paymentMethod,
    );
    // A step-up has already happened — the payer entered their PIN — so
    // `authentication_required` has nothing left to ask for and settles.
    const settled = await simulator.apply(
      payment.id,
      outcome === 'authentication_required' ? 'success' : outcome,
    );

    const status = toQuiddpaySessionStatus(settled.status);
    const updated: StoredAttempt = {
      ...attempt,
      status: status === 'success' ? 'paid' : status === 'expired' ? 'expired' : 'failed',
      rawStatus: status === 'success' ? 'SUCCESS' : 'REJECTED',
    };
    await state.attempts.put(updated);
    return { payment: settled, attempt: updated };
  }

  /* -------------------------------- payouts -------------------------------- */

  fastify.get(`${API}/payouts/capabilities`, async (request, reply) => {
    authenticate(request);
    return reply.send({
      enabled: true,
      account_types: ['bank', 'momo'],
      banks: GHANA_BANKS.map((bank) => ({ id: bank.id, display_name: bank.display_name })),
      mobile_money_networks: MOMO_NETWORKS.map((network) => ({ ...network })),
      channels: [
        {
          id: 'ch_bank_ghs',
          name: 'Bank transfer (GHIPSS)',
          account_type: 'bank',
          environment: ENVIRONMENT,
          currency: QUIDDPAY_CURRENCY,
          fee_minor: payoutFee('bank'),
          max_amount_minor: 1_000_000_000_000,
          enabled: true,
          processing_expectation: 'Test payouts settle immediately on creation',
        },
        {
          id: 'ch_momo_ghs',
          name: 'Mobile money',
          account_type: 'momo',
          environment: ENVIRONMENT,
          currency: QUIDDPAY_CURRENCY,
          fee_minor: payoutFee('momo'),
          max_amount_minor: 1_000_000_000_000,
          enabled: true,
          processing_expectation: 'Test payouts settle immediately on creation',
        },
      ],
    });
  });

  /**
   * The payout balance, folded from the ledger.
   *
   * Quid reports three figures and paybox derives all three rather than
   * storing any: `available_minor` is the ledger fold, `held_minor` is what
   * queued payouts have already reserved, and `eligible_minor` is the sum.
   * A stored running balance would be order-sensitive under a frozen clock,
   * which is the same reasoning behind the ledger itself.
   */
  fastify.get(`${API}/payouts/balance`, async (request, reply) => {
    authenticate(request);
    const available = await engine.getBalance(PROVIDER, QUIDDPAY_CURRENCY);
    const held = (await listPayouts())
      .filter((transfer) => transfer.status === 'pending' || transfer.status === 'processing')
      .reduce((total, transfer) => {
        const fee = typeof transfer.metadata.fee_minor === 'number' ? transfer.metadata.fee_minor : 0;
        return total + transfer.amount + fee;
      }, 0);

    return reply.send({
      environment: ENVIRONMENT,
      currency: QUIDDPAY_CURRENCY,
      eligible_minor: available + held,
      held_minor: held,
      available_minor: available,
    });
  });

  /**
   * Save a payout recipient.
   *
   * Created `pending_verification` with a 201, exactly as Quid documents, and
   * deliberately **not** idempotent: its guide says so, and tells an
   * integration to list recipients after an uncertain response rather than
   * retrying. Reproducing that is more useful than quietly deduplicating and
   * hiding the race a real integration has to handle.
   */
  fastify.post(`${API}/payouts/recipients`, async (request, reply) => {
    authenticate(request);
    const body = recipientRequestSchema.parse(request.body);

    if (body.account_type === 'bank' && !isKnownBank(body.bank_id)) {
      throw fail(
        'validation_failed',
        'INVALID_ARGUMENT',
        `Unknown bank "${body.bank_id}". See GET ${API}/payouts/capabilities.`,
      );
    }

    const described = describeRecipient({
      accountType: body.account_type,
      ...(body.account_type === 'bank' ? { bankId: body.bank_id } : { network: body.network }),
    });

    const recipient: StoredRecipient = {
      id: `rcp_${ids.token(24)}`,
      accountType: body.account_type,
      accountName: body.account_name,
      accountNumber: body.account_type === 'bank' ? body.account_number : '',
      bankId: body.account_type === 'bank' ? body.bank_id : '',
      bankName: described.bankName,
      phone: body.account_type === 'momo' ? normalisePhone(body.phone) : '',
      network: body.account_type === 'momo' ? body.network : '',
      networkName: described.networkName,
      environment: ENVIRONMENT,
      verified: false,
      verificationStatus: 'pending_verification',
      status: 'pending_verification',
      version: 1,
      rejectionReason: '',
      channelId: body.account_type === 'momo' ? 'ch_momo_ghs' : 'ch_bank_ghs',
      customerId: body.customer_id ?? '',
      createdAt: clock.nowISO(),
    };

    await state.recipients.put(recipient);
    return reply.status(201).send(serializeRecipient(recipient));
  });

  fastify.get(`${API}/payouts/recipients`, async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query ?? {});
    const all = (await state.recipients.all()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    return reply.send({
      recipients: all.slice((page - 1) * limit, page * limit).map(serializeRecipient),
      page,
      limit,
      total: all.length,
    });
  });

  fastify.get<{ Params: { recipientId: string } }>(
    `${API}/payouts/recipients/:recipientId`,
    async (request, reply) => {
      authenticate(request);
      return reply.send(serializeRecipient(await loadRecipient(request.params.recipientId)));
    },
  );

  fastify.delete<{ Params: { recipientId: string } }>(
    `${API}/payouts/recipients/:recipientId`,
    async (request, reply) => {
      authenticate(request);
      await loadRecipient(request.params.recipientId);
      await state.recipients.delete(request.params.recipientId);
      return reply.status(204).send();
    },
  );

  /**
   * Ask for a recipient to be verified.
   *
   * Quid's guide is explicit that no verification request is required before
   * submitting a payout, so this exists for an integration that calls it
   * anyway. In test mode it resolves immediately rather than leaving a
   * recipient that never becomes verified.
   */
  fastify.post<{ Params: { recipientId: string } }>(
    `${API}/payouts/recipients/:recipientId/verify`,
    async (request, reply) => {
      authenticate(request);
      const recipient = await loadRecipient(request.params.recipientId);
      const verified: StoredRecipient = {
        ...recipient,
        verified: true,
        verificationStatus: 'verified',
        status: 'active',
        rejectionReason: '',
      };
      await state.recipients.put(verified);
      return reply.send(serializeRecipient(verified));
    },
  );

  /** A fee preview. Reserves nothing and locks no pricing — Quid says both. */
  fastify.post(`${API}/payouts/quote`, async (request, reply) => {
    authenticate(request);
    const body = payoutQuoteSchema.parse(request.body);
    const recipient = await loadRecipient(body.recipient_id);

    const quote = {
      id: `qt_${ids.token(20)}`,
      recipientId: recipient.id,
      amountMinor: body.amount_minor,
      feeMinor: payoutFee(recipient.accountType),
      currency: QUIDDPAY_CURRENCY,
      expiresAt: new Date(clock.now() + QUOTE_TTL_MS).toISOString(),
    };
    await state.quotes.put(quote);
    return reply.send(serializePayoutQuote(quote));
  });

  /**
   * Create a payout.
   *
   * Idempotent on `client_reference`, which is unique per merchant and
   * environment: an unchanged repeat returns the original payout with a 200,
   * and a *changed* request under the same reference is a 409
   * `REFERENCE_CONFLICT`. That is Quid's documented behaviour and the reason
   * its guide says not to send an `Idempotency-Key` here — the body carries
   * its own key.
   *
   * A Test payout settles immediately: "Valid Test payouts return paid
   * immediately, without recipient verification or approval", with a `TEST-`
   * transaction reference and `reconciliation_status=not_required`. So the
   * transfer is created and settled in one call, which queues `payout.requested`
   * and `payout.paid` for asynchronous delivery.
   */
  fastify.post(`${API}/payouts`, async (request, reply) => {
    authenticate(request);
    const body = createPayoutSchema.parse(request.body);
    assertCurrency(body.currency);
    const recipient = await loadRecipient(body.recipient_id);

    const existing = (await listPayouts()).find(
      (transfer) => transfer.metadata.client_reference === body.client_reference,
    );
    if (existing) {
      // An unchanged retry replays; a changed one is a conflict. Comparing the
      // fields that define the payout rather than the whole body, because
      // `notes` is cosmetic and Quid's own wording is "the unchanged request".
      const sameRequest =
        existing.amount === body.amount_minor &&
        existing.metadata.recipient_id === body.recipient_id;
      if (!sameRequest) {
        throw fail(
          'duplicate_reference',
          'REFERENCE_CONFLICT',
          `client_reference "${body.client_reference}" was already used for a different payout.`,
        );
      }
      // "Retrying an unchanged accepted payout returns its original amount and
      // fee even after pricing changes" — so the stored payout is returned as
      // it stands rather than re-priced.
      return reply.send(serializePayout(existing, recipient));
    }

    const feeMinor = payoutFee(recipient.accountType);
    if (body.max_fee_minor !== undefined && feeMinor > body.max_fee_minor) {
      // No payout and no hold: Quid is explicit that a capped request which
      // exceeds the cap creates neither.
      throw fail(
        'validation_failed',
        'FEE_LIMIT_EXCEEDED',
        `The current fee of ${feeMinor} exceeds max_fee_minor of ${body.max_fee_minor}.`,
      );
    }

    const payoutId = `po_${ids.token(24)}`;
    const transfer = await engine.createTransfer({
      provider: PROVIDER,
      amount: body.amount_minor,
      currency: QUIDDPAY_CURRENCY,
      reference: body.client_reference,
      recipientName: recipient.accountName,
      recipientAccount:
        recipient.accountType === 'bank' ? recipient.accountNumber : recipient.phone,
      recipientBankCode: recipient.accountType === 'bank' ? recipient.bankId : recipient.network,
      reason: body.notes ?? null,
      fee: feeMinor,
      status: 'pending',
      metadata: {
        client_reference: body.client_reference,
        recipient_id: recipient.id,
        payout_id: payoutId,
        fee_minor: feeMinor,
        bank_reference: `TEST-${ids.token(12).toUpperCase()}`,
        return_reference: '',
        account_type: recipient.accountType,
      },
    });

    const paid = await engine.transitionTransfer(transfer.id, 'successful');
    return reply.status(201).send(serializePayout(paid, recipient));
  });

  fastify.get(`${API}/payouts`, async (request, reply) => {
    authenticate(request);
    const query = listQuerySchema.parse(request.query ?? {});
    const matched = (await listPayouts())
      .filter((transfer) =>
        query.reference ? transfer.metadata.client_reference === query.reference : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const slice = matched.slice((page - 1) * limit, page * limit);

    return reply.send({
      payouts: await Promise.all(
        slice.map(async (transfer) =>
          serializePayout(
            transfer,
            await state.recipients.get(String(transfer.metadata.recipient_id ?? '')),
          ),
        ),
      ),
      page,
      limit,
      total: matched.length,
    });
  });

  fastify.get<{ Params: { payoutId: string } }>(
    `${API}/payouts/:payoutId`,
    async (request, reply) => {
      authenticate(request);
      const transfer = await loadPayout(request.params.payoutId);
      return reply.send(
        serializePayout(
          transfer,
          await state.recipients.get(String(transfer.metadata.recipient_id ?? '')),
        ),
      );
    },
  );

  /**
   * Request cancellation.
   *
   * Quid: cancellable "while `can_cancel` is true", a repeated cancellation
   * returns the cancelled payout, and "Completed Test payouts cannot be
   * cancelled". Since a Test payout is paid on creation, this path is reached
   * by a payout that was held — which is why it answers 409 rather than
   * pretending to unwind settled money.
   */
  fastify.post<{ Params: { payoutId: string } }>(
    `${API}/payouts/:payoutId/cancel`,
    async (request, reply) => {
      authenticate(request);
      cancelPayoutSchema.parse(request.body ?? {});
      const transfer = await loadPayout(request.params.payoutId);
      const recipient = await state.recipients.get(String(transfer.metadata.recipient_id ?? ''));

      if (transfer.status === 'cancelled') {
        return reply.send(serializePayout(transfer, recipient));
      }
      if (transfer.status !== 'pending' && transfer.status !== 'processing') {
        throw fail(
          'invalid_state_transition',
          'MANUAL_PAYOUT_CONFLICT',
          `This payout is ${transfer.status} and can no longer be cancelled.`,
        );
      }

      const cancelled = await engine.transitionTransfer(transfer.id, 'cancelled');
      return reply.send(serializePayout(cancelled, recipient));
    },
  );

  fastify.get<{ Params: { payoutId: string } }>(
    `${API}/payouts/:payoutId/receipt`,
    async (request, reply) => {
      authenticate(request);
      const transfer = await loadPayout(request.params.payoutId);
      if (transfer.status !== 'successful' && transfer.status !== 'reversed') {
        throw fail(
          'invalid_state_transition',
          'MANUAL_PAYOUT_CONFLICT',
          'A receipt is available once a payout is paid or returned.',
        );
      }
      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${transfer.reference}.pdf"`)
        .send(receiptPdf(transfer));
    },
  );

  fastify.get<{ Params: { payoutId: string; evidenceId: string } }>(
    `${API}/payouts/:payoutId/evidence/:evidenceId`,
    async (request, reply) => {
      authenticate(request);
      const transfer = await loadPayout(request.params.payoutId);
      if (request.params.evidenceId !== `ev_${transfer.providerTransferId}`) {
        throw new PayboxError('not_found', `No evidence "${request.params.evidenceId}".`);
      }
      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${transfer.reference}.pdf"`)
        .send(receiptPdf(transfer));
    },
  );

  function receiptPdf(transfer: Transfer): Buffer {
    const fee = typeof transfer.metadata.fee_minor === 'number' ? transfer.metadata.fee_minor : 0;
    return renderPdf('Quid Payments payout receipt (TEST)', [
      `Reference: ${transfer.reference}`,
      `Payout id: ${transfer.providerTransferId}`,
      `Recipient: ${transfer.recipientName ?? ''}`,
      `Amount: ${transfer.amount} ${transfer.currency} (minor units)`,
      `Fee: ${fee} ${transfer.currency} (minor units)`,
      `Bank reference: ${String(transfer.metadata.bank_reference ?? '')}`,
      `Created: ${transfer.createdAt}`,
      'Issued by paybox. No money moved.',
    ]);
  }

  /* --------------------------- the hosted page --------------------------- */

  /**
   * The page `checkout_url` points at (spec §45).
   *
   * Emulator-only, and it drives the very same public attempt endpoints the
   * real hosted checkout does — so what a developer watches here is the flow
   * their payer takes, not a second implementation beside it.
   */
  fastify.get<{ Params: { ref: string } }>('/checkout/:ref', async (request, reply) => {
    const payment = await loadSession(request.params.ref);
    if (isFinalized(payment.status)) {
      return reply.type('text/html').send(
        renderQuiddpayResult({
          payment,
          redirectUrl: payment.callbackUrl,
          message: `This checkout session is ${toQuiddpaySessionStatus(payment.status)}.`,
        }),
      );
    }
    return reply.type('text/html').send(
      renderQuiddpayCheckout({
        payment,
        reference: payment.reference,
        basePath: options.basePath,
      }),
    );
  });

  fastify.post<{ Params: { ref: string } }>('/checkout/:ref/pay', async (request, reply) => {
    const payment = await loadSession(request.params.ref);
    const body = checkoutPaySchema.parse(request.body ?? {});
    assertPayable(payment);

    const attempt = await startAttempt(payment, {
      rail: body.rail,
      ...(body.phone ? { phone: body.phone } : {}),
      ...(body.operator ? { operator: body.operator } : {}),
    });

    // The page collapses prompt-and-PIN into one submit, because a payer on a
    // real handset would approve immediately. The API path keeps the two steps
    // apart, which is where the pending-authorization state is exercised.
    if (attempt.rail === 'momo') {
      const current = (await storage.payments.byId(payment.id)) ?? payment;
      const settled = await settleByInstrument(current, attempt);
      return reply.type('text/html').send(
        renderQuiddpayResult({
          payment: settled.payment,
          redirectUrl: settled.payment.callbackUrl,
          message: `Mobile money ${toQuiddpaySessionStatus(settled.payment.status)}.`,
        }),
      );
    }

    const current = (await storage.payments.byId(payment.id)) ?? payment;
    return reply.type('text/html').send(
      renderQuiddpayResult({
        payment: current,
        redirectUrl: current.callbackUrl,
        message:
          attempt.rail === 'bank_transfer'
            ? 'Transfer instructions issued. The session stays pending until the money is seen.'
            : 'Cash slip issued. The session stays pending until a teller confirms the deposit.',
      }),
    );
  });

  /** A synthetic account number. Belongs to no bank; nothing can pay into it. */
  function syntheticAccountNumber(): string {
    return ids.token(10).replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  }
};

function railLabel(rail: QuiddpayRail): string {
  switch (rail) {
    case 'momo':
      return 'Mobile Money';
    case 'bank_transfer':
      return 'Bank transfer';
    default:
      return 'Cash deposit';
  }
}

/** Convenience for tests that want the plugin on a bare Fastify. */
export async function registerQuiddpay(
  fastify: FastifyInstance,
  options: QuiddpayPluginOptions,
): Promise<void> {
  await fastify.register(quiddpayPlugin, { ...options, prefix: options.basePath });
}

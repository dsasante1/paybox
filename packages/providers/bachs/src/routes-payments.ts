import type { FastifyInstance } from 'fastify';
import type { Payment, Refund } from '@paybox/shared';
import { REFUND_SETTLE_JOB } from '@paybox/simulator';
import { fail } from './errors.js';
import { newestFirst, notFound, readPage } from './http.js';
import { refundId } from './ids.js';
import { refundRecord } from './refunds.js';
import { chargeLock, withLock } from './locks.js';
import { toDecimal, toMinor } from './money.js';
import type { RouteContext } from './route-context.js';
import { createRefundSchema, listPaymentsQuery, listRefundsQuery } from './schemas.js';
import {
  amountPaidOf,
  corridorOf,
  pagination,
  serializeChargeStatus,
  serializePayment,
  serializePaymentListItem,
  serializeRefund,
} from './serializers.js';
import type { StoredRefund } from './state.js';
import { paymentStatusOf, toBachsRefundStatus } from './status.js';

const PROVIDER = 'bachs' as const;

/** Refunds settle "asynchronously"; Bachs publishes no sandbox delay, so paybox uses its payments' one second. */
const REFUND_SETTLE_DELAY_MS = 1_000;
/** "If you send the same idempotency_key twice for the same charge, the second request returns the existing refund." */
const REFUND_KEY_WINDOW_MS = 24 * 3_600_000;


export function registerPaymentRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { engine, storage, state, clock, ids, authenticate } = ctx;

  async function loadPayment(id: string): Promise<Payment> {
    const payment = await storage.payments.byProviderTransactionId(PROVIDER, id);
    if (!payment || payment.provider !== PROVIDER) throw notFound('Payment');
    return payment;
  }

  /** Every Bachs payment, newest first. Small enough locally to filter in memory. */
  async function allPayments(): Promise<Payment[]> {
    const page = await storage.payments.list({ provider: PROVIDER, limit: 10_000, offset: 0 });
    const rows = await Promise.all(
      page.items.map(async (payment) => ({
        payment,
        seq: (await state.checkouts.byPayment(payment.id))?.paymentSeq,
      })),
    );
    return rows
      .sort((a, b) =>
        newestFirst({ seq: a.seq, createdAt: a.payment.createdAt }, { seq: b.seq, createdAt: b.payment.createdAt }),
      )
      .map((row) => row.payment);
  }

  /* -------------------------------- payments -------------------------------- */

  fastify.get('/v1/payments', async (request, reply) => {
    authenticate(request);
    const query = listPaymentsQuery.parse(request.query);
    // The spec gives this list a default of 50; the pagination guide says 20.
    // The REST shape wins: 50.
    const { limit, offset } = readPage(query, 50);
    let payments = await allPayments();
    if (query.status_filter) {
      payments = payments.filter((payment) => paymentStatusOf(payment) === query.status_filter);
    }
    const page = payments.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async (payment) => {
        const context = await ctx.paymentContext(payment);
        return serializePaymentListItem(payment, context);
      }),
    );
    return reply.send({ items, pagination: pagination(payments.length, limit, offset, items.length) });
  });

  fastify.get<{ Params: { payment_id: string } }>('/v1/payments/:payment_id', async (request, reply) => {
    authenticate(request);
    const payment = await loadPayment(request.params.payment_id);
    return reply.send(serializePayment(payment, await ctx.paymentContext(payment)));
  });

  fastify.get<{ Params: { charge_id: string } }>('/v1/payments/charges/:charge_id', async (request, reply) => {
    authenticate(request);
    const payment = await loadPayment(request.params.charge_id);
    const context = await ctx.paymentContext(payment);
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    return reply.send(
      serializeChargeStatus(payment, {
        organizationId: ctx.organizationId,
        customerId: customer?.providerCustomerId ?? null,
        checkout: context.checkout,
        history: context.history,
      }),
    );
  });

  /* -------------------------------- refunds -------------------------------- */

  /** Every refund on a charge, however it was made. */
  async function refundsOf(payment: Payment): Promise<Array<{ refund: Refund; stored: StoredRefund }>> {
    const refunds = await storage.refunds.listByPayment(payment.id);
    const rows: Array<{ refund: Refund; stored: StoredRefund }> = [];
    for (const refund of refunds) rows.push({ refund, stored: await refundRecord(state, refund, payment) });
    return rows;
  }

  fastify.post('/v1/refunds', async (request, reply) => {
    authenticate(request);
    const body = createRefundSchema.parse(request.body);
    const payment = await storage.payments.byProviderTransactionId(PROVIDER, body.charge_id);
    if (!payment) throw notFound('Charge');

    // One lock per charge across "is there already a refund?" and the create:
    // "A charge carries at most one refund that did not fail".
    // References are unique across the account, charges one refund at a
    // time: both locks, always in this order.
    return withLock(`refund-reference:${body.reference}`, () => withLock(chargeLock(payment.id), async () => {
      // The body's own idempotency key: "the second request returns the existing refund".
      if (body.idempotency_key) {
        const raw = await storage.providerState.get(PROVIDER, `refund-key:${payment.id}:${body.idempotency_key}`);
        if (raw) {
          const remembered = JSON.parse(raw) as { refundId: string; at: string };
          if (clock.now() - Date.parse(remembered.at) < REFUND_KEY_WINDOW_MS) {
            const stored = await state.refunds.get(remembered.refundId);
            const refund = stored ? await storage.refunds.byId(stored.engineId) : null;
            if (stored && refund) return reply.status(201).send(serializeRefund(refund, stored));
          }
        }
      }

      if (await state.refunds.referenceTaken(body.reference)) {
        throw fail('duplicate_reference', 'CONFLICT', 'Refund reference already exists');
      }
      const existing = await refundsOf(payment);
      if (existing.some(({ refund }) => refund.status !== 'failed')) {
        throw fail('duplicate_reference', 'CONFLICT', 'A refund already exists for this charge');
      }
      // guides/refunds: an NGN bank transfer cannot be refunded.
      const corridor = corridorOf(payment);
      if (corridor === 'NGN_BANK_TRANSFER') {
        throw fail('invalid_request', 'BAD_REQUEST', 'Refunds are not supported for this charge');
      }
      const status = paymentStatusOf(payment);
      if (status === 'underpaid') {
        // Refundable at Bachs, but paybox's engine refunds only money it has
        // collected in full. Recorded in docs/bachs.md.
        throw fail(
          'unsupported_operation',
          'NOT_IMPLEMENTED',
          'Refunding an underpaid charge is not supported by paybox. See docs/bachs.md.',
        );
      }
      // guides/refunds: refundable when "succeeded, accepted, or underpaid".
      if (!['succeeded', 'accepted'].includes(status)) {
        throw fail('invalid_request', 'BAD_REQUEST', `Charge is not refundable in status \`${status}\``);
      }
      if (corridor === 'CRYPTO' && !body.refund_address) {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          'refund_address: required when refunding a crypto charge.',
        );
      }

      // What was collected, not what was asked: an accepted underpayment
      // holds only what arrived.
      const refundable = amountPaidOf(payment) - payment.amountRefunded;
      const amount = body.amount ? toMinor(body.amount, payment.currency, 'amount') : refundable;
      if (amount > refundable) {
        throw fail(
          'refund_exceeds_amount',
          'BAD_REQUEST',
          `Refund amount \`${toDecimal(amount, payment.currency)}\` exceeds refundable balance`,
        );
      }
      const balance = await engine.getBalance(PROVIDER, payment.currency);
      if (balance < amount) {
        throw fail('balance_insufficient', 'BAD_REQUEST', 'Insufficient balance to refund');
      }

      // The Bachs record goes first: refund.created is published from inside
      // the engine call and must already be able to find it.
      const now = clock.nowISO();
      const draft: StoredRefund = {
        id: refundId(ids),
        engineId: '',
        seq: await state.nextSeq(),
        chargeId: payment.providerTransactionId,
        reference: body.reference,
        requestedAmount: amount,
        currency: payment.currency,
        feeBearer: body.fee_bearer ?? 'org',
        reason: body.reason ?? null,
        simulatedOutcome: body.simulated_outcome ?? 'success',
        createdAt: now,
      };
      await state.refunds.put(draft);
      let refund: Refund;
      try {
        refund = await engine.createRefund({
          paymentId: payment.id,
          amount,
          reason: draft.reason,
          metadata: { bachs_refund_id: draft.id },
        });
      } catch (error) {
        // The engine refused after all; leave no half-made record behind.
        await state.refunds.delete(draft.id);
        throw error;
      }
      const stored = { ...draft, engineId: refund.id };
      await state.refunds.put(stored);
      await state.refunds.indexEngine(refund.id, stored.id);
      await state.refunds.indexReference(stored.reference, stored.id);
      if (body.idempotency_key) {
        await storage.providerState.put(
          PROVIDER,
          `refund-key:${payment.id}:${body.idempotency_key}`,
          JSON.stringify({ refundId: stored.id, at: now }),
          now,
        );
      }
      await storage.jobs.enqueue({
        id: ids.next('job'),
        kind: REFUND_SETTLE_JOB,
        payload: {
          refundId: refund.id,
          outcome: stored.simulatedOutcome === 'failed' ? 'failed' : 'successful',
        },
        status: 'ready',
        runAt: new Date(clock.now() + REFUND_SETTLE_DELAY_MS).toISOString(),
        attempt: 0,
        maxAttempts: 1,
        leaseExpiresAt: null,
        lastError: null,
        groupKey: `refund:${refund.id}`,
        createdAt: now,
        updatedAt: now,
      });
      return reply.status(201).send(serializeRefund(refund, stored));
    }));
  });

  /** Every refund on a Bachs charge, with its Bachs record, newest first. */
  async function allRefunds(): Promise<Array<{ refund: Refund; stored: StoredRefund }>> {
    const rows: Array<{ refund: Refund; stored: StoredRefund }> = [];
    for (const payment of await allPayments()) rows.push(...(await refundsOf(payment)));
    return rows.sort((a, b) =>
      newestFirst({ seq: a.stored.seq, createdAt: a.refund.createdAt }, { seq: b.stored.seq, createdAt: b.refund.createdAt }),
    );
  }

  /** listRefunds: `{ total, items }` -- not the `{ items, pagination }` the guide promises. */
  fastify.get('/v1/refunds', async (request, reply) => {
    authenticate(request);
    const query = listRefundsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    let rows = await allRefunds();
    if (query.status) rows = rows.filter(({ refund }) => toBachsRefundStatus(refund.status) === query.status);
    const page = rows.slice(offset, offset + limit);
    return reply.send({
      total: rows.length,
      items: page.map(({ refund, stored }) => serializeRefund(refund, stored)),
    });
  });

  fastify.get<{ Params: { refund_id: string } }>('/v1/refunds/:refund_id', async (request, reply) => {
    authenticate(request);
    const stored = await state.refunds.get(request.params.refund_id);
    const refund = stored?.engineId ? await storage.refunds.byId(stored.engineId) : null;
    if (!stored || !refund) throw notFound('Refund');
    return reply.send(serializeRefund(refund, stored));
  });

  /** The refund on a charge: the live one if there is one, else the latest. */
  fastify.get<{ Params: { payment_id: string } }>(
    '/v1/refunds/by-charge/:payment_id',
    async (request, reply) => {
      authenticate(request);
      const payment = await loadPayment(request.params.payment_id);
      const rows = await refundsOf(payment);
      const chosen =
        rows.find(({ refund }) => refund.status !== 'failed') ??
        rows.sort((a, b) =>
          newestFirst({ seq: a.stored.seq, createdAt: a.refund.createdAt }, { seq: b.stored.seq, createdAt: b.refund.createdAt }),
        )[0];
      if (!chosen) throw notFound('Refund');
      return reply.send(serializeRefund(chosen.refund, chosen.stored));
    },
  );

  /* -------------------------------- balances -------------------------------- */

  /**
   * `AccountBalanceResponse`. Every currency the account has collected in,
   * and USD always ("USD is always present"). The sandbox settles at once
   * (connect/testing), so nothing is ever pending. Bachs holds only USD and
   * NGN, converting the rest; paybox never converts, so a GHS collection
   * shows as a GHS balance and `total_balance_usd` counts USD alone --
   * docs/bachs.md records both.
   */
  fastify.get('/v1/balances', async (request, reply) => {
    authenticate(request);
    const currencies = new Set<string>(['USD']);
    for (const payment of await allPayments()) currencies.add(payment.currency);
    const balances = [];
    for (const currency of [...currencies].sort()) {
      const available = await engine.getBalance(PROVIDER, currency);
      balances.push({
        currency,
        available_balance: toDecimal(available, currency),
        pending_balance: toDecimal(0, currency),
      });
    }
    const usd = balances.find((entry) => entry.currency === 'USD')!;
    return reply.send({
      account_id: ctx.organizationId,
      balances,
      total_balance_usd: usd.available_balance,
      pending_settlements_by_day: [],
    });
  });
}

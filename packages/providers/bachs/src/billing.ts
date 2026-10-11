import {
  PayboxError,
  type Authorization,
  type Clock,
  type Customer,
  type IdFactory,
  type Invoice,
  type Payment,
  type PayboxEvent,
  type PlanInterval,
  type Subscription,
} from '@paybox/shared';
import { addInterval, type InvoiceItemDraft, type Job, type PaymentEngine, type Storage } from '@paybox/core';
import { PAYMENT_SIMULATE_JOB } from '@paybox/simulator';
import { factsFromDetails, resolveCard, saveCard, SAVED_CARD_DECLINE, type CardFacts } from './cards.js';
import { hasCapability } from './accounts.js';
import { fail } from './errors.js';
import { derivedId, hexId } from './ids.js';
import { creditLock, fulfilLock, subscriptionLock, withLock } from './locks.js';
import { convertMinor, NGN_PER_USD } from './rates.js';
import {
  bachsState,
  type BachsState,
  type Cadence,
  type StoredCheckout,
  type StoredFulfilment,
  type StoredInvoice,
  type StoredPaymentMeta,
  type StoredPaymentMethod,
  type StoredSubscription,
} from './state.js';
import { subscriptionStatusOf } from './status.js';

const PROVIDER = 'bachs' as const;

/**
 * Bachs billing: subscriptions, their invoices, recovery, proration, and the
 * off-session card charge underneath all of it.
 *
 * Sources (all read 2026-10-10): guides/subscriptions/{overview, manage,
 * failed-payments, trials, proration}, guides/payments/charge-a-saved-card,
 * build/use-cases/saas-subscriptions, and the pinned OpenAPI document.
 *
 * Why the adapter owns this rather than paybox's shared SubscriptionRunner:
 * Bachs retries a failed renewal on the *same* invoice on days 1, 4 and 9,
 * cancels (or marks unpaid) when that runs out, ends a scheduled cancellation
 * at the period end, keeps a customer credit balance, and prorates to the
 * cent. The shared runner does none of that, and teaching it would have meant
 * changing the renewal code Paystack and Stripe run on. So Bachs registers
 * its own two jobs, exactly as it owns its checkout expiry, and the runner is
 * never started for a Bachs subscription. Each job enqueues its successor --
 * no new scheduler primitive -- and runs under `VirtualClock#at`, so one
 * `time advance 1y` yields twelve renewals at twelve correct instants.
 *
 * Everything is still written as core rows (plan, subscription, invoice,
 * authorization, payment), so the dashboard, CLI, timeline and event log see
 * Bachs billing like any other. Bachs-only facts sit beside them in
 * provider state.
 *
 * Every mutation of one subscription -- API, portal, jobs -- runs under that
 * subscription's lock and re-reads state inside it. A job that finds the
 * subscription ended, or its own due date superseded, does nothing: that is
 * what keeps paybox's generic tooling (which can cancel a subscription
 * without the adapter) from leaving a job acting on stale state.
 */

export const BACHS_SUBSCRIPTION_RENEW_JOB = 'bachs.subscription.renew';
export const BACHS_SUBSCRIPTION_RETRY_JOB = 'bachs.subscription.retry';

/**
 * "Retry 1: 1 day after the first failure. Retry 2: 3 days after retry 1.
 * Retry 3: 5 days after retry 2." Offsets from the first failure.
 */
const RETRY_OFFSETS_MS = [1, 4, 9].map((days) => days * 86_400_000);

/** What happens when recovery runs out: an account setting, dashboard-only at Bachs. */
export type RecoveryMode = 'cancel' | 'unpaid';

const INTERVALS: Record<Cadence['interval'], PlanInterval> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  year: 'annually',
};

/**
 * The end of the `k`th period after `anchor`. Always measured from the
 * anchor, never from the previous boundary, so a subscription that started
 * on 31 January bills on 28 February and then on 31 March again rather than
 * drifting to the 28th for good. (Bachs does not document month-end
 * handling; docs/bachs.md records this choice.)
 */
export function periodBoundary(anchor: string, cycle: Cadence, k: number): string {
  return addInterval(anchor, INTERVALS[cycle.interval], cycle.frequency * k);
}

/**
 * `amount` scaled by the share of a period still ahead, rounded half-up to a
 * minor unit. "fraction_of_period_remaining is the exact share of the
 * current billing period still ahead ... Amounts are rounded to two decimal
 * places" (guides/subscriptions/proration). Exact to the millisecond, in
 * integer arithmetic, so no float ever touches money.
 */
export function prorate(amount: number, remainingMs: number, periodMs: number): number {
  if (periodMs <= 0 || remainingMs <= 0) return 0;
  if (remainingMs >= periodMs) return amount;
  const numerator = BigInt(amount) * BigInt(remainingMs) * 2n + BigInt(periodMs);
  return Number(numerator / (2n * BigInt(periodMs)));
}

/** The Bachs id of a core invoice; recomputable by anyone holding the core row. */
export const invoiceIdOf = (engineId: string) => derivedId('inv', `invoice:${engineId}`);

export interface BillingDeps {
  engine: PaymentEngine;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  recovery: RecoveryMode;
}

type MetaInput = Omit<StoredPaymentMeta, 'seq' | 'conversion'>;

export class BachsBilling {
  readonly #engine: PaymentEngine;
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #recovery: RecoveryMode;
  readonly state: BachsState;

  constructor(deps: BillingDeps) {
    this.#engine = deps.engine;
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#recovery = deps.recovery;
    this.state = bachsState(deps.storage, () => deps.clock.nowISO());
  }

  #cards() {
    return { engine: this.#engine, storage: this.#storage, state: this.state, clock: this.#clock, ids: this.#ids };
  }

  /* ------------------------------ card charges ------------------------------ */

  /**
   * Charge a saved card with nobody present.
   *
   * An ordinary engine payment moved only by `transitionPayment`, so a
   * renewal, a proration and a `POST /v1/charges` append the same events and
   * fire the same `collection.*` webhooks as a checkout. "A card refused
   * while the request is still open comes back already failed"; a success
   * either settles at once (`now`, a renewal with nobody waiting) or a
   * second later like every sandbox payment (`later`, the API).
   *
   * `amount`/`currency` are what is owed and settled. A card that bills in
   * another currency is charged the converted amount at the fixed rate, and
   * the payment records what was quoted.
   */
  async chargeCard(input: {
    customer: Customer;
    method: StoredPaymentMethod;
    authorization: Authorization;
    amount: number;
    currency: string;
    meta: MetaInput;
    settle: 'now' | 'later';
  }): Promise<Payment> {
    const { method, authorization } = input;
    const corridor = method.currency === 'NGN' ? 'NGN_CARD' : 'USD_CARD';
    const conversion =
      input.currency === method.currency
        ? null
        : {
            cardCurrency: method.currency,
            cardAmount: convertMinor(input.amount, input.currency, method.currency),
            ngnPerUsd: NGN_PER_USD,
          };
    const chargeId = hexId(this.#ids, 'ch');
    let payment = await this.#engine.createPayment({
      provider: PROVIDER,
      // A connected account's customer is charged as that account: its money.
      ...(input.customer.subaccountId
        ? { subaccountId: input.customer.subaccountId, settlementMode: 'direct' as const }
        : {}),
      amount: input.amount,
      currency: input.currency,
      // The engine's reference is unique; Bachs' `reference` is the merchant's
      // own label and need not be, so it lives on the meta record.
      reference: chargeId,
      providerTransactionId: chargeId,
      customerId: input.customer.id,
      paymentMethod: 'card',
      paymentMethodDetails: {
        corridor,
        brand: authorization.brand,
        last4: authorization.last4,
        exp_month: authorization.expMonth,
        exp_year: authorization.expYear,
        payment_method_id: method.id,
        off_session: true,
      },
      metadata: {},
      status: 'created',
    });
    await this.state.paymentMeta.put(payment.id, { ...input.meta, seq: await this.state.nextSeq(), conversion });

    payment = await this.#engine.transitionPayment(payment.id, 'processing');
    // A connected account charges only with its card capability active: a
    // renewal or retry for an account whose platform restricted it fails, and
    // recovery takes over, as for any refused card.
    if (input.customer.subaccountId) {
      const account = (await this.state.accounts.all()).find((entry) => entry.engineId === input.customer.subaccountId);
      const capability = method.currency === 'NGN' ? 'ngn_card_collection' : 'card_collection';
      if (account && !hasCapability(account, capability)) {
        return this.#engine.transitionPayment(payment.id, 'failed', {
          failureCode: 'payment_method_not_enabled',
          failureMessage: `This account's ${capability} capability is not active.`,
        });
      }
    }
    if (method.behaviour === 'declines') {
      return this.#engine.transitionPayment(payment.id, 'failed', {
        failureCode: SAVED_CARD_DECLINE.failureCode,
        failureMessage: SAVED_CARD_DECLINE.message,
      });
    }
    if (input.settle === 'now') return this.#engine.transitionPayment(payment.id, 'successful');
    const now = this.#clock.nowISO();
    await this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind: PAYMENT_SIMULATE_JOB,
      payload: { paymentId: payment.id, outcome: 'success' },
      status: 'ready',
      runAt: new Date(this.#clock.now() + 1_000).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `payment:${payment.id}`,
      createdAt: now,
      updatedAt: now,
    });
    return payment;
  }

  /* ------------------------------- checkouts -------------------------------- */

  /**
   * React to a Bachs payment succeeding: a subscription checkout starts its
   * subscription, a `save_payment_method` checkout keeps the card.
   *
   * Driven by the payment's own success event rather than by the hosted page,
   * so the result is the same whoever settled it -- the sandbox's one-second
   * finalisation, `paybox simulate`, a scenario, the dashboard. Registered on
   * the bus for `payment.successful` specifically, which runs before the
   * webhook dispatcher's catch-all subscription, so `checkout.completed` is
   * built after the subscription it names exists.
   */
  onPaymentSuccessful = async (event: PayboxEvent): Promise<void> => {
    if (event.provider !== PROVIDER || event.resourceType !== 'payment') return;
    const checkout = await this.state.checkouts.byPayment(event.resourceId);
    if (!checkout) return;
    if ((checkout.mode ?? 'payment') !== 'subscription' && !checkout.savePaymentMethod) return;
    const payment = await this.#storage.payments.byId(event.resourceId);
    if (!payment) return;
    await this.fulfilCheckout(checkout, payment, factsFromDetails(payment.paymentMethodDetails));
  };

  /**
   * A checkout's completion work, once: save the card, start the
   * subscription. `payment` is null for a checkout that collected a card
   * without charging -- a trial, or `setup` mode.
   */
  async fulfilCheckout(
    checkout: StoredCheckout,
    payment: Payment | null,
    facts: CardFacts | null,
  ): Promise<StoredFulfilment> {
    return withLock(fulfilLock(checkout.id), async () => {
      const done = await this.state.fulfilments.get(checkout.id);
      if (done) return done;
      const now = this.#clock.nowISO();
      const customer = checkout.customerId ? await this.#storage.customers.byId(checkout.customerId) : null;
      // Only a card can be charged again; a payment on another rail saves
      // nothing ("you could pay by bank transfer, and you would only find out
      // there was no card when your first charge failed").
      if (!facts || !customer) {
        const empty = { paymentMethodId: null, subscriptionId: null, at: now };
        await this.state.fulfilments.put(checkout.id, empty);
        return empty;
      }
      const currency = payment?.currency ?? 'USD';
      const method = await saveCard(this.#cards(), {
        customer,
        facts,
        currency: currency === 'NGN' ? 'NGN' : 'USD',
        paymentId: payment?.id ?? null,
      });
      let subscriptionId: string | null = null;
      if ((checkout.mode ?? 'payment') === 'subscription' && checkout.recurring) {
        subscriptionId = (await this.#startSubscription(checkout, customer, method, payment)).id;
      }
      const fulfilment = { paymentMethodId: method.id, subscriptionId, at: now };
      await this.state.fulfilments.put(checkout.id, fulfilment);
      return fulfilment;
    });
  }

  async #startSubscription(
    checkout: StoredCheckout,
    customer: Customer,
    method: StoredPaymentMethod,
    payment: Payment | null,
  ): Promise<StoredSubscription> {
    const recurring = checkout.recurring!;
    // The subscription begins when it was paid for -- which is now, unless
    // this is the expiry job's backstop catching up on a completion whose
    // event was lost.
    const now = payment?.paidAt ?? this.#clock.nowISO();
    const productRecord = await this.state.products.get(recurring.productId);
    // Derived from the checkout, so a completion retried after a crash finds
    // the subscription it already started instead of starting a second one.
    const id = derivedId('sub', `subscription:${checkout.id}`);
    // Every step below is safe to repeat, because a completion can be retried
    // by the expiry job's backstop after failing part-way: each one looks for
    // what an earlier attempt already made before making it.
    let stored = await this.state.subscriptions.get(id);
    const priceId = recurring.override
      ? derivedId('price', `price:${id}`, 24)
      : derivedId('price', `price:${recurring.productId}:${recurring.currency}`, 24);
    // "Bachs saves their card without charging it, creates the subscription
    // in trialing, and schedules the first charge for the end of the trial."
    const trialEnd = recurring.trial ? periodBoundary(now, recurring.trial, 1) : null;
    const periodEnd = trialEnd ?? periodBoundary(now, recurring.cycle, 1);
    const metadata = { ...checkout.metadata, checkout_id: checkout.id };
    if (!stored) {
      stored = {
        seq: await this.state.nextSeq(),
        id,
        engineId: '',
        customerId: customer.id,
        productId: recurring.productId,
        priceId,
        overridePrice: recurring.override,
        itemId: derivedId('si', `si:${id}`, 24),
        checkoutId: checkout.id,
        paymentMethodId: method.id,
        unitAmount: recurring.unitAmount,
        quantity: recurring.quantity,
        currency: recurring.currency,
        cycle: recurring.cycle,
        trialEnd,
        anchor: trialEnd ?? now,
        cycles: trialEnd ? 0 : 1,
        periodStart: now,
        periodEnd,
        nextRenewalAt: periodEnd,
        previouslyBilledAt: payment ? now : null,
        periodBilled: payment !== null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancellationReason: null,
        exhausted: false,
        deferredProration: 0,
        metadata,
        createdAt: now,
        updatedAt: now,
        priceCreatedAt: now,
      };
      // The record first: `subscription.created` is published inside the
      // engine call below, and its webhook is built from both.
      await this.state.subscriptions.put(stored);
    }

    let subscription = await this.#storage.subscriptions.byCode(PROVIDER, id);
    if (!subscription) {
      const planCode = `${priceId}:${id}`;
      const plan =
        (await this.#storage.plans.byCode(PROVIDER, planCode)) ??
        (await this.#engine.createPlan({
          provider: PROVIDER,
          name: recurring.productName,
          amount: recurring.unitAmount,
          currency: recurring.currency,
          interval: INTERVALS[recurring.cycle.interval],
          intervalCount: recurring.cycle.frequency,
          productId: productRecord?.engineId ?? null,
          providerPlanCode: planCode,
          metadata: { bachs_product_id: recurring.productId },
        }));
      subscription = await this.#engine.createSubscription({
        provider: PROVIDER,
        customerId: customer.id,
        planId: plan.id,
        authorizationId: method.engineId,
        quantity: recurring.quantity,
        trialEnd,
        providerSubscriptionCode: id,
        metadata,
      });
    }
    if (stored.engineId !== subscription.id) {
      stored = { ...stored, engineId: subscription.id };
      await this.state.subscriptions.put(stored);
      await this.#storage.subscriptions.update(subscription.id, {
        currentPeriodStart: stored.periodStart,
        nextPaymentDate: stored.periodEnd,
        updatedAt: now,
      });
    }
    // Every time, not only when the link was just made: a crash after the
    // link and before this would otherwise leave a subscription that never
    // renews. A duplicate is harmless -- the second job finds its due date
    // superseded once the first has run.
    if (stored.nextRenewalAt) await this.#scheduleRenewal(stored, stored.nextRenewalAt);

    if (payment) {
      // The checkout's own charge paid the first cycle: raise that invoice,
      // or finish settling the one an interrupted attempt raised.
      const first = (await this.#storage.invoices.listBySubscription(subscription.id)).find(
        (entry) => entry.billingReason === 'subscription_create',
      );
      if (first?.status === 'success') return stored;
      const invoice =
        first ??
        (await this.#raiseInvoice(stored, subscription, {
          kind: 'cycle',
          billingReason: 'subscription_create',
          periodStart: stored.periodStart,
          periodEnd: stored.periodEnd,
          applyCredit: false,
        }));
      const record = (await this.state.invoices.get(invoice.id)) ?? {
        id: invoiceIdOf(invoice.id),
        engineId: invoice.id,
        subscriptionId: id,
        kind: 'cycle' as const,
        creditApplied: 0,
        retries: 0,
        nextPaymentAttempt: null,
        createdAt: invoice.createdAt,
      };
      await this.state.invoices.put({ ...record, nextPaymentAttempt: null });
      await this.state.paymentMeta.put(payment.id, {
        billingReason: 'subscription_create',
        channel: 'checkout',
        subscriptionId: id,
        invoiceEngineId: invoice.id,
        reference: checkout.reference,
        description: null,
        metadata: checkout.metadata,
        conversion: null,
      });
      await this.#engine.transitionInvoice(invoice.id, 'success', { paymentId: payment.id });
    }
    return stored;
  }

  /* ------------------------------- the jobs -------------------------------- */

  /** `bachs.subscription.renew`: the end of a period (or of a trial). */
  handleRenewJob = async (job: Job): Promise<void> => {
    const subscriptionId = String(job.payload.subscriptionId ?? '');
    const dueAt = String(job.payload.dueAt ?? '');
    if (!subscriptionId || !dueAt) return;
    await withLock(subscriptionLock(subscriptionId), () => this.#renew(subscriptionId, dueAt));
  };

  /** `bachs.subscription.retry`: a recovery attempt on an unpaid invoice. */
  handleRetryJob = async (job: Job): Promise<void> => {
    const subscriptionId = String(job.payload.subscriptionId ?? '');
    const invoiceId = String(job.payload.invoiceId ?? '');
    const retry = Number(job.payload.retry ?? 0);
    const firstFailedAt = String(job.payload.firstFailedAt ?? '');
    if (!subscriptionId || !invoiceId || !retry || !firstFailedAt) return;
    await withLock(subscriptionLock(subscriptionId), () =>
      this.#retry(subscriptionId, invoiceId, retry, firstFailedAt),
    );
  };

  async #load(subscriptionId: string): Promise<{ stored: StoredSubscription; core: Subscription } | null> {
    const stored = await this.state.subscriptions.get(subscriptionId);
    const core = stored?.engineId ? await this.#storage.subscriptions.byId(stored.engineId) : null;
    return stored && core ? { stored, core } : null;
  }

  async #renew(subscriptionId: string, dueAt: string): Promise<void> {
    const loaded = await this.#load(subscriptionId);
    if (!loaded) return;
    let { stored, core } = loaded;
    // Superseded: a trial moved, or the job ran twice.
    if (stored.nextRenewalAt !== dueAt) return;
    if (core.status === 'cancelled' || core.status === 'completed') return;

    // A scheduled cancellation "keeps working until current_period_end ...
    // then transitions to canceled". paybox's generic `subscription disable`
    // (non_renewing) reads the same way.
    if (stored.cancelAtPeriodEnd || core.status === 'non_renewing') {
      await this.#end(stored, core, stored.cancellationReason);
      return;
    }

    // Recovering: no new invoice while one is still owed. Billing resumes at
    // the next boundary (docs/bachs.md records this; Bachs does not say).
    if (core.status === 'attention') {
      const next = periodBoundary(stored.anchor, stored.cycle, stored.cycles + 1);
      // The period moves on, unbilled, so a plan change after recovery is
      // prorated against the period actually running.
      const skipped = {
        ...stored,
        cycles: stored.cycles + 1,
        periodStart: dueAt,
        periodEnd: next,
        periodBilled: false,
        nextRenewalAt: next,
        updatedAt: dueAt,
      };
      await this.state.subscriptions.put(skipped);
      await this.#storage.subscriptions.update(core.id, { currentPeriodStart: dueAt, nextPaymentDate: next, updatedAt: dueAt });
      await this.#scheduleRenewal(skipped, next);
      return;
    }

    const now = this.#clock.nowISO();
    const firstCycle = stored.trialEnd !== null && dueAt === stored.trialEnd && stored.previouslyBilledAt === null;
    // "At the end of each billing period, Bachs advances the subscription to
    // the next cycle, opens an invoice, and charges the customer's saved card
    // off-session."
    const cycles = stored.trialEnd !== null && dueAt === stored.trialEnd ? 1 : stored.cycles + 1;
    const anchor = stored.trialEnd !== null && dueAt === stored.trialEnd ? dueAt : stored.anchor;
    const periodEnd = periodBoundary(anchor, stored.cycle, cycles);
    stored = {
      ...stored,
      anchor,
      cycles,
      periodStart: dueAt,
      periodEnd,
      nextRenewalAt: periodEnd,
      previouslyBilledAt: dueAt,
      periodBilled: true,
      updatedAt: now,
    };
    await this.#storage.subscriptions.update(core.id, { currentPeriodStart: dueAt, nextPaymentDate: periodEnd, updatedAt: now });
    if (core.status === 'trialing') {
      // The trial's end is its first billing date; `trialing -> active`
      // reports the new period too.
      await this.state.subscriptions.put(stored);
      core = await this.#engine.transitionSubscription(core.id, 'active', { nextPaymentDate: periodEnd });
    } else {
      await this.#updated(stored, core);
    }
    await this.#scheduleRenewal(stored, periodEnd);

    const invoice = await this.#raiseInvoice(stored, core, {
      kind: 'cycle',
      billingReason: firstCycle ? 'subscription_create' : 'subscription_cycle',
      periodStart: dueAt,
      periodEnd,
      applyCredit: true,
    });
    await this.#collectFirst(stored.id, invoice);
  }

  async #retry(subscriptionId: string, invoiceEngineId: string, retry: number, firstFailedAt: string): Promise<void> {
    const loaded = await this.#load(subscriptionId);
    if (!loaded) return;
    const { core } = loaded;
    if (core.status === 'cancelled' || core.status === 'completed') return;
    const invoice = await this.#storage.invoices.byId(invoiceEngineId);
    const record = await this.state.invoices.get(invoiceEngineId);
    if (!invoice || !record) return;
    // Paid meanwhile (a card update, the portal), or this retry already ran.
    if (invoice.status !== 'failed' || record.retries !== retry - 1) return;

    const paid = await this.#attempt(loaded.stored, invoice, record, { retry, firstFailedAt });
    if (paid || retry < RETRY_OFFSETS_MS.length) return;
    await this.#exhaust(subscriptionId, invoiceEngineId);
  }

  /* ----------------------------- collection ------------------------------ */

  /**
   * Attempt an invoice that has never been attempted. On failure "the first
   * failed charge sets the invoice's status so Bachs can retry it on a fixed
   * cadence" and the subscription goes `past_due`.
   */
  async #collectFirst(subscriptionId: string, invoice: Invoice): Promise<boolean> {
    const record = (await this.state.invoices.get(invoice.id))!;
    const stored = (await this.state.subscriptions.get(subscriptionId))!;
    return this.#attempt(stored, invoice, record, { retry: 0, firstFailedAt: null });
  }

  /**
   * One collection attempt on an open invoice: settle it from credit, or
   * charge the subscription's card. Moves the invoice and the subscription
   * accordingly and schedules the next retry. Returns whether it was paid.
   */
  async #attempt(
    stored: StoredSubscription,
    invoice: Invoice,
    record: StoredInvoice,
    position: { retry: number; firstFailedAt: string | null },
  ): Promise<boolean> {
    const now = this.#clock.nowISO();
    if (invoice.amount === 0) {
      // "if it fully covers the invoice, the invoice is marked paid and the
      // card is not charged".
      await this.state.invoices.put({ ...record, nextPaymentAttempt: null });
      await this.#engine.transitionInvoice(invoice.id, 'success', { paymentId: null });
      await this.#recovered(stored.id);
      return true;
    }

    const customer = await this.#storage.customers.byId(stored.customerId);
    const card = customer ? await this.#cardFor(customer, stored.paymentMethodId) : null;
    let payment: Payment | null = null;
    if (customer && card) {
      payment = await this.chargeCard({
        customer,
        method: card.method,
        authorization: card.authorization,
        amount: invoice.amount,
        currency: invoice.currency,
        meta: {
          billingReason: invoice.billingReason as StoredPaymentMeta['billingReason'],
          channel: 'subscription',
          subscriptionId: stored.id,
          invoiceEngineId: invoice.id,
          reference: null,
          description: null,
          metadata: stored.metadata,
        },
        settle: 'now',
      });
    }

    if (payment?.status === 'successful') {
      await this.state.invoices.put({ ...record, nextPaymentAttempt: null });
      await this.#engine.transitionInvoice(invoice.id, 'success', { paymentId: payment.id });
      await this.#recovered(stored.id);
      return true;
    }

    // Failed. Count it, say when the next try is, and move to past_due.
    const firstFailedAt = position.firstFailedAt ?? now;
    const retries = position.retry;
    const nextAt =
      retries < RETRY_OFFSETS_MS.length
        ? new Date(Date.parse(firstFailedAt) + RETRY_OFFSETS_MS[retries]!).toISOString()
        : null;
    await this.state.invoices.put({ ...record, retries, nextPaymentAttempt: nextAt });
    if (invoice.status === 'failed') {
      // Another failure of an invoice already failed: through `pending`, so
      // the second `invoice.payment_failed` is a real transition.
      await this.#engine.transitionInvoice(invoice.id, 'pending', { attempted: false });
    }
    if (invoice.status !== 'uncollectible') {
      await this.#engine.transitionInvoice(invoice.id, 'failed', { paymentId: payment?.id ?? null });
    }
    const current = (await this.#load(stored.id))!;
    if (current.core.status !== 'cancelled' && current.core.status !== 'completed') {
      // Owed from here on, before the core row moves: every webhook the moves
      // below publish reads past_due, never "active" between a failed charge
      // and past_due.
      await this.state.subscriptions.put({
        ...current.stored,
        owing: true,
        // paybox's tooling scheduled the end; past_due cannot be reached from
        // non_renewing, so the schedule moves onto the Bachs record.
        ...(current.core.status === 'non_renewing' ? { cancelAtPeriodEnd: true } : {}),
        updatedAt: now,
      });
    }
    if (current.core.status !== 'attention' && current.core.status !== 'cancelled' && current.core.status !== 'completed') {
      if (current.core.status === 'non_renewing') {
        await this.#engine.transitionSubscription(current.core.id, 'active', {
          nextPaymentDate: current.core.nextPaymentDate,
        });
      }
      if (current.core.status === 'trialing') {
        await this.#engine.transitionSubscription(current.core.id, 'active', {
          nextPaymentDate: current.core.nextPaymentDate,
        });
      }
      await this.#engine.transitionSubscription(current.core.id, 'attention', {
        nextPaymentDate: current.core.nextPaymentDate,
      });
    }
    if (nextAt) {
      await this.#enqueue(BACHS_SUBSCRIPTION_RETRY_JOB, stored.id, nextAt, {
        subscriptionId: stored.id,
        invoiceId: invoice.id,
        retry: retries + 1,
        firstFailedAt,
      });
    }
    return false;
  }

  async #cardFor(customer: Customer, paymentMethodId: string | null) {
    try {
      return await resolveCard({ storage: this.#storage, state: this.state, clock: this.#clock }, customer, paymentMethodId);
    } catch (error) {
      if (error instanceof PayboxError) return null;
      throw error;
    }
  }

  /** A success while recovering: `past_due -> active`, and `unpaid` too. */
  async #recovered(subscriptionId: string): Promise<void> {
    const loaded = await this.#load(subscriptionId);
    if (!loaded) return;
    const { core } = loaded;
    if (core.status !== 'attention' && !loaded.stored.owing) return;
    if (core.status === 'cancelled' || core.status === 'completed') return;
    const stored = { ...loaded.stored, owing: false, exhausted: false, updatedAt: this.#clock.nowISO() };
    if (core.status === 'attention') {
      await this.state.subscriptions.put(stored);
      await this.#engine.transitionSubscription(core.id, 'active', { nextPaymentDate: core.nextPaymentDate });
      return;
    }
    // Owed while the core row sat elsewhere (paybox's tooling moved it).
    await this.#updated(stored, core);
  }

  /**
   * "When the 3rd retry fails": cancel with reason `payment_failed` (the
   * default), or stay `unpaid` when the account keeps unpaid subscriptions.
   */
  async #exhaust(subscriptionId: string, invoiceEngineId: string): Promise<void> {
    const loaded = await this.#load(subscriptionId);
    if (!loaded) return;
    await this.#engine.transitionInvoice(invoiceEngineId, 'uncollectible');
    if (this.#recovery === 'cancel') {
      await this.#end(loaded.stored, loaded.core, 'payment_failed');
      return;
    }
    await this.#updated({ ...loaded.stored, exhausted: true, updatedAt: this.#clock.nowISO() }, loaded.core);
  }

  /**
   * Retry an owed invoice now: a card change on a `past_due`/`unpaid`
   * subscription "retries immediately", and so does the portal's recovery
   * payment. Recovery's own schedule is unaffected if this fails too.
   */
  async #retryNow(stored: StoredSubscription): Promise<void> {
    const invoices = await this.#storage.invoices.listBySubscription(stored.engineId);
    const owed = invoices
      .filter((invoice) => invoice.status === 'failed' || invoice.status === 'uncollectible')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    if (!owed) return;
    const record = await this.state.invoices.get(owed.id);
    if (!record) return;
    const customer = await this.#storage.customers.byId(stored.customerId);
    const card = customer ? await this.#cardFor(customer, stored.paymentMethodId) : null;
    if (!customer || !card) return;
    const payment = await this.chargeCard({
      customer,
      method: card.method,
      authorization: card.authorization,
      amount: owed.amount,
      currency: owed.currency,
      meta: {
        billingReason: owed.billingReason as StoredPaymentMeta['billingReason'],
        channel: 'subscription',
        subscriptionId: stored.id,
        invoiceEngineId: owed.id,
        reference: null,
        description: null,
        metadata: stored.metadata,
      },
      settle: 'now',
    });
    if (payment.status === 'successful') {
      await this.state.invoices.put({ ...record, nextPaymentAttempt: null });
      await this.#engine.transitionInvoice(owed.id, 'success', { paymentId: payment.id });
      await this.#recovered(stored.id);
      return;
    }
    if (owed.status === 'failed') {
      await this.#engine.transitionInvoice(owed.id, 'pending', { attempted: false });
      await this.#engine.transitionInvoice(owed.id, 'failed', { paymentId: payment.id });
    }
  }

  /* ------------------------------- invoices -------------------------------- */

  /**
   * Open an invoice for a subscription. Lines are core invoice items, so the
   * total is a fold over them: the period's price, any `next_cycle`
   * proration carried in, and the customer's credit applied last ("Credit is
   * applied to the next invoice first").
   */
  async #raiseInvoice(
    stored: StoredSubscription,
    core: Subscription,
    input: {
      kind: StoredInvoice['kind'];
      billingReason: StoredPaymentMeta['billingReason'];
      periodStart: string;
      periodEnd: string;
      applyCredit: boolean;
      lines?: InvoiceItemDraft[];
    },
  ): Promise<Invoice> {
    const now = this.#clock.nowISO();
    const product = await this.state.products.get(stored.productId);
    const productName = product ? ((await this.#storage.products.byId(product.engineId))?.name ?? null) : null;
    const lines: InvoiceItemDraft[] = input.lines ?? [
      {
        planId: core.planId,
        description: productName,
        unitAmount: stored.unitAmount,
        quantity: stored.quantity,
        currency: stored.currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    ];
    if (input.kind === 'cycle' && stored.deferredProration > 0) {
      lines.push({
        description: 'Proration carried from a plan change',
        amount: stored.deferredProration,
        currency: stored.currency,
        proration: true,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      });
      stored = { ...stored, deferredProration: 0 };
      await this.state.subscriptions.put(stored);
    }
    // The balance read, the invoice it discounts and the ledger entry are one
    // critical section per customer and currency: another subscription of the
    // same customer must not spend the same credit.
    return withLock(creditLock(stored.customerId, stored.currency), async () => {
      const subtotal = lines.reduce((sum, line) => sum + (line.amount ?? (line.unitAmount ?? 0) * (line.quantity ?? 1)), 0);
      const balance = input.applyCredit ? await this.state.credit.balance(stored.customerId, stored.currency) : 0;
      const applied = Math.max(0, Math.min(balance, subtotal));
      if (applied > 0) {
        lines.push({
          description: 'Applied balance',
          amount: -applied,
          currency: stored.currency,
          metadata: { bachs_credit: true },
        });
      }
      const invoice = await this.#engine.createInvoice({
        subscriptionId: core.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dueAt: now,
        billingReason: input.billingReason,
        items: lines.map((line) => ({ ...line, subscriptionId: core.id, customerId: core.customerId, provider: PROVIDER })),
      });
      await this.state.invoices.put({
        id: invoiceIdOf(invoice.id),
        engineId: invoice.id,
        subscriptionId: stored.id,
        kind: input.kind,
        creditApplied: applied,
        retries: 0,
        nextPaymentAttempt: now,
        createdAt: now,
      });
      if (applied > 0) {
        await this.state.credit.append(stored.customerId, stored.currency, {
          amount: -applied,
          reason: 'applied',
          invoiceEngineId: invoice.id,
          subscriptionId: stored.id,
          at: now,
        });
      }
      return invoice;
    });
  }

  /* ---------------------------- state changes ------------------------------ */

  /** Write the record and report it as `customer.subscription.updated`, in one transaction. */
  async #updated(stored: StoredSubscription, core: Subscription, apply?: (tx: Storage) => Promise<void>): Promise<void> {
    const now = this.#clock.nowISO();
    await this.#engine.recordEvent({
      provider: PROVIDER,
      type: 'subscription.updated',
      resourceType: 'subscription',
      resourceId: core.id,
      data: { subscription_id: stored.id },
      apply: async (tx) => {
        await tx.providerState.put(PROVIDER, `subscription:${stored.id}`, JSON.stringify(stored), now);
        if (apply) await apply(tx);
      },
    });
  }

  /** Move to `canceled` now. */
  async #end(stored: StoredSubscription, core: Subscription, reason: string | null): Promise<void> {
    const now = this.#clock.nowISO();
    const ended = {
      ...stored,
      owing: false,
      canceledAt: now,
      cancellationReason: reason,
      nextRenewalAt: null,
      updatedAt: now,
    };
    await this.state.subscriptions.put(ended);
    await this.#storage.jobs.cancelGroup(`bachs-subscription:${stored.id}`);
    // An invoice still owed is never collected now: no retry remains to
    // advertise. Exhaustion already marked its own; this is the rest.
    for (const invoice of await this.#storage.invoices.listBySubscription(core.id)) {
      if (invoice.status !== 'failed' && invoice.status !== 'pending') continue;
      const record = await this.state.invoices.get(invoice.id);
      if (record) await this.state.invoices.put({ ...record, nextPaymentAttempt: null });
      await this.#engine.transitionInvoice(invoice.id, 'uncollectible');
    }
    await this.#engine.transitionSubscription(core.id, 'cancelled', { nextPaymentDate: null });
  }

  /* ------------------------------- the API ------------------------------- */

  /** Run `fn` against a fresh copy of the subscription, under its lock. */
  async withSubscription<T>(
    subscriptionId: string,
    fn: (stored: StoredSubscription, core: Subscription) => Promise<T>,
  ): Promise<T> {
    return withLock(subscriptionLock(subscriptionId), async () => {
      const loaded = await this.#load(subscriptionId);
      if (!loaded) throw fail('not_found', 'NOT_FOUND', 'Subscription not found');
      return fn(loaded.stored, loaded.core);
    });
  }

  statusOf(stored: StoredSubscription, core: Subscription) {
    return subscriptionStatusOf(core, stored, this.#clock.now());
  }

  /**
   * `DELETE /v1/subscriptions/{id}`. Immediate: "moves to canceled right now
   * ... sets canceled_at, clears the next billing date, and emits
   * customer.subscription.deleted". Scheduled: "keeps working until
   * current_period_end ... sets cancel_at_period_end: true and emits
   * customer.subscription.updated".
   */
  async cancel(subscriptionId: string, input: { atPeriodEnd: boolean; reason: string | null }): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      if (this.statusOf(stored, core) === 'canceled') {
        throw fail('validation_failed', 'SUBSCRIPTION_ALREADY_CANCELED', 'The subscription is already canceled.');
      }
      if (!input.atPeriodEnd) {
        await this.#end(stored, core, input.reason);
        return;
      }
      if (stored.cancelAtPeriodEnd) return;
      await this.#updated(
        { ...stored, cancelAtPeriodEnd: true, cancellationReason: input.reason, updatedAt: this.#clock.nowISO() },
        core,
      );
    });
  }

  /** The portal's "undo a scheduled cancellation". No API does this at Bachs. */
  async undoCancel(subscriptionId: string): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      this.#assertModifiable(stored, core);
      if (!stored.cancelAtPeriodEnd && core.status !== 'non_renewing') return;
      const next = { ...stored, cancelAtPeriodEnd: false, cancellationReason: null, updatedAt: this.#clock.nowISO() };
      if (core.status === 'non_renewing') {
        await this.state.subscriptions.put(next);
        await this.#engine.transitionSubscription(core.id, 'active', { nextPaymentDate: next.nextRenewalAt });
        return;
      }
      await this.#updated(next, core);
    });
  }

  /** PATCH `metadata`: merged; `""` deletes a key, `metadata: ""` clears all; `checkout_id` stays. */
  async updateMetadata(subscriptionId: string, patch: Record<string, unknown> | ''): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      this.#assertModifiable(stored, core);
      const merged: Record<string, unknown> = patch === '' ? {} : { ...stored.metadata };
      if (patch !== '') {
        for (const [key, value] of Object.entries(patch)) {
          if (value === '') delete merged[key];
          else merged[key] = value;
        }
      }
      if (stored.metadata.checkout_id !== undefined) merged.checkout_id = stored.metadata.checkout_id;
      const metadata = merged;
      await this.#updated({ ...stored, metadata, updatedAt: this.#clock.nowISO() }, core, async (tx) => {
        await tx.subscriptions.update(core.id, { metadata, updatedAt: this.#clock.nowISO() });
      });
    });
  }

  /**
   * PATCH `payment_method_id`: "Point the subscription at a different saved
   * card. If past_due/unpaid, retries immediately."
   */
  async changePaymentMethod(subscriptionId: string, paymentMethodId: string): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      this.#assertModifiable(stored, core);
      const customer = await this.#storage.customers.byId(stored.customerId);
      if (!customer) throw fail('not_found', 'NOT_FOUND', 'Customer not found');
      const { method } = await resolveCard(
        { storage: this.#storage, state: this.state, clock: this.#clock },
        customer,
        paymentMethodId,
      );
      const next = { ...stored, paymentMethodId: method.id, updatedAt: this.#clock.nowISO() };
      await this.#updated(next, core, async (tx) => {
        await tx.subscriptions.update(core.id, { authorizationId: method.engineId, updatedAt: this.#clock.nowISO() });
      });
      if (core.status === 'attention') await this.#retryNow(next);
    });
  }

  /**
   * PATCH `trial_end`: "Future = add/extend the trial; past-or-now = end it
   * and bill now." An active subscription given a future trial end "becomes
   * trialing".
   */
  async moveTrial(subscriptionId: string, trialEnd: string): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      this.#assertModifiable(stored, core);
      const status = this.statusOf(stored, core);
      const at = Date.parse(trialEnd);
      const now = this.#clock.nowISO();
      if (at <= this.#clock.now()) {
        if (status !== 'trialing') {
          throw fail('validation_failed', 'SUBSCRIPTION_NOT_TRIALING', 'The subscription is not in a trial.');
        }
        // "a fresh billing cycle starts, and Bachs charges the first cycle
        // right away".
        await this.#storage.jobs.cancelGroup(`bachs-subscription:${stored.id}`);
        const ending = { ...stored, trialEnd: now, nextRenewalAt: now, updatedAt: now };
        await this.state.subscriptions.put(ending);
        await this.#renew(stored.id, now);
        return;
      }
      if (status === 'past_due' || status === 'unpaid') {
        throw fail(
          'validation_failed',
          'SUBSCRIPTION_NOT_MODIFIABLE',
          `The subscription cannot be modified while it is ${status}.`,
        );
      }
      const iso = new Date(at).toISOString();
      await this.#storage.jobs.cancelGroup(`bachs-subscription:${stored.id}`);
      const moved = {
        ...stored,
        trialEnd: iso,
        periodEnd: iso,
        nextRenewalAt: iso,
        updatedAt: now,
      };
      await this.#updated(moved, core, async (tx) => {
        await tx.subscriptions.update(core.id, { trialEnd: iso, nextPaymentDate: iso, updatedAt: now });
      });
      await this.#scheduleRenewal(moved, iso);
    });
  }

  /**
   * PATCH `product_id`: a plan change, prorated per `proration_behavior`.
   *
   *   credit = old_amount x fraction_remaining
   *   charge = new_amount x fraction_remaining
   *   net    = charge - credit
   *
   * `invoice_now` charges a positive net on a one-off invoice now;
   * `next_cycle` rolls it into the next renewal; `none` changes the terms
   * only. A negative net (a downgrade) becomes customer credit, except under
   * `none` -- the guide contradicts itself there and docs/bachs.md records
   * which statement paybox follows.
   */
  async changePlan(
    subscriptionId: string,
    input: {
      productId: string;
      productName: string;
      productEngineId: string | null;
      unitAmount: number;
      cycle: Cadence;
      behaviour: 'invoice_now' | 'next_cycle' | 'none';
    },
  ): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      this.#assertModifiable(stored, core);
      const status = this.statusOf(stored, core);
      // Prorating a period that was never paid for would credit time the
      // customer did not buy. Bachs does not say; paybox refuses until the
      // subscription has recovered (docs/bachs.md).
      if (status === 'past_due' || status === 'unpaid') {
        throw fail(
          'validation_failed',
          'SUBSCRIPTION_NOT_MODIFIABLE',
          `The plan cannot be changed while the subscription is ${status}.`,
        );
      }
      const now = this.#clock.now();
      const nowIso = this.#clock.nowISO();
      const length = Date.parse(stored.periodEnd) - Date.parse(stored.periodStart);
      const remaining = Date.parse(stored.periodEnd) - now;
      const oldAmount = stored.unitAmount * stored.quantity;
      const newAmount = input.unitAmount * stored.quantity;
      // Nothing has been billed during a trial, or for a period that began
      // while recovery was running, so there is nothing to prorate: crediting
      // it would pay back time nobody paid for.
      const prorating = status !== 'trialing' && stored.periodBilled !== false;
      const credit = prorating ? prorate(oldAmount, remaining, length) : 0;
      const charge = prorating ? prorate(newAmount, remaining, length) : 0;
      const net = charge - credit;

      const plan = await this.#engine.createPlan({
        provider: PROVIDER,
        name: input.productName,
        amount: input.unitAmount,
        currency: stored.currency,
        interval: INTERVALS[input.cycle.interval],
        intervalCount: input.cycle.frequency,
        productId: input.productEngineId,
        providerPlanCode: `${derivedId('price', `price:${input.productId}:${stored.currency}`, 24)}:${stored.id}:${nowIso}`,
        metadata: { bachs_product_id: input.productId },
      });
      const oldPlanId = core.planId;
      let next: StoredSubscription = {
        ...stored,
        productId: input.productId,
        priceId: derivedId('price', `price:${input.productId}:${stored.currency}`, 24),
        overridePrice: false,
        unitAmount: input.unitAmount,
        priceCreatedAt: nowIso,
        updatedAt: nowIso,
      };
      if (input.behaviour === 'next_cycle' && net > 0) {
        next = { ...next, deferredProration: next.deferredProration + net };
      }
      const items = await this.#storage.subscriptionItems.listBySubscription(core.id);
      await this.#updated(next, core, async (tx) => {
        await tx.subscriptions.update(core.id, { planId: plan.id, amount: newAmount, updatedAt: nowIso });
        for (const item of items) await tx.subscriptionItems.update(item.id, { planId: plan.id, updatedAt: nowIso });
      });

      if (net < 0 && input.behaviour !== 'none') {
        await withLock(creditLock(stored.customerId, stored.currency), () =>
          this.state.credit.append(stored.customerId, stored.currency, {
            amount: -net,
            reason: 'downgrade',
            invoiceEngineId: null,
            subscriptionId: stored.id,
            at: nowIso,
          }),
        );
      }
      if (input.behaviour !== 'invoice_now' || net <= 0) return;

      // "an upgrade is charged now on a one-off invoice"
      const fresh = (await this.#load(stored.id))!;
      const invoice = await this.#raiseInvoice(fresh.stored, fresh.core, {
        kind: 'proration',
        billingReason: 'subscription_update',
        periodStart: nowIso,
        periodEnd: stored.periodEnd,
        applyCredit: true,
        lines: [
          {
            planId: plan.id,
            description: `Remaining time on ${input.productName}`,
            amount: charge,
            currency: stored.currency,
            proration: true,
            periodStart: nowIso,
            periodEnd: stored.periodEnd,
          },
          {
            planId: oldPlanId,
            description: 'Unused time on the previous plan',
            amount: -credit,
            currency: stored.currency,
            proration: true,
            periodStart: nowIso,
            periodEnd: stored.periodEnd,
          },
        ],
      });
      await this.#collectFirst(stored.id, invoice);
    });
  }

  /** Recovery payment from the portal: a new card, saved, made the subscription's, and charged. */
  async recoverWithCard(subscriptionId: string, method: StoredPaymentMethod): Promise<void> {
    await this.withSubscription(subscriptionId, async (stored, core) => {
      // Checked here, under the lock: recovery may have run out meanwhile,
      // and "a later payment can't revive" a canceled subscription.
      const status = this.statusOf(stored, core);
      if (status !== 'past_due' && status !== 'unpaid') {
        throw fail('invalid_state_transition', 'SUBSCRIPTION_NOT_MODIFIABLE', 'Nothing is owed on this subscription.');
      }
      const next = { ...stored, paymentMethodId: method.id, updatedAt: this.#clock.nowISO() };
      await this.#updated(next, core, async (tx) => {
        await tx.subscriptions.update(core.id, { authorizationId: method.engineId, updatedAt: this.#clock.nowISO() });
      });
      await this.#retryNow(next);
    });
  }

  #assertModifiable(stored: StoredSubscription, core: Subscription): void {
    if (this.statusOf(stored, core) === 'canceled') {
      throw fail(
        'validation_failed',
        'SUBSCRIPTION_NOT_MODIFIABLE',
        'The subscription cannot be modified in its current status.',
      );
    }
  }

  async #scheduleRenewal(stored: StoredSubscription, dueAt: string): Promise<void> {
    await this.#enqueue(BACHS_SUBSCRIPTION_RENEW_JOB, stored.id, dueAt, { subscriptionId: stored.id, dueAt });
  }

  async #enqueue(kind: string, subscriptionId: string, runAt: string, payload: Record<string, unknown>): Promise<void> {
    const now = this.#clock.nowISO();
    await this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind,
      payload,
      status: 'ready',
      runAt: Date.parse(runAt) > this.#clock.now() ? runAt : now,
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `bachs-subscription:${subscriptionId}`,
      createdAt: now,
      updatedAt: now,
    });
  }
}

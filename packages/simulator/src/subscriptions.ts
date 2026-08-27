import {
  PayboxError,
  type Clock,
  type IdFactory,
  type Invoice,
  type Subscription,
} from '@paybox/shared';
import {
  addInterval,
  isRenewable,
  type Job,
  type PaymentEngine,
  type Storage,
} from '@paybox/core';
import type { PaymentSimulator } from './simulator.js';
import { authorizationChargeDetails, authorizationOutcome } from './authorizations.js';

/** Raise the invoice for an upcoming debit. */
export const SUBSCRIPTION_INVOICE_JOB = 'subscription.invoice';
/** Debit the instrument for an invoice that is now due. */
export const SUBSCRIPTION_CHARGE_JOB = 'subscription.charge';

/**
 * How far ahead of the debit the invoice is raised.
 *
 * Paystack documents sending `invoice.create` three days before the next
 * payment date, giving the merchant a window to react before money moves.
 * Verified 2026-08-27 against Paystack's subscription documentation.
 */
const INVOICE_LEAD_MS = 3 * 24 * 60 * 60_000;

export interface SubscriptionRunnerDeps {
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  engine: PaymentEngine;
  simulator: PaymentSimulator;
}

/**
 * Recurring billing over virtual time.
 *
 * There is no cron and no recurrence primitive: each cycle's handler enqueues
 * the next one, exactly the way a failed webhook schedules its own retry. That
 * works because `Scheduler` runs every job inside `VirtualClock#at`, so the
 * handler's `clock.now()` is the instant the job was *due* rather than
 * whatever time the clock has since reached. A single `time advance 1y` on a
 * monthly plan therefore produces twelve renewals with twelve correct dates,
 * not twelve renewals all stamped at the end of the advance.
 *
 * Renewals go through `PaymentEngine.createPayment` and the ordinary
 * transition path -- never a shortcut -- so a renewal appends the same events
 * and fires the same `charge.success` webhook as any other payment.
 */
export class SubscriptionRunner {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #engine: PaymentEngine;
  readonly #simulator: PaymentSimulator;

  constructor(deps: SubscriptionRunnerDeps) {
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#engine = deps.engine;
    this.#simulator = deps.simulator;
  }

  /** Schedule the first billing cycle for a freshly created subscription. */
  async start(subscription: Subscription): Promise<void> {
    if (!subscription.nextPaymentDate) return;
    await this.#scheduleCycle(subscription.id, subscription.nextPaymentDate);
  }

  /**
   * Raise the invoice for the upcoming debit.
   *
   * Separate from the charge so `invoice.create` genuinely arrives ahead of
   * the money moving, which is the notice a merchant integrates against.
   */
  handleInvoiceJob = async (job: Job): Promise<void> => {
    const subscriptionId = String(job.payload.subscriptionId ?? '');
    const dueAt = String(job.payload.dueAt ?? '');
    if (!subscriptionId || !dueAt) return;

    const subscription = await this.#storage.subscriptions.byId(subscriptionId);
    if (!subscription || !isRenewable(subscription.status)) return;

    // An invoice already raised for this period means the job ran twice.
    if (await this.#invoiceForPeriod(subscriptionId, dueAt)) return;
    if (await this.#completeIfLimitReached(subscription)) return;

    await this.#raiseInvoice(subscription, dueAt);
  };

  /** Debit the instrument for an invoice that has come due. */
  handleChargeJob = async (job: Job): Promise<void> => {
    const subscriptionId = String(job.payload.subscriptionId ?? '');
    const dueAt = String(job.payload.dueAt ?? '');
    if (!subscriptionId || !dueAt) return;

    let subscription = await this.#storage.subscriptions.byId(subscriptionId);
    if (!subscription || !isRenewable(subscription.status)) return;

    const plan = await this.#storage.plans.byId(subscription.planId);
    if (!plan) return;

    // Normally the invoice job raised this already. It will not have when the
    // subscription started immediately, leaving no room for the lead time.
    let invoice = await this.#invoiceForPeriod(subscriptionId, dueAt);
    if (!invoice) {
      if (await this.#completeIfLimitReached(subscription)) return;
      invoice = await this.#raiseInvoice(subscription, dueAt);
      subscription = (await this.#storage.subscriptions.byId(subscriptionId)) ?? subscription;
    }

    const authorization = await this.#storage.authorizations.byId(subscription.authorizationId);
    if (!authorization) {
      await this.#engine.transitionInvoice(invoice.id, 'failed');
      await this.#moveToAttention(subscription);
      return;
    }

    const payment = await this.#engine.createPayment({
      provider: subscription.provider,
      amount: invoice.amount,
      currency: invoice.currency,
      reference: `${subscription.providerSubscriptionCode}-${invoice.providerInvoiceCode}`,
      customerId: subscription.customerId,
      paymentMethod: authorization.channel,
      paymentMethodDetails: authorizationChargeDetails(authorization),
      metadata: {
        subscription_code: subscription.providerSubscriptionCode,
        invoice_code: invoice.providerInvoiceCode,
        plan_code: plan.providerPlanCode,
      },
      status: 'pending',
    });

    const settled = await this.#simulator.apply(payment.id, authorizationOutcome(authorization));

    if (settled.status === 'successful') {
      await this.#engine.transitionInvoice(invoice.id, 'success', { paymentId: settled.id });
      await this.#advanceToNextCycle(subscription, plan.interval, dueAt);
      return;
    }

    // Anything that did not settle -- a decline, or a card that parked
    // awaiting a step-up the customer is not there to complete -- is a failed
    // renewal. `invoice.payment_failed` fires and the merchant has to act.
    await this.#engine.transitionInvoice(invoice.id, 'failed', { paymentId: settled.id });
    await this.#moveToAttention(subscription);
    await this.#advanceToNextCycle(subscription, plan.interval, dueAt);
  };

  /* ---------------------------------------------------------------- */

  async #raiseInvoice(subscription: Subscription, dueAt: string): Promise<Invoice> {
    const plan = await this.#storage.plans.byId(subscription.planId);
    if (!plan) {
      throw new PayboxError('not_found', `No plan with id ${subscription.planId}.`);
    }
    return this.#engine.createInvoice({
      subscriptionId: subscription.id,
      periodStart: dueAt,
      periodEnd: addInterval(dueAt, plan.interval),
      dueAt,
    });
  }

  async #invoiceForPeriod(subscriptionId: string, dueAt: string): Promise<Invoice | null> {
    const invoices = await this.#storage.invoices.listBySubscription(subscriptionId);
    return invoices.find((invoice) => invoice.periodStart === dueAt) ?? null;
  }

  /**
   * Stop renewing once the plan's invoice limit is reached.
   *
   * `invoiceLimit` of 0 means "no limit", matching Paystack, where an absent
   * limit is an open-ended subscription.
   */
  async #completeIfLimitReached(subscription: Subscription): Promise<boolean> {
    if (subscription.invoiceLimit <= 0) return false;
    if (subscription.invoiceCount < subscription.invoiceLimit) return false;
    await this.#engine.transitionSubscription(subscription.id, 'completed');
    return true;
  }

  async #moveToAttention(subscription: Subscription): Promise<void> {
    if (subscription.status === 'attention') return;
    await this.#engine.transitionSubscription(subscription.id, 'attention', {
      nextPaymentDate: subscription.nextPaymentDate,
    });
  }

  async #advanceToNextCycle(
    subscription: Subscription,
    interval: Parameters<typeof addInterval>[1],
    dueAt: string,
  ): Promise<void> {
    const current = await this.#storage.subscriptions.byId(subscription.id);
    if (!current || !isRenewable(current.status)) return;

    if (current.invoiceLimit > 0 && current.invoiceCount >= current.invoiceLimit) {
      await this.#engine.transitionSubscription(current.id, 'completed');
      return;
    }

    // Advance from the date this cycle was due, not from the clock. They are
    // the same instant during a normal run, but deriving from the due date is
    // what stops a long `time advance` collapsing later cycles onto one date.
    const next = addInterval(dueAt, interval);
    await this.#storage.subscriptions.update(current.id, {
      nextPaymentDate: next,
      updatedAt: this.#clock.nowISO(),
    });
    await this.#scheduleCycle(current.id, next);
  }

  async #scheduleCycle(subscriptionId: string, dueAt: string): Promise<void> {
    const now = this.#clock.now();
    const due = Date.parse(dueAt);
    const payload = { subscriptionId, dueAt };
    const group = `subscription:${subscriptionId}`;

    // Only raise the invoice ahead of time when there is time to be ahead of.
    const invoiceAt = due - INVOICE_LEAD_MS;
    if (invoiceAt > now) {
      await this.#enqueue(SUBSCRIPTION_INVOICE_JOB, payload, new Date(invoiceAt).toISOString(), group);
    }
    await this.#enqueue(
      SUBSCRIPTION_CHARGE_JOB,
      payload,
      new Date(Math.max(due, now)).toISOString(),
      group,
    );
  }

  async #enqueue(
    kind: string,
    payload: Record<string, unknown>,
    runAt: string,
    groupKey: string,
  ): Promise<void> {
    const now = this.#clock.nowISO();
    await this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind,
      payload,
      status: 'ready',
      runAt,
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey,
      createdAt: now,
      updatedAt: now,
    });
  }
}

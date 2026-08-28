import {
  PayboxError,
  isSupportedCurrency,
  type Authorization,
  type Clock,
  type Customer,
  type DedicatedAccount,
  type Dispute,
  type DisputeResolution,
  type DisputeStatus,
  type IdFactory,
  type InstrumentSetup,
  type Invoice,
  type InvoiceItem,
  type InvoiceStatus,
  type LedgerEntry,
  type Metadata,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type PayboxEvent,
  type Plan,
  type PlanInterval,
  type Product,
  type ProviderId,
  type Refund,
  type RefundStatus,
  type SetupStatus,
  type Split,
  type Subaccount,
  type Subscription,
  type SubscriptionItem,
  type SubscriptionStatus,
  type Transfer,
  type TransferStatus,
} from '@paybox/shared';
import type { Job, Storage } from './ports.js';
import { EventBus } from './event-bus.js';
import {
  assertDisputeTransition,
  assertInvoiceTransition,
  assertPaymentTransition,
  assertRefundTransition,
  assertRefundable,
  assertSetupTransition,
  assertSubscriptionTransition,
  assertTransferTransition,
  isTerminalPayment,
  refundedStatus,
} from './state-machine.js';

export interface CreatePaymentInput {
  provider: ProviderId;
  amount: number;
  currency: string;
  reference?: string;
  providerTransactionId?: string;
  paymentMethod?: PaymentMethod | null;
  paymentMethodDetails?: Metadata;
  customerId?: string | null;
  callbackUrl?: string | null;
  metadata?: Metadata;
  /** Initial canonical status. Defaults to `created`. */
  status?: PaymentStatus;
  /** Verbatim provider status string to echo back at the API boundary. */
  providerStatus?: string;
  /** Schedules a `payment.expire` job. Paystack links, Stripe intents and
   *  mobile-money prompts all expire; modelling it is the point (spec §39). */
  expiresInMs?: number | null;
}

export interface CreateRefundInput {
  paymentId: string;
  amount?: number;
  reason?: string | null;
  metadata?: Metadata;
  /** Refunds are asynchronous at every provider we emulate. */
  status?: RefundStatus;
}

export interface TransitionRefundOptions {
  reason?: string | null;
  accountDetails?: Metadata | null;
}

export interface TransitionOptions {
  providerStatus?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  paymentMethod?: PaymentMethod | null;
  paymentMethodDetails?: Metadata;
  /** Explicitly simulate a provider reversing a terminal decision (spec §7). */
  reversal?: boolean;
  /**
   * Attempt a failed payment again on the same resource.
   *
   * Only meaningful for providers whose failures are not final; see
   * `TransitionContext.retry`.
   */
  retry?: boolean;
  /** Extra payload merged into the emitted event. */
  eventData?: Metadata;
}

/**
 * Translates a canonical status into the provider's own vocabulary.
 *
 * Injected rather than imported so the engine never learns that Paystack says
 * "success" where Stripe says "succeeded". Each adapter owns its mapping; the
 * composition root wires them together. Defaults to the identity function.
 */
export type ProviderStatusResolver = (provider: ProviderId, status: PaymentStatus) => string;

/**
 * The instrument fragments an adapter wants preserved when a payment succeeds.
 *
 * Everything here is either masked or synthetic. There is deliberately no
 * field that could hold a PAN or a CVV (spec §29).
 */
export interface AuthorizationDraft {
  channel: PaymentMethod;
  /** Whether this instrument can be charged again without the customer. */
  reusable: boolean;
  providerAuthorizationCode?: string;
  bin?: string | null;
  last4?: string | null;
  expMonth?: string | null;
  expYear?: string | null;
  cardType?: string | null;
  bank?: string | null;
  brand?: string | null;
  countryCode?: string | null;
  /** Stable per instrument. Non-null signatures dedupe; null ones never do. */
  signature?: string | null;
  accountName?: string | null;
  mobileMoneyNumber?: string | null;
  metadata?: Metadata;
}

/**
 * Turns a settled payment into the authorization its provider would mint, or
 * null if that provider mints nothing for this channel.
 *
 * Injected for the same reason as `ProviderStatusResolver`: deciding that a
 * card is reusable and a mobile-money prompt is not is provider knowledge, and
 * the engine must not acquire it (spec §30).
 */
export type AuthorizationMinter = (payment: Payment) => AuthorizationDraft | null;

/**
 * Turns a completed instrument setup into the stored instrument its provider
 * would mint.
 *
 * Same injection as `AuthorizationMinter`, and for the same reason: which
 * fragments a provider keeps, and whether the result may be charged
 * off-session, is provider knowledge the engine must not acquire (spec §30).
 * The setup path needs its own because a setup has no payment to derive from --
 * that is the entire point of it.
 */
/**
 * A line to put on an invoice.
 *
 * Everything is optional that can be inherited from the invoice it lands on,
 * so a caller adding a line to an existing draft supplies only what differs.
 */
export interface InvoiceItemDraft {
  provider?: ProviderId;
  customerId?: string;
  subscriptionId?: string | null;
  planId?: string | null;
  description?: string | null;
  /** Signed. Defaults to `unitAmount * quantity`. Negative is a credit. */
  amount?: number;
  currency?: string;
  quantity?: number;
  unitAmount?: number;
  periodStart?: string;
  periodEnd?: string;
  proration?: boolean;
  metadata?: Metadata;
}

/**
 * What to do about the part-period difference when a subscription changes.
 *
 * Stripe's own vocabulary, because these are the three genuinely different
 * answers and inventing a fourth would not help anyone.
 */
export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';

function sumItems(items: readonly InvoiceItemDraft[]): number {
  return items.reduce(
    (total, item) => total + (item.amount ?? (item.unitAmount ?? 0) * (item.quantity ?? 1)),
    0,
  );
}

export type SetupAuthorizationMinter = (setup: InstrumentSetup) => AuthorizationDraft | null;

export interface EngineDeps {
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  bus: EventBus;
  providerStatus?: ProviderStatusResolver;
  mintAuthorization?: AuthorizationMinter;
  /** Mints the instrument a completed setup produced. */
  mintSetupAuthorization?: SetupAuthorizationMinter;
  /**
   * Refuse a transfer that the balance cannot cover.
   *
   * On by default, because that is what a provider does. The opening float
   * below is what stops it being infuriating: a fresh emulator can pay out
   * before it has collected anything.
   */
  enforceBalance?: boolean;
  /**
   * Starting test float per currency, in minor units.
   *
   * Not a ledger row: keeping it out of the table means `paybox reset` cannot
   * wipe it, and the ledger stays a pure record of what this run actually did.
   */
  openingBalance?: number;
}

/**
 * The provider-independent payment engine (spec §2, §46).
 *
 * Nothing in this file knows that Paystack or Stripe exist beyond the
 * `provider` discriminator on a row. Adapters translate their wire format into
 * these calls and translate the results back out. All state changes go through
 * `transitionPayment`, so the state machine and the event log cannot be
 * bypassed.
 */
export class PaymentEngine {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #bus: EventBus;
  readonly #providerStatus: ProviderStatusResolver;
  readonly #mintAuthorization: AuthorizationMinter;
  readonly #mintSetupAuthorization: SetupAuthorizationMinter;
  readonly #enforceBalance: boolean;
  readonly #openingBalance: number;

  constructor(deps: EngineDeps) {
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#bus = deps.bus;
    this.#providerStatus = deps.providerStatus ?? ((_provider, status) => status);
    this.#mintAuthorization = deps.mintAuthorization ?? (() => null);
    this.#mintSetupAuthorization = deps.mintSetupAuthorization ?? (() => null);
    this.#enforceBalance = deps.enforceBalance ?? true;
    this.#openingBalance = deps.openingBalance ?? 0;
  }

  /* ---------------------------------------------------------------- *
   * Payments
   * ---------------------------------------------------------------- */

  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    validateAmount(input.amount);
    if (!isSupportedCurrency(input.currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `Currency ${input.currency} is not supported by the emulator.`,
        { details: { currency: input.currency } },
      );
    }

    const now = this.#clock.nowISO();
    const reference = input.reference ?? this.#ids.token(16);

    const existing = await this.#storage.payments.byReference(input.provider, reference);
    if (existing) {
      throw new PayboxError(
        'duplicate_reference',
        `Reference "${reference}" has already been used for ${input.provider}.`,
        { details: { reference, paymentId: existing.id } },
      );
    }

    const status = input.status ?? 'created';
    const payment: Payment = {
      id: this.#ids.next('pay'),
      provider: input.provider,
      reference,
      providerTransactionId: input.providerTransactionId ?? this.#ids.token(12),
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      status,
      providerStatus: input.providerStatus ?? this.#providerStatus(input.provider, status),
      paymentMethod: input.paymentMethod ?? null,
      paymentMethodDetails: input.paymentMethodDetails ?? {},
      customerId: input.customerId ?? null,
      callbackUrl: input.callbackUrl ?? null,
      amountRefunded: 0,
      failureCode: null,
      failureMessage: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      expiresAt:
        input.expiresInMs != null
          ? new Date(this.#clock.now() + input.expiresInMs).toISOString()
          : null,
      authorizedAt: null,
      paidAt: null,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.payments.insert(payment);
      const event = await this.#appendEvent(tx, {
        type: `payment.${status}`,
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'payment',
        data: paymentEventData(created),
        previousStatus: null,
        currentStatus: created.status,
      });
      return { result: created, events: [event] };
    });

    if (result.expiresAt) {
      await this.#enqueue({
        kind: 'payment.expire',
        payload: { paymentId: result.id },
        runAt: result.expiresAt,
        groupKey: `payment:${result.id}`,
      });
    }

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * The single mutation path for payment state. Every status change in the
   * system -- from an adapter, the CLI, the dashboard, a scenario step, or an
   * expiry job -- lands here, which is what guarantees the state machine and
   * the event log can never be sidestepped.
   */
  async transitionPayment(
    paymentId: string,
    to: PaymentStatus,
    options: TransitionOptions = {},
  ): Promise<Payment> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const payment = await this.#requirePayment(tx, paymentId);
      assertPaymentTransition(payment.status, to, {
        reversal: options.reversal,
        retry: options.retry,
      });

      const now = this.#clock.nowISO();
      const patch: Partial<Payment> = {
        status: to,
        // An explicit provider status wins; otherwise ask the adapter's mapper
        // so the stored value is the string that provider would actually use.
        providerStatus: options.providerStatus ?? this.#providerStatus(payment.provider, to),
        updatedAt: now,
      };
      if (options.failureCode !== undefined) patch.failureCode = options.failureCode;
      if (options.failureMessage !== undefined) patch.failureMessage = options.failureMessage;
      if (options.paymentMethod !== undefined) patch.paymentMethod = options.paymentMethod;
      if (options.paymentMethodDetails !== undefined) {
        patch.paymentMethodDetails = {
          ...payment.paymentMethodDetails,
          ...options.paymentMethodDetails,
        };
      }
      if (to === 'authorized') patch.authorizedAt = now;
      if (to === 'successful') {
        patch.paidAt = now;
        // Clear any earlier failure: after a reversal or a retry the payment
        // did succeed, and leaving a stale decline reason on the row would
        // misreport it everywhere it is displayed.
        if (options.failureCode === undefined) {
          patch.failureCode = null;
          patch.failureMessage = null;
        }
      }

      const updated = await tx.payments.update(paymentId, patch);
      const emitted: PayboxEvent[] = [
        await this.#appendEvent(tx, {
          type: `payment.${to}`,
          provider: updated.provider,
          resourceId: updated.id,
          resourceType: 'payment',
          data: { ...paymentEventData(updated), ...(options.eventData ?? {}) },
          previousStatus: payment.status,
          currentStatus: to,
        }),
      ];

      // Mint the reusable handle in the same transaction as the state change,
      // so a committed success can never leave a missing authorization behind.
      if (to === 'successful') {
        const minted = await this.#mintFor(tx, updated);
        if (minted) emitted.push(minted);

        // Money collected lands in the balance. Inside the transaction, so a
        // rolled-back success cannot leave a phantom credit behind.
        await this.#ledgerIn(tx, 'credit', {
          provider: updated.provider,
          currency: updated.currency,
          amount: updated.amount,
          reason: 'charge',
          resourceId: updated.id,
        });
      }

      return { result: updated, events: emitted };
    });

    // A payment that has reached a terminal state must not be expired later by
    // a job scheduled at creation time.
    if (isTerminalPayment(to) || to === 'successful') {
      await this.#storage.jobs.cancelGroup(`payment:${paymentId}`);
    }

    await this.#bus.emitAll(events);
    return result;
  }

  async getPayment(id: string): Promise<Payment | null> {
    return this.#storage.payments.byId(id);
  }

  /** Accepts a canonical id, a provider transaction id, or a reference. */
  async resolvePayment(provider: ProviderId, handle: string): Promise<Payment | null> {
    return (
      (await this.#storage.payments.byId(handle)) ??
      (await this.#storage.payments.byReference(provider, handle)) ??
      (await this.#storage.payments.byProviderTransactionId(provider, handle))
    );
  }

  /** Spec §23: the full ordered history behind a payment. */
  async getTimeline(paymentId: string): Promise<PayboxEvent[]> {
    return this.#storage.events.listByResource(paymentId);
  }

  /* ---------------------------------------------------------------- *
   * Refunds (spec §18)
   * ---------------------------------------------------------------- */

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    const { result, events } = await this.#storage.transaction((tx) =>
      this.#createRefundIn(tx, input),
    );
    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * The body of `createRefund`, bound to an open transaction.
   *
   * Split out so that operations which must be atomic *with* a refund --
   * resolving a dispute in the customer's favour, for one -- can compose it
   * instead of nesting a second transaction. `Storage.transaction` is
   * reentrant only for the same instance; the engine holds the root storage,
   * so calling the public method from inside a transaction would take the
   * write lock twice and deadlock.
   */
  async #createRefundIn(
    tx: Storage,
    input: CreateRefundInput,
  ): Promise<{ result: Refund; events: PayboxEvent[] }> {
    const payment = await this.#requirePayment(tx, input.paymentId);

    if (payment.status !== 'successful' && payment.status !== 'partially_refunded') {
      throw new PayboxError(
        'invalid_state_transition',
        `Only a successful payment can be refunded; this one is ${payment.status}.`,
        { details: { paymentId: payment.id, status: payment.status } },
      );
    }

    const alreadyRefunded = await tx.refunds.totalRefunded(payment.id);
    const amount = input.amount ?? payment.amount - alreadyRefunded;
    assertRefundable(payment.amount, alreadyRefunded, amount);

    const now = this.#clock.nowISO();
    const status = input.status ?? 'pending';
    const refund: Refund = {
      id: this.#ids.next('ref'),
      paymentId: payment.id,
      provider: payment.provider,
      providerRefundId: this.#ids.token(12),
      amount,
      currency: payment.currency,
      status,
      providerStatus: status,
      reason: input.reason ?? null,
      accountDetails: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const created = await tx.refunds.insert(refund);
    const event = await this.#appendEvent(tx, {
      type: 'refund.created',
      provider: created.provider,
      resourceId: created.id,
      resourceType: 'refund',
      data: refundEventData(created, payment),
      previousStatus: null,
      currentStatus: created.status,
    });
    return { result: created, events: [event] };
  }

  async transitionRefund(
    refundId: string,
    to: RefundStatus,
    options: TransitionRefundOptions = {},
  ): Promise<Refund> {
    const { result, events } = await this.#storage.transaction((tx) =>
      this.#transitionRefundIn(tx, refundId, to, options),
    );
    await this.#bus.emitAll(events);
    return result;
  }

  /** The body of `transitionRefund`, bound to an open transaction. */
  async #transitionRefundIn(
    tx: Storage,
    refundId: string,
    to: RefundStatus,
    options: TransitionRefundOptions = {},
  ): Promise<{ result: Refund; events: PayboxEvent[] }> {
    const refund = await tx.refunds.byId(refundId);
    if (!refund) {
      throw new PayboxError('not_found', `No refund with id ${refundId}.`);
    }
    assertRefundTransition(refund.status, to);

    const now = this.#clock.nowISO();
    const updated = await tx.refunds.update(refundId, {
      status: to,
      providerStatus: to,
      updatedAt: now,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.accountDetails !== undefined
        ? { accountDetails: options.accountDetails }
        : {}),
    });

    const emitted: PayboxEvent[] = [
      await this.#appendEvent(tx, {
        type: `refund.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'refund',
        data: { id: updated.id, payment_id: updated.paymentId, amount: updated.amount },
        previousStatus: refund.status,
        currentStatus: to,
      }),
    ];

    if (to === 'successful') {
      const payment = await this.#requirePayment(tx, updated.paymentId);
      const totalRefunded = await tx.refunds.totalRefunded(payment.id);
      const nextStatus = refundedStatus(payment.amount, totalRefunded);
      assertPaymentTransition(payment.status, nextStatus);

      const updatedPayment = await tx.payments.update(payment.id, {
        status: nextStatus,
        providerStatus: this.#providerStatus(payment.provider, nextStatus),
        amountRefunded: totalRefunded,
        updatedAt: now,
      });

      // Refunded money leaves the balance.
      await this.#ledgerIn(tx, 'debit', {
        provider: updated.provider,
        currency: updated.currency,
        amount: updated.amount,
        reason: 'refund',
        resourceId: updated.id,
      });
      emitted.push(
        await this.#appendEvent(tx, {
          type: `payment.${nextStatus}`,
          provider: updatedPayment.provider,
          resourceId: updatedPayment.id,
          resourceType: 'payment',
          data: { ...paymentEventData(updatedPayment), refund_id: updated.id },
          previousStatus: payment.status,
          currentStatus: nextStatus,
        }),
      );
    }

    return { result: updated, events: emitted };
  }

  /* ---------------------------------------------------------------- *
   * Transfers (spec §19)
   * ---------------------------------------------------------------- */

  async createTransfer(input: {
    provider: ProviderId;
    amount: number;
    currency: string;
    reference?: string;
    recipientName?: string | null;
    recipientAccount?: string | null;
    recipientBankCode?: string | null;
    reason?: string | null;
    metadata?: Metadata;
    status?: TransferStatus;
    /**
     * Processing fee the provider also holds against the balance.
     *
     * Supplied by the adapter, never computed here: fee schedules are provider
     * pricing and the engine must not learn them (spec §30).
     */
    fee?: number;
    /**
     * Whether a failed transfer gets its fee back.
     *
     * Also the adapter's call. Some providers keep the fee whatever the
     * outcome -- Paystack's South African pricing says "per transfer (failed
     * or successful)" -- and the engine has no business knowing which.
     * Defaults to refundable.
     */
    feeRefundable?: boolean;
  }): Promise<Transfer> {
    validateAmount(input.amount);
    const now = this.#clock.nowISO();
    const status = input.status ?? 'created';
    const transfer: Transfer = {
      id: this.#ids.next('trf'),
      provider: input.provider,
      providerTransferId: this.#ids.token(12),
      reference: input.reference ?? this.#ids.token(16),
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      status,
      providerStatus: status,
      recipientName: input.recipientName ?? null,
      recipientAccount: input.recipientAccount ?? null,
      recipientBankCode: input.recipientBankCode ?? null,
      reason: input.reason ?? null,
      failureReason: null,
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.fee
          ? {
              fee: Math.max(0, Math.trunc(input.fee)),
              fee_refundable: input.feeRefundable !== false,
            }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      // Check and reserve inside one transaction, so two transfers racing for
      // the same funds cannot both pass the check.
      //
      // The fee is part of both halves: Paystack checks for "the transfer
      // amount plus the transfer fee" and deducts both, so checking the amount
      // alone would let a transfer through that the provider would refuse.
      const fee = Math.max(0, Math.trunc(input.fee ?? 0));
      const required = transfer.amount + fee;
      if (this.#enforceBalance) {
        const net = await tx.ledger.net(transfer.provider, transfer.currency);
        const available = this.#openingBalance + net;
        if (required > available) {
          throw new PayboxError(
            'insufficient_funds',
            `Transfer of ${transfer.amount} plus a fee of ${fee} exceeds the ` +
              `available balance of ${available} ${transfer.currency}.`,
            {
              details: {
                amount: transfer.amount,
                fee,
                required,
                available,
                currency: transfer.currency,
              },
            },
          );
        }
      }

      const created = await tx.transfers.insert(transfer);
      // Reserve immediately rather than on success: a queued payout has
      // already committed the funds, and waiting would let a second transfer
      // spend the same money.
      await this.#ledgerIn(tx, 'debit', {
        provider: created.provider,
        currency: created.currency,
        amount: required,
        reason: 'transfer',
        resourceId: created.id,
      });

      const event = await this.#appendEvent(tx, {
        type: `transfer.${status}`,
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'transfer',
        data: transferEventData(created),
        previousStatus: null,
        currentStatus: created.status,
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async transitionTransfer(
    transferId: string,
    to: TransferStatus,
    options: { failureReason?: string | null } = {},
  ): Promise<Transfer> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const transfer = await tx.transfers.byId(transferId);
      if (!transfer) {
        throw new PayboxError('not_found', `No transfer with id ${transferId}.`);
      }
      assertTransferTransition(transfer.status, to);
      const updated = await tx.transfers.update(transferId, {
        status: to,
        providerStatus: to,
        updatedAt: this.#clock.nowISO(),
        ...(options.failureReason !== undefined
          ? { failureReason: options.failureReason }
          : {}),
      });

      // A payout that did not happen releases what it reserved. The fee comes
      // back only where the provider gives it back -- keeping a
      // non-refundable fee is the whole point of the flag.
      if (to === 'failed' || to === 'reversed') {
        const reservedFee = Math.max(0, Math.trunc(Number(updated.metadata.fee ?? 0)));
        const refundable = updated.metadata.fee_refundable !== false;
        await this.#ledgerIn(tx, 'credit', {
          provider: updated.provider,
          currency: updated.currency,
          amount: updated.amount + (refundable ? reservedFee : 0),
          reason: `transfer_${to}`,
          resourceId: updated.id,
        });
      }
      const event = await this.#appendEvent(tx, {
        type: `transfer.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'transfer',
        data: transferEventData(updated),
        previousStatus: transfer.status,
        currentStatus: to,
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Customers (spec §20)
   * ---------------------------------------------------------------- */

  async createCustomer(input: {
    provider: ProviderId;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    metadata?: Metadata;
    providerCustomerId?: string;
  }): Promise<Customer> {
    const existing = await this.#storage.customers.byEmail(input.provider, input.email);
    if (existing) return existing;

    const now = this.#clock.nowISO();
    const customer: Customer = {
      id: this.#ids.next('cus'),
      provider: input.provider,
      providerCustomerId: input.providerCustomerId ?? this.#ids.token(12),
      email: input.email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.customers.insert(customer);
      const event = await this.#appendEvent(tx, {
        type: 'customer.created',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'customer',
        data: { id: created.id, email: created.email },
        previousStatus: null,
        currentStatus: null,
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async updateCustomer(id: string, patch: Partial<Customer>): Promise<Customer> {
    return this.#storage.customers.update(id, {
      ...patch,
      updatedAt: this.#clock.nowISO(),
    });
  }

  /* ---------------------------------------------------------------- *
   * Authorizations (spec §5)
   * ---------------------------------------------------------------- */

  async getAuthorization(id: string): Promise<Authorization | null> {
    return this.#storage.authorizations.byId(id);
  }

  /** Accepts a canonical id or the provider's own code. */
  async resolveAuthorization(
    provider: ProviderId,
    handle: string,
  ): Promise<Authorization | null> {
    return (
      (await this.#storage.authorizations.byCode(provider, handle)) ??
      (await this.#storage.authorizations.byId(handle))
    );
  }

  /**
   * Assert an authorization may be charged right now.
   *
   * Both refusals model real provider behaviour rather than emulator
   * bookkeeping: a deactivated code is dead at the provider, and a
   * non-reusable one (mobile money, most bank debits) needs the customer to
   * approve each prompt, so charging it off-session is not a thing that can
   * work. Discovering that here is the whole point.
   */
  assertChargeable(authorization: Authorization): void {
    if (!authorization.active) {
      throw new PayboxError(
        'authentication_failed',
        `Authorization ${authorization.providerAuthorizationCode} has been deactivated.`,
        { details: { authorizationId: authorization.id } },
      );
    }
    if (!authorization.reusable) {
      throw new PayboxError(
        'unsupported_operation',
        `Authorization ${authorization.providerAuthorizationCode} is not reusable; ` +
          `${authorization.channel} requires the customer to approve every charge.`,
        { details: { authorizationId: authorization.id, channel: authorization.channel } },
      );
    }
  }

  /**
   * Create a reusable instrument with no payment behind it.
   *
   * Paystack only ever mints an authorization as a side effect of a successful
   * charge, which `#mintFor` handles. Stripe lets a PaymentMethod be created
   * outright and attached to a customer later, so the engine needs a way in
   * that does not start from a payment.
   */
  async createAuthorizationRecord(input: {
    provider: ProviderId;
    channel: PaymentMethod;
    reusable: boolean;
    customerId?: string | null;
    paymentId?: string | null;
    providerAuthorizationCode?: string;
    bin?: string | null;
    last4?: string | null;
    expMonth?: string | null;
    expYear?: string | null;
    cardType?: string | null;
    bank?: string | null;
    brand?: string | null;
    countryCode?: string | null;
    signature?: string | null;
    accountName?: string | null;
    mobileMoneyNumber?: string | null;
    metadata?: Metadata;
  }): Promise<Authorization> {
    // A supplied signature asserts "this identifies the instrument", so the
    // same card reaching the engine by two doors -- created directly, saved
    // through a setup, or left behind by a charge -- resolves to one row.
    //
    // Scoped to the customer, never global: two customers who happen to save
    // the same card must get two stored instruments, or one customer's saved
    // card would be handed to another. An instrument with no customer never
    // dedupes, which is what both providers do -- Stripe mints a fresh
    // PaymentMethod for every `POST /v1/payment_methods`.
    if (input.signature && input.customerId) {
      const existing = await this.#storage.authorizations.bySignature(
        input.provider,
        input.signature,
        input.customerId,
      );
      if (existing) return existing;
    }

    const now = this.#clock.nowISO();
    const authorization: Authorization = {
      id: this.#ids.next('aut'),
      provider: input.provider,
      providerAuthorizationCode: input.providerAuthorizationCode ?? this.#ids.token(12),
      customerId: input.customerId ?? null,
      paymentId: input.paymentId ?? null,
      channel: input.channel,
      bin: input.bin ?? null,
      last4: input.last4 ?? null,
      expMonth: input.expMonth ?? null,
      expYear: input.expYear ?? null,
      cardType: input.cardType ?? null,
      bank: input.bank ?? null,
      brand: input.brand ?? null,
      countryCode: input.countryCode ?? null,
      signature: input.signature ?? null,
      reusable: input.reusable,
      active: true,
      accountName: input.accountName ?? null,
      mobileMoneyNumber: input.mobileMoneyNumber ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.authorizations.insert(authorization);
      const event = await this.#appendEvent(tx, {
        type: 'authorization.created',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'authorization',
        data: authorizationEventData(created),
        previousStatus: null,
        currentStatus: 'active',
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Bind a stored instrument to a customer.
   *
   * Goes through the engine rather than a bare repository write so it appends
   * an event like every other state change -- which is what lets the adapter
   * emit `payment_method.attached` for an instrument attached later, and not
   * only for one minted with a customer already on it.
   */
  async attachAuthorization(id: string, customerId: string): Promise<Authorization> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const existing = await tx.authorizations.byId(id);
      if (!existing) throw new PayboxError('not_found', `No authorization with id ${id}.`);

      const customer = await tx.customers.byId(customerId);
      if (!customer) throw new PayboxError('not_found', `No customer with id ${customerId}.`);

      const updated = await tx.authorizations.update(id, {
        customerId,
        updatedAt: this.#clock.nowISO(),
      });
      const event = await this.#appendEvent(tx, {
        type: 'authorization.attached',
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'authorization',
        data: authorizationEventData(updated),
        previousStatus: existing.customerId ? 'attached' : 'detached',
        currentStatus: 'attached',
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /** Unbind a stored instrument from its customer. */
  async detachAuthorization(id: string): Promise<Authorization> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const existing = await tx.authorizations.byId(id);
      if (!existing) throw new PayboxError('not_found', `No authorization with id ${id}.`);

      const updated = await tx.authorizations.update(id, {
        customerId: null,
        updatedAt: this.#clock.nowISO(),
      });
      const event = await this.#appendEvent(tx, {
        type: 'authorization.detached',
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'authorization',
        data: { ...authorizationEventData(updated), customer_id: existing.customerId },
        previousStatus: 'attached',
        currentStatus: 'detached',
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async deactivateAuthorization(id: string): Promise<Authorization> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const existing = await tx.authorizations.byId(id);
      if (!existing) throw new PayboxError('not_found', `No authorization with id ${id}.`);

      const updated = await tx.authorizations.update(id, {
        active: false,
        updatedAt: this.#clock.nowISO(),
      });
      const event = await this.#appendEvent(tx, {
        type: 'authorization.deactivated',
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'authorization',
        data: authorizationEventData(updated),
        previousStatus: 'active',
        currentStatus: 'inactive',
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Mint (or reuse) the authorization for a payment that just succeeded.
   *
   * Runs inside the caller's transaction and returns the event to publish
   * after commit, so it obeys the same append-then-publish rule as every other
   * state change.
   */
  async #mintFor(tx: Storage, payment: Payment): Promise<PayboxEvent | null> {
    const draft = this.#mintAuthorization(payment);
    if (!draft) return null;
    const minted = await this.#insertDraft(tx, {
      provider: payment.provider,
      draft,
      customerId: payment.customerId,
      paymentId: payment.id,
      fallbackCode: payment.providerTransactionId,
    });
    return minted?.event ?? null;
  }

  /**
   * Write an authorization draft as a row, inside the caller's transaction.
   *
   * Shared by the payment path and the setup path because both end in the same
   * place -- a stored instrument the merchant can debit later -- and the dedupe
   * rule has to be identical for both, or a card saved through a setup and the
   * same card charged directly would produce two instruments.
   */
  async #insertDraft(
    tx: Storage,
    input: {
      provider: ProviderId;
      draft: AuthorizationDraft;
      customerId: string | null;
      paymentId: string | null;
      fallbackCode: string;
    },
  ): Promise<{ authorization: Authorization; event: PayboxEvent } | null> {
    const { draft } = input;

    // A signature is the provider's fingerprint for the instrument, so one
    // customer's card charged twice yields one authorization, not two.
    // Scoped to that customer for the same reason as above. Channels without a
    // signature (mobile money) mint a fresh row every time, which is what the
    // provider does.
    const signature = draft.signature ?? null;
    if (signature && input.customerId) {
      const existing = await tx.authorizations.bySignature(
        input.provider,
        signature,
        input.customerId,
      );
      if (existing) return null;
    }

    const now = this.#clock.nowISO();
    const authorization: Authorization = {
      id: this.#ids.next('aut'),
      provider: input.provider,
      providerAuthorizationCode: draft.providerAuthorizationCode ?? input.fallbackCode,
      customerId: input.customerId,
      paymentId: input.paymentId,
      channel: draft.channel,
      bin: draft.bin ?? null,
      last4: draft.last4 ?? null,
      expMonth: draft.expMonth ?? null,
      expYear: draft.expYear ?? null,
      cardType: draft.cardType ?? null,
      bank: draft.bank ?? null,
      brand: draft.brand ?? null,
      countryCode: draft.countryCode ?? null,
      signature,
      reusable: draft.reusable,
      active: true,
      accountName: draft.accountName ?? null,
      mobileMoneyNumber: draft.mobileMoneyNumber ?? null,
      metadata: draft.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const created = await tx.authorizations.insert(authorization);
    const event = await this.#appendEvent(tx, {
      type: 'authorization.created',
      provider: created.provider,
      resourceId: created.id,
      resourceType: 'authorization',
      data: authorizationEventData(created),
      previousStatus: null,
      currentStatus: 'active',
    });
    return { authorization: created, event };
  }

  /* ---------------------------------------------------------------- *
   * Instrument setups: card-on-file, without a charge
   * ---------------------------------------------------------------- */

  /**
   * Begin storing an instrument for later use.
   *
   * Deliberately not a zero-amount payment. A payment that never moves money
   * would pollute every total, every list and every balance with rows that are
   * not transactions, and would make "how much did I take today" wrong. The
   * lifecycle is genuinely different too: it ends in a stored instrument
   * rather than a settlement.
   */
  async createInstrumentSetup(input: {
    provider: ProviderId;
    customerId?: string | null;
    usage?: 'on_session' | 'off_session';
    channel?: PaymentMethod | null;
    instrument?: Metadata;
    /** An instrument the caller already holds; attached rather than reminted. */
    authorizationId?: string | null;
    status?: SetupStatus;
    providerSetupId?: string;
    metadata?: Metadata;
  }): Promise<InstrumentSetup> {
    const now = this.#clock.nowISO();
    const status = input.status ?? 'created';
    const setup: InstrumentSetup = {
      id: this.#ids.next('set'),
      provider: input.provider,
      providerSetupId: input.providerSetupId ?? this.#ids.token(16),
      customerId: input.customerId ?? null,
      authorizationId: input.authorizationId ?? null,
      status,
      providerStatus: status,
      usage: input.usage ?? 'off_session',
      channel: input.channel ?? null,
      instrument: input.instrument ?? {},
      failureCode: null,
      failureMessage: null,
      cancellationReason: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.instrumentSetups.insert(setup);
      const event = await this.#appendEvent(tx, {
        type: 'setup.created',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'setup',
        data: setupEventData(created),
        previousStatus: null,
        currentStatus: created.status,
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Move a setup along, minting the stored instrument when it succeeds.
   *
   * The mint happens inside the same transaction as the transition, so a setup
   * can never be recorded as successful without the instrument it promised --
   * the same append-and-project rule the payment path follows.
   */
  async transitionInstrumentSetup(
    setupId: string,
    to: SetupStatus,
    options: {
      failureCode?: string | null;
      failureMessage?: string | null;
      cancellationReason?: string | null;
      channel?: PaymentMethod | null;
      instrument?: Metadata;
      /**
       * An instrument the caller already holds.
       *
       * Set when the setup was run against an existing stored instrument
       * rather than fresh details: the setup then *attaches* that one instead
       * of minting a second, which is what a provider does -- confirming a
       * SetupIntent against a PaymentMethod you already have does not give you
       * a different PaymentMethod.
       */
      authorizationId?: string | null;
      /** Resume a failed setup with another instrument. */
      retry?: boolean;
      eventData?: Metadata;
    } = {},
  ): Promise<InstrumentSetup> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const setup = await tx.instrumentSetups.byId(setupId);
      if (!setup) throw new PayboxError('not_found', `No instrument setup with id ${setupId}.`);
      assertSetupTransition(setup.status, to, { ...(options.retry ? { retry: true } : {}) });

      const now = this.#clock.nowISO();
      const patch: Partial<InstrumentSetup> = {
        status: to,
        providerStatus: this.#providerStatus(setup.provider, setupToPaymentStatus(to)),
        updatedAt: now,
        ...(options.channel !== undefined ? { channel: options.channel } : {}),
        ...(options.instrument !== undefined
          ? { instrument: { ...setup.instrument, ...options.instrument } }
          : {}),
        ...(options.authorizationId !== undefined
          ? { authorizationId: options.authorizationId }
          : {}),
        ...(options.cancellationReason !== undefined
          ? { cancellationReason: options.cancellationReason }
          : {}),
        ...(to === 'failed'
          ? {
              failureCode: options.failureCode ?? null,
              failureMessage: options.failureMessage ?? null,
            }
          : {}),
        // Retrying clears the previous attempt's error, so a caller reading the
        // row cannot mistake a stale failure for the current state.
        ...(options.retry && to !== 'failed'
          ? { failureCode: null, failureMessage: null }
          : {}),
      };

      const extra: PayboxEvent[] = [];
      const held = patch.authorizationId ?? setup.authorizationId;

      // Ran against an instrument the caller already had: attach it rather
      // than minting a second one for the same card.
      if (to === 'successful' && held && setup.customerId) {
        const existing = await tx.authorizations.byId(held);
        if (existing && existing.customerId !== setup.customerId) {
          const attached = await tx.authorizations.update(existing.id, {
            customerId: setup.customerId,
            updatedAt: now,
          });
          extra.push(
            await this.#appendEvent(tx, {
              type: 'authorization.attached',
              provider: attached.provider,
              resourceId: attached.id,
              resourceType: 'authorization',
              data: authorizationEventData(attached),
              previousStatus: existing.customerId ? 'attached' : 'detached',
              currentStatus: 'attached',
            }),
          );
        }
      }

      if (to === 'successful' && !held) {
        const draft = this.#mintSetupAuthorization({ ...setup, ...patch } as InstrumentSetup);
        if (draft) {
          const minted = await this.#insertDraft(tx, {
            provider: setup.provider,
            draft,
            customerId: setup.customerId,
            paymentId: null,
            fallbackCode: setup.providerSetupId,
          });
          if (minted) {
            patch.authorizationId = minted.authorization.id;
            extra.push(minted.event);
          } else if (draft.signature && setup.customerId) {
            // This customer had already stored the card, by an earlier setup
            // or an earlier charge. Point at that row rather than leaving the
            // setup successful with nothing to charge.
            const existing = await tx.authorizations.bySignature(
              setup.provider,
              draft.signature,
              setup.customerId,
            );
            if (existing) patch.authorizationId = existing.id;
          }
        }
      }

      const updated = await tx.instrumentSetups.update(setupId, patch);
      const event = await this.#appendEvent(tx, {
        type: `setup.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'setup',
        data: { ...setupEventData(updated), ...(options.eventData ?? {}) },
        previousStatus: setup.status,
        currentStatus: to,
      });
      return { result: updated, events: [...extra, event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async getInstrumentSetup(id: string): Promise<InstrumentSetup | null> {
    return this.#storage.instrumentSetups.byId(id);
  }

  /* ---------------------------------------------------------------- *
   * Dedicated virtual accounts
   * ---------------------------------------------------------------- */

  /**
   * Bind a synthetic account number to a customer.
   *
   * One per customer: asking twice returns the existing account rather than
   * minting a second, which is what a provider does -- a customer has one
   * inbound rail, not a growing pile of them.
   */
  async createDedicatedAccount(input: {
    provider: ProviderId;
    customerId: string;
    accountNumber: string;
    accountName: string;
    bankName: string;
    bankSlug: string;
    currency: string;
    providerAccountId?: string;
    metadata?: Metadata;
  }): Promise<DedicatedAccount> {
    const existing = await this.#storage.dedicatedAccounts.byCustomer(input.customerId);
    if (existing) return existing;

    const now = this.#clock.nowISO();
    const account: DedicatedAccount = {
      id: this.#ids.next('dva'),
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? this.#ids.token(12),
      customerId: input.customerId,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      bankName: input.bankName,
      bankSlug: input.bankSlug,
      currency: input.currency.toUpperCase(),
      active: true,
      assigned: true,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.dedicatedAccounts.insert(account);
      const event = await this.#appendEvent(tx, {
        type: 'dedicated_account.assigned',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'dedicated_account',
        data: dedicatedAccountEventData(created),
        previousStatus: null,
        currentStatus: 'active',
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Record a failed assignment.
   *
   * Providers fail these for real reasons -- an unverified customer, an
   * unavailable bank -- and the developer's integration has to handle the
   * webhook. Nothing is persisted because nothing was created; the event
   * exists purely so the failure webhook has something to carry.
   */
  async failDedicatedAccountAssignment(input: {
    provider: ProviderId;
    customerId: string;
    reason: string;
  }): Promise<void> {
    const events = await this.#storage.transaction(async (tx) => [
      await this.#appendEvent(tx, {
        type: 'dedicated_account.assign_failed',
        provider: input.provider,
        resourceId: input.customerId,
        resourceType: 'dedicated_account',
        data: { customer_id: input.customerId, reason: input.reason },
        previousStatus: null,
        currentStatus: 'failed',
      }),
    ]);
    await this.#bus.emitAll(events);
  }

  /* ---------------------------------------------------------------- *
   * Plans, subscriptions and invoices
   * ---------------------------------------------------------------- */

  async createProduct(input: {
    provider: ProviderId;
    name: string;
    description?: string | null;
    providerProductId?: string;
    metadata?: Metadata;
  }): Promise<Product> {
    const now = this.#clock.nowISO();
    return this.#storage.products.insert({
      id: this.#ids.next('prd'),
      provider: input.provider,
      providerProductId: input.providerProductId ?? this.#ids.token(12),
      name: input.name,
      description: input.description ?? null,
      active: true,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  async createPlan(input: {
    provider: ProviderId;
    name: string;
    amount: number;
    currency: string;
    interval: PlanInterval;
    intervalCount?: number;
    productId?: string | null;
    description?: string | null;
    invoiceLimit?: number;
    sendInvoices?: boolean;
    sendSms?: boolean;
    providerPlanCode?: string;
    metadata?: Metadata;
  }): Promise<Plan> {
    validateAmount(input.amount);
    if (!isSupportedCurrency(input.currency)) {
      throw new PayboxError(
        'unsupported_currency',
        `Currency ${input.currency} is not supported by the emulator.`,
        { details: { currency: input.currency } },
      );
    }

    const now = this.#clock.nowISO();
    const plan: Plan = {
      id: this.#ids.next('pln'),
      provider: input.provider,
      providerPlanCode: input.providerPlanCode ?? this.#ids.token(12),
      name: input.name,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      interval: input.interval,
      intervalCount:
        Number.isInteger(input.intervalCount) && (input.intervalCount ?? 0) > 0
          ? input.intervalCount!
          : 1,
      productId: input.productId ?? null,
      description: input.description ?? null,
      invoiceLimit: input.invoiceLimit ?? 0,
      sendInvoices: input.sendInvoices ?? true,
      sendSms: input.sendSms ?? true,
      active: true,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    return this.#storage.plans.insert(plan);
  }

  async updatePlan(id: string, patch: Partial<Plan>): Promise<Plan> {
    return this.#storage.plans.update(id, { ...patch, updatedAt: this.#clock.nowISO() });
  }

  /**
   * Start a subscription.
   *
   * The authorization is required and must be chargeable. Paystack lets you
   * omit it and falls back to the customer's most recent one -- the adapter
   * does that resolution, so by the time it reaches here there is always a
   * concrete instrument. Creating a subscription that could never be debited
   * would only fail later, at the first renewal, far from the cause.
   */
  /**
   * Start a subscription.
   *
   * `items` is the general form: several prices billed on one cycle, which is
   * what a base plan plus per-seat pricing plus an add-on actually is.
   * `planId` remains the *first* item's plan and sets the cadence, because
   * every price on one subscription must share an interval.
   *
   * A trial is expressed as a status, not as "active with a later date": the
   * whole free-trial pattern turns on a merchant's access logic being able to
   * tell "trying" from "paying".
   */
  async createSubscription(input: {
    provider: ProviderId;
    customerId: string;
    /** Single-price form. Ignored when `items` is supplied. */
    planId?: string;
    items?: { planId: string; quantity?: number; metadata?: Metadata }[];
    authorizationId: string;
    startDate?: string | null;
    quantity?: number;
    invoiceLimit?: number;
    /** Absolute end of the trial. Takes precedence over `trialPeriodDays`. */
    trialEnd?: string | null;
    trialPeriodDays?: number | null;
    providerSubscriptionCode?: string;
    metadata?: Metadata;
  }): Promise<Subscription> {
    const drafts =
      input.items && input.items.length > 0
        ? input.items
        : input.planId
          ? [{ planId: input.planId, quantity: input.quantity ?? 1 }]
          : [];
    if (drafts.length === 0) {
      throw new PayboxError('validation_failed', 'A subscription needs at least one price.');
    }

    const plans: Plan[] = [];
    for (const draft of drafts) {
      const plan = await this.#storage.plans.byId(draft.planId);
      if (!plan) throw new PayboxError('not_found', `No plan with id ${draft.planId}.`);
      plans.push(plan);
    }

    const first = plans[0]!;
    for (const [index, plan] of plans.entries()) {
      // Providers require one billing cycle per subscription. Accepting a
      // mismatch would produce a subscription whose renewal date is a lie
      // about half its prices.
      if (plan.interval !== first.interval || plan.intervalCount !== first.intervalCount) {
        throw new PayboxError(
          'validation_failed',
          `All prices on a subscription must share a billing interval. ` +
            `"${plan.name}" is ${plan.interval}/${plan.intervalCount} but ` +
            `"${first.name}" is ${first.interval}/${first.intervalCount}.`,
          { details: { index, interval: plan.interval, expected: first.interval } },
        );
      }
      if (plan.currency !== first.currency) {
        throw new PayboxError(
          'validation_failed',
          `All prices on a subscription must share a currency. "${plan.name}" is ` +
            `${plan.currency} but "${first.name}" is ${first.currency}.`,
        );
      }
    }

    const authorization = await this.#storage.authorizations.byId(input.authorizationId);
    if (!authorization) {
      throw new PayboxError('not_found', `No authorization with id ${input.authorizationId}.`);
    }
    this.assertChargeable(authorization);

    const now = this.#clock.nowISO();
    const startDate = input.startDate ?? now;
    const quantities = drafts.map((draft) => draft.quantity ?? 1);
    const amount = plans.reduce(
      (total, plan, index) => total + plan.amount * (quantities[index] ?? 1),
      0,
    );

    const trialEnd = this.#resolveTrialEnd(input.trialEnd, input.trialPeriodDays, startDate);
    const trialing = trialEnd !== null && Date.parse(trialEnd) > Date.parse(startDate);
    // Billing begins when the trial ends; without one, immediately.
    const firstPayment = trialing ? trialEnd : startDate;

    const subscription: Subscription = {
      id: this.#ids.next('sub'),
      provider: input.provider,
      providerSubscriptionCode: input.providerSubscriptionCode ?? this.#ids.token(12),
      customerId: input.customerId,
      planId: first.id,
      authorizationId: authorization.id,
      status: trialing ? 'trialing' : 'active',
      providerStatus: this.#providerStatus(input.provider, 'successful'),
      quantity: quantities[0] ?? 1,
      amount,
      currency: first.currency,
      startDate,
      currentPeriodStart: startDate,
      trialStart: trialing ? startDate : null,
      trialEnd: trialing ? trialEnd : null,
      nextPaymentDate: firstPayment,
      invoiceLimit: input.invoiceLimit ?? first.invoiceLimit,
      invoiceCount: 0,
      emailToken: this.#ids.token(20),
      cancelledAt: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.subscriptions.insert(subscription);
      let position = await tx.subscriptionItems.nextPosition();
      for (const [index, plan] of plans.entries()) {
        await tx.subscriptionItems.insert({
          id: this.#ids.next('sui'),
          provider: created.provider,
          providerItemId: this.#ids.token(14),
          subscriptionId: created.id,
          planId: plan.id,
          quantity: quantities[index] ?? 1,
          position: position++,
          metadata: drafts[index]?.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        });
      }

      const event = await this.#appendEvent(tx, {
        type: 'subscription.created',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'subscription',
        data: subscriptionEventData(created),
        previousStatus: null,
        currentStatus: created.status,
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /** Absolute trial end from either spelling, or null for no trial. */
  #resolveTrialEnd(
    trialEnd: string | null | undefined,
    trialPeriodDays: number | null | undefined,
    from: string,
  ): string | null {
    if (trialEnd) return trialEnd;
    if (trialPeriodDays && trialPeriodDays > 0) {
      return new Date(Date.parse(from) + trialPeriodDays * 24 * 60 * 60_000).toISOString();
    }
    return null;
  }

  async getSubscriptionItems(subscriptionId: string): Promise<SubscriptionItem[]> {
    return this.#storage.subscriptionItems.listBySubscription(subscriptionId);
  }

  /**
   * Change what a subscription bills for, settling the part-period difference.
   *
   * Proration is two lines, not one: a **credit** for the time already paid
   * for on the old shape and a **charge** for the remainder on the new. Both
   * are raised as pending invoice items, so they land on the next invoice --
   * which is where a merchant sees them, and why an upgrade does not produce
   * an immediate surprise bill unless one is asked for.
   *
   * `behavior`:
   *   create_prorations  raise the lines, bill them next cycle (the default)
   *   none               change the price, charge nothing for the difference
   *   always_invoice     raise the lines and bill them now
   */
  async updateSubscriptionItems(input: {
    subscriptionId: string;
    /** The full desired set. Omitted items are removed. */
    items: { itemId?: string; planId: string; quantity?: number }[];
    behavior?: ProrationBehavior;
  }): Promise<{ subscription: Subscription; prorations: InvoiceItem[] }> {
    const behavior = input.behavior ?? 'create_prorations';

    const subscription = await this.#storage.subscriptions.byId(input.subscriptionId);
    if (!subscription) {
      throw new PayboxError('not_found', `No subscription with id ${input.subscriptionId}.`);
    }
    if (subscription.status === 'cancelled' || subscription.status === 'completed') {
      throw new PayboxError(
        'invalid_state_transition',
        `Cannot change the prices on a subscription that is ${subscription.status}.`,
      );
    }

    const existing = await this.#storage.subscriptionItems.listBySubscription(subscription.id);
    const plansById = new Map<string, Plan>();
    const planFor = async (planId: string): Promise<Plan> => {
      const cached = plansById.get(planId);
      if (cached) return cached;
      const plan = await this.#storage.plans.byId(planId);
      if (!plan) throw new PayboxError('not_found', `No plan with id ${planId}.`);
      plansById.set(planId, plan);
      return plan;
    };
    for (const item of existing) await planFor(item.planId);
    for (const desired of input.items) await planFor(desired.planId);

    // The share of the period still to run. A change on the first day
    // prorates almost the whole period; one on the last day, almost none.
    const remaining = this.#remainingFraction(subscription);
    const now = this.#clock.nowISO();
    const periodEnd = subscription.nextPaymentDate ?? now;

    const keep = new Set<string>();
    const prorationDrafts: InvoiceItemDraft[] = [];
    let position = await this.#storage.subscriptionItems.nextPosition();

    const { result, events } = await this.#storage.transaction(async (tx) => {
      for (const desired of input.items) {
        const plan = await planFor(desired.planId);
        const quantity = desired.quantity ?? 1;
        const match = desired.itemId
          ? existing.find((item) => item.id === desired.itemId)
          : existing.find((item) => item.planId === desired.planId);

        if (!match) {
          await tx.subscriptionItems.insert({
            id: this.#ids.next('sui'),
            provider: subscription.provider,
            providerItemId: this.#ids.token(14),
            subscriptionId: subscription.id,
            planId: plan.id,
            quantity,
            position: position++,
            metadata: {},
            createdAt: now,
            updatedAt: now,
          });
          prorationDrafts.push(
            this.#prorationDraft(subscription, plan, quantity, remaining, now, periodEnd, 1),
          );
          continue;
        }

        keep.add(match.id);
        const oldPlan = await planFor(match.planId);
        const unchanged = match.planId === plan.id && match.quantity === quantity;
        if (unchanged) continue;

        await tx.subscriptionItems.update(match.id, {
          planId: plan.id,
          quantity,
          updatedAt: now,
        });
        // Credit what was paid for and will not be used, then charge for what
        // replaces it. Two lines rather than one net figure, because that is
        // what an invoice has to show for the number to be checkable.
        prorationDrafts.push(
          this.#prorationDraft(
            subscription, oldPlan, match.quantity, remaining, now, periodEnd, -1,
          ),
          this.#prorationDraft(subscription, plan, quantity, remaining, now, periodEnd, 1),
        );
      }

      for (const item of existing) {
        if (keep.has(item.id)) continue;
        const plan = await planFor(item.planId);
        await tx.subscriptionItems.delete(item.id);
        prorationDrafts.push(
          this.#prorationDraft(
            subscription, plan, item.quantity, remaining, now, periodEnd, -1,
          ),
        );
      }

      const remainingItems = await tx.subscriptionItems.listBySubscription(subscription.id);
      if (remainingItems.length === 0) {
        throw new PayboxError(
          'validation_failed',
          'A subscription must keep at least one price. Cancel it instead.',
        );
      }

      let amount = 0;
      for (const item of remainingItems) {
        amount += (await planFor(item.planId)).amount * item.quantity;
      }
      const head = remainingItems[0]!;

      const updated = await tx.subscriptions.update(subscription.id, {
        planId: head.planId,
        quantity: head.quantity,
        amount,
        updatedAt: now,
      });

      const event = await this.#appendEvent(tx, {
        type: 'subscription.updated',
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'subscription',
        data: subscriptionEventData(updated),
        previousStatus: subscription.status,
        currentStatus: updated.status,
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);

    const prorations: InvoiceItem[] = [];
    if (behavior !== 'none') {
      for (const draft of prorationDrafts) {
        // Zero-value lines are noise on an invoice; a change on the last
        // instant of a period genuinely owes nothing.
        if (draft.amount === 0) continue;
        prorations.push(await this.addInvoiceItem(draft));
      }
    }

    return { subscription: result, prorations };
  }

  /** One proration line: `sign` is +1 for a charge, -1 for a credit. */
  #prorationDraft(
    subscription: Subscription,
    plan: Plan,
    quantity: number,
    remaining: number,
    now: string,
    periodEnd: string,
    sign: 1 | -1,
  ): InvoiceItemDraft {
    const full = plan.amount * quantity;
    const amount = sign * Math.round(full * remaining);
    return {
      provider: subscription.provider,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      planId: plan.id,
      description:
        sign === 1
          ? `Remaining time on ${plan.name}`
          : `Unused time on ${plan.name}`,
      amount,
      currency: subscription.currency,
      quantity,
      unitAmount: plan.amount,
      periodStart: now,
      periodEnd,
      proration: true,
    };
  }

  /**
   * How much of the current billing period is still to run, as 0..1.
   *
   * Clamped at both ends: a clock that has passed the renewal date without the
   * job having run yet must not produce a negative proration, and a period of
   * zero length must not divide by zero.
   */
  #remainingFraction(subscription: Subscription): number {
    const start = Date.parse(subscription.currentPeriodStart);
    const end = Date.parse(subscription.nextPaymentDate ?? subscription.currentPeriodStart);
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) return 0;
    const left = end - this.#clock.now();
    return Math.min(1, Math.max(0, left / span));
  }

  async transitionSubscription(
    subscriptionId: string,
    to: SubscriptionStatus,
    options: { nextPaymentDate?: string | null } = {},
  ): Promise<Subscription> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const subscription = await tx.subscriptions.byId(subscriptionId);
      if (!subscription) {
        throw new PayboxError('not_found', `No subscription with id ${subscriptionId}.`);
      }
      assertSubscriptionTransition(subscription.status, to);

      const now = this.#clock.nowISO();
      const stops = to === 'completed' || to === 'cancelled' || to === 'non_renewing';
      const updated = await tx.subscriptions.update(subscriptionId, {
        status: to,
        providerStatus: to,
        updatedAt: now,
        // A subscription that no longer renews must not keep a due date, or
        // the scheduler would raise an invoice for something already ended.
        ...(options.nextPaymentDate !== undefined
          ? { nextPaymentDate: options.nextPaymentDate }
          : stops
            ? { nextPaymentDate: null }
            : {}),
        ...(to === 'cancelled' ? { cancelledAt: now } : {}),
      });

      const event = await this.#appendEvent(tx, {
        type: `subscription.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'subscription',
        data: subscriptionEventData(updated),
        previousStatus: subscription.status,
        currentStatus: to,
      });
      return { result: updated, events: [event] };
    });

    // Nothing should still be scheduled for a subscription that has stopped.
    if (result.nextPaymentDate === null) {
      await this.#storage.jobs.cancelGroup(`subscription:${subscriptionId}`);
    }

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Raise an invoice.
   *
   * Two shapes share this path. A subscription renewal supplies
   * `subscriptionId` and lands `pending`, already owed -- emitted ahead of the
   * debit, as Paystack does. A standalone invoice supplies `customerId` and a
   * `draft` status, and is assembled from line items before anyone owes
   * anything.
   *
   * When line items are supplied the total is a **fold over them**, never a
   * separately-passed number: a stored total that can disagree with the lines
   * beneath it is a total that eventually will.
   */
  async createInvoice(input: {
    subscriptionId?: string | null;
    customerId?: string;
    provider?: ProviderId;
    periodStart: string;
    periodEnd: string;
    dueAt: string;
    amount?: number;
    currency?: string;
    status?: Extract<InvoiceStatus, 'draft' | 'pending'>;
    billingReason?: string;
    items?: InvoiceItemDraft[];
    metadata?: Metadata;
  }): Promise<Invoice> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const subscription = input.subscriptionId
        ? await tx.subscriptions.byId(input.subscriptionId)
        : null;
      if (input.subscriptionId && !subscription) {
        throw new PayboxError('not_found', `No subscription with id ${input.subscriptionId}.`);
      }

      const customerId = subscription?.customerId ?? input.customerId;
      if (!customerId) {
        throw new PayboxError(
          'validation_failed',
          'An invoice needs either a subscription or a customer.',
        );
      }
      const provider = subscription?.provider ?? input.provider;
      if (!provider) {
        throw new PayboxError('validation_failed', 'An invoice needs a provider.');
      }
      const currency = subscription?.currency ?? input.currency;
      if (!currency) {
        throw new PayboxError('validation_failed', 'An invoice needs a currency.');
      }

      const now = this.#clock.nowISO();
      const status = input.status ?? 'pending';
      const drafts = input.items ?? [];
      const amount =
        drafts.length > 0
          ? sumItems(drafts)
          : (input.amount ?? subscription?.amount ?? 0);

      const invoice: Invoice = {
        id: this.#ids.next('inv'),
        provider,
        providerInvoiceCode: this.#ids.token(12),
        subscriptionId: subscription?.id ?? null,
        customerId,
        paymentId: null,
        // Clamped: paybox has no customer credit balance, so a total that went
        // negative would have nowhere to go. docs/stripe.md records it.
        amount: Math.max(0, amount),
        currency,
        status,
        providerStatus: status,
        billingReason:
          input.billingReason ?? (subscription ? 'subscription_cycle' : 'manual'),
        attemptCount: 0,
        // Assigned at finalisation, as providers do. A draft has no number.
        number: status === 'draft' ? null : this.#invoiceNumber(),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dueAt: input.dueAt,
        paidAt: null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };

      const created = await tx.invoices.insert(invoice);
      let position = await tx.invoiceItems.nextPosition();
      for (const draft of drafts) {
        await tx.invoiceItems.insert(this.#buildItem(draft, created, now, position++));
      }

      // An invoice raised straight into `pending` -- a subscription renewal --
      // never passes through `finalizeInvoice`, so it has to sweep here or a
      // mid-cycle proration would sit pending forever and never be billed.
      if (status !== 'draft') {
        for (const pending of await tx.invoiceItems.listPending(
          customerId,
          created.subscriptionId,
        )) {
          await tx.invoiceItems.update(pending.id, {
            invoiceId: created.id,
            position: position++,
            updatedAt: now,
          });
        }
        const total = await tx.invoiceItems.totalFor(created.id);
        if (total !== created.amount) {
          await tx.invoices.update(created.id, { amount: Math.max(0, total), updatedAt: now });
        }
      }

      // Count the invoice as raised here, in the same transaction, so the
      // invoice_limit check can never double-count a retried job. Drafts do
      // not count: nothing has been billed yet.
      if (subscription && status !== 'draft') {
        await tx.subscriptions.update(subscription.id, {
          invoiceCount: subscription.invoiceCount + 1,
          updatedAt: now,
        });
      }

      const settled = (await tx.invoices.byId(created.id)) ?? created;
      const event = await this.#appendEvent(tx, {
        type: 'invoice.created',
        provider: settled.provider,
        resourceId: settled.id,
        resourceType: 'invoice',
        data: invoiceEventData(settled),
        previousStatus: null,
        currentStatus: settled.status,
      });
      return { result: settled, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async transitionInvoice(
    invoiceId: string,
    to: InvoiceStatus,
    options: { paymentId?: string | null; attempted?: boolean } = {},
  ): Promise<Invoice> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const invoice = await tx.invoices.byId(invoiceId);
      if (!invoice) throw new PayboxError('not_found', `No invoice with id ${invoiceId}.`);
      assertInvoiceTransition(invoice.status, to);

      const now = this.#clock.nowISO();
      // A settled or failed transition is by definition an attempt; the caller
      // can force the count for a path that attempts without transitioning.
      const attempted = options.attempted ?? (to === 'success' || to === 'failed');
      const updated = await tx.invoices.update(invoiceId, {
        status: to,
        providerStatus: to,
        updatedAt: now,
        ...(attempted ? { attemptCount: invoice.attemptCount + 1 } : {}),
        ...(options.paymentId !== undefined ? { paymentId: options.paymentId } : {}),
        ...(to === 'success' ? { paidAt: now } : {}),
      });

      const event = await this.#appendEvent(tx, {
        type: to === 'failed' ? 'invoice.payment_failed' : `invoice.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'invoice',
        data: invoiceEventData(updated),
        previousStatus: invoice.status,
        currentStatus: to,
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Close a draft: sweep in anything pending, total it, give it a number.
   *
   * Finalising is the moment the money becomes owed, which is why the sweep
   * happens here and not at creation -- an item added while the invoice was
   * still a draft belongs on it, and one added afterwards does not.
   */
  async finalizeInvoice(invoiceId: string): Promise<Invoice> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const invoice = await tx.invoices.byId(invoiceId);
      if (!invoice) throw new PayboxError('not_found', `No invoice with id ${invoiceId}.`);
      assertInvoiceTransition(invoice.status, 'pending');

      const now = this.#clock.nowISO();
      // Swept items land *after* whatever is already on the invoice, in their
      // own creation order -- which is why position is monotonic across the
      // whole table rather than per invoice.
      let position = await tx.invoiceItems.nextPosition();
      for (const pending of await tx.invoiceItems.listPending(
        invoice.customerId,
        invoice.subscriptionId,
      )) {
        await tx.invoiceItems.update(pending.id, {
          invoiceId: invoice.id,
          position: position++,
          updatedAt: now,
        });
      }

      const total = await tx.invoiceItems.totalFor(invoice.id);
      const updated = await tx.invoices.update(invoiceId, {
        status: 'pending',
        providerStatus: 'pending',
        amount: Math.max(0, total),
        number: invoice.number ?? this.#invoiceNumber(),
        updatedAt: now,
      });

      const event = await this.#appendEvent(tx, {
        type: 'invoice.finalized',
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'invoice',
        data: invoiceEventData(updated),
        previousStatus: invoice.status,
        currentStatus: 'pending',
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Add a line.
   *
   * With no `invoiceId` the item is **pending**: it waits for whichever invoice
   * is finalised next, which is how a mid-cycle change reaches the customer's
   * next bill rather than generating one of its own.
   */
  async addInvoiceItem(draft: InvoiceItemDraft & { invoiceId?: string | null }): Promise<InvoiceItem> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const invoice = draft.invoiceId ? await tx.invoices.byId(draft.invoiceId) : null;
      if (draft.invoiceId && !invoice) {
        throw new PayboxError('not_found', `No invoice with id ${draft.invoiceId}.`);
      }
      if (invoice && invoice.status !== 'draft') {
        throw new PayboxError(
          'invalid_state_transition',
          `Cannot add a line to an invoice that is ${invoice.status}; only a draft is editable.`,
        );
      }

      const now = this.#clock.nowISO();
      const item = await tx.invoiceItems.insert(
        this.#buildItem(draft, invoice, now, await tx.invoiceItems.nextPosition()),
      );
      if (invoice) await this.#retotal(tx, invoice.id, now);

      const event = await this.#appendEvent(tx, {
        type: 'invoiceitem.created',
        provider: item.provider,
        resourceId: invoice?.id ?? item.id,
        resourceType: 'invoice',
        data: {
          id: item.id,
          invoice_id: item.invoiceId,
          amount: item.amount,
          currency: item.currency,
          description: item.description,
          proration: item.proration,
        },
        previousStatus: null,
        currentStatus: invoice?.status ?? 'pending',
      });
      return { result: item, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /** Remove a line from a draft, and retotal what is left. */
  async deleteInvoiceItem(itemId: string): Promise<void> {
    await this.#storage.transaction(async (tx) => {
      const item = await tx.invoiceItems.byId(itemId);
      if (!item) throw new PayboxError('not_found', `No invoice item with id ${itemId}.`);

      if (item.invoiceId) {
        const invoice = await tx.invoices.byId(item.invoiceId);
        if (invoice && invoice.status !== 'draft') {
          throw new PayboxError(
            'invalid_state_transition',
            `Cannot remove a line from an invoice that is ${invoice.status}.`,
          );
        }
      }

      await tx.invoiceItems.delete(itemId);
      if (item.invoiceId) await this.#retotal(tx, item.invoiceId, this.#clock.nowISO());
    });
  }

  async getInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
    return this.#storage.invoiceItems.listByInvoice(invoiceId);
  }

  /** The invoice total is a fold over its lines, recomputed, never accumulated. */
  async #retotal(tx: Storage, invoiceId: string, now: string): Promise<void> {
    const total = await tx.invoiceItems.totalFor(invoiceId);
    await tx.invoices.update(invoiceId, { amount: Math.max(0, total), updatedAt: now });
  }

  #buildItem(
    draft: InvoiceItemDraft,
    invoice: Invoice | null,
    now: string,
    position: number,
  ): InvoiceItem {
    const quantity = draft.quantity ?? 1;
    const unitAmount = draft.unitAmount ?? draft.amount ?? 0;
    return {
      id: this.#ids.next('ivi'),
      provider: draft.provider ?? invoice?.provider ?? 'stripe',
      providerItemId: this.#ids.token(14),
      customerId: draft.customerId ?? invoice?.customerId ?? '',
      invoiceId: invoice?.id ?? null,
      subscriptionId: draft.subscriptionId ?? invoice?.subscriptionId ?? null,
      planId: draft.planId ?? null,
      description: draft.description ?? null,
      amount: draft.amount ?? unitAmount * quantity,
      currency: draft.currency ?? invoice?.currency ?? 'USD',
      quantity,
      unitAmount,
      periodStart: draft.periodStart ?? invoice?.periodStart ?? now,
      periodEnd: draft.periodEnd ?? invoice?.periodEnd ?? now,
      proration: draft.proration ?? false,
      position,
      metadata: draft.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * A human-facing invoice number.
   *
   * Drawn from the injected id stream rather than a counter so it stays
   * reproducible under a fixed seed, which the compat suite relies on.
   */
  #invoiceNumber(): string {
    return this.#ids.token(8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2');
  }

  /**
   * Note that a trial is about to end.
   *
   * An informational event, not a transition: nothing about the subscription
   * changes, and the notice is the entire point. Appended to the log like
   * every other event so it can be replayed and audited.
   */
  async announceTrialEnding(subscriptionId: string): Promise<Subscription> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const subscription = await tx.subscriptions.byId(subscriptionId);
      if (!subscription) {
        throw new PayboxError('not_found', `No subscription with id ${subscriptionId}.`);
      }
      const event = await this.#appendEvent(tx, {
        type: 'subscription.trial_ending',
        provider: subscription.provider,
        resourceId: subscription.id,
        resourceType: 'subscription',
        data: subscriptionEventData(subscription),
        previousStatus: subscription.status,
        currentStatus: subscription.status,
      });
      return { result: subscription, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async getSubscription(id: string): Promise<Subscription | null> {
    return this.#storage.subscriptions.byId(id);
  }

  /* ---------------------------------------------------------------- *
   * Marketplace: subaccounts, splits and the balance ledger
   * ---------------------------------------------------------------- */

  async createSubaccount(input: {
    provider: ProviderId;
    businessName: string;
    settlementBank: string;
    accountNumber: string;
    percentageCharge: number;
    currency: string;
    description?: string | null;
    primaryContactEmail?: string | null;
    primaryContactName?: string | null;
    primaryContactPhone?: string | null;
    providerSubaccountCode?: string;
    metadata?: Metadata;
  }): Promise<Subaccount> {
    if (input.percentageCharge < 0 || input.percentageCharge > 100) {
      throw new PayboxError(
        'validation_failed',
        `percentage_charge must be between 0 and 100; received ${input.percentageCharge}.`,
        { details: { percentageCharge: input.percentageCharge } },
      );
    }

    const now = this.#clock.nowISO();
    return this.#storage.subaccounts.insert({
      id: this.#ids.next('sac'),
      provider: input.provider,
      providerSubaccountCode: input.providerSubaccountCode ?? this.#ids.token(12),
      businessName: input.businessName,
      settlementBank: input.settlementBank,
      accountNumber: input.accountNumber,
      percentageCharge: input.percentageCharge,
      description: input.description ?? null,
      primaryContactEmail: input.primaryContactEmail ?? null,
      primaryContactName: input.primaryContactName ?? null,
      primaryContactPhone: input.primaryContactPhone ?? null,
      currency: input.currency.toUpperCase(),
      active: true,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Define how a transaction is divided.
   *
   * A percentage split whose shares exceed 100 is rejected. Providers reject
   * it too, and letting it through would produce subaccount payouts larger
   * than the payment that funded them.
   */
  async createSplit(input: {
    provider: ProviderId;
    name: string;
    type: Split['type'];
    currency: string;
    entries: { subaccountId: string; subaccountCode: string; share: number }[];
    bearerType?: Split['bearerType'];
    bearerSubaccountId?: string | null;
    providerSplitCode?: string;
  }): Promise<Split> {
    if (input.entries.length === 0) {
      throw new PayboxError('validation_failed', 'A split needs at least one subaccount.');
    }
    const total = input.entries.reduce((sum, entry) => sum + entry.share, 0);
    if (input.type === 'percentage' && total > 100) {
      throw new PayboxError(
        'validation_failed',
        `Percentage shares total ${total}, which exceeds 100.`,
        { details: { total } },
      );
    }

    const now = this.#clock.nowISO();
    return this.#storage.splits.insert({
      id: this.#ids.next('spl'),
      provider: input.provider,
      providerSplitCode: input.providerSplitCode ?? this.#ids.token(12),
      name: input.name,
      type: input.type,
      currency: input.currency.toUpperCase(),
      bearerType: input.bearerType ?? 'account',
      bearerSubaccountId: input.bearerSubaccountId ?? null,
      active: true,
      entries: input.entries,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * What each subaccount receives from an amount under a split.
   *
   * Flat shares are taken as-is and capped at the amount; percentage shares
   * are rounded down so the parts can never sum to more than the whole. The
   * remainder is the merchant's.
   */
  computeSplit(split: Split, amount: number): { entries: { subaccountCode: string; amount: number }[]; merchant: number } {
    let allocated = 0;
    const entries = split.entries.map((entry) => {
      const raw =
        split.type === 'percentage'
          ? Math.floor((amount * entry.share) / 100)
          : Math.floor(entry.share);
      const share = Math.max(0, Math.min(raw, amount - allocated));
      allocated += share;
      return { subaccountCode: entry.subaccountCode, amount: share };
    });
    return { entries, merchant: amount - allocated };
  }

  /** Current balance for a currency, including the opening test float. */
  async getBalance(provider: ProviderId, currency: string): Promise<number> {
    const net = await this.#storage.ledger.net(provider, currency.toUpperCase());
    return this.#openingBalance + net;
  }

  async creditBalance(input: {
    provider: ProviderId;
    currency: string;
    amount: number;
    reason: string;
    resourceId?: string | null;
  }): Promise<LedgerEntry> {
    return this.#appendLedger('credit', input);
  }

  async debitBalance(input: {
    provider: ProviderId;
    currency: string;
    amount: number;
    reason: string;
    resourceId?: string | null;
  }): Promise<LedgerEntry> {
    return this.#appendLedger('debit', input);
  }

  /** Ledger append bound to an open transaction. */
  async #ledgerIn(
    tx: Storage,
    direction: LedgerEntry['direction'],
    input: {
      provider: ProviderId;
      currency: string;
      amount: number;
      reason: string;
      resourceId?: string | null;
    },
  ): Promise<void> {
    await tx.ledger.append({
      id: this.#ids.next('led'),
      provider: input.provider,
      currency: input.currency.toUpperCase(),
      direction,
      amount: input.amount,
      reason: input.reason,
      resourceId: input.resourceId ?? null,
      createdAt: this.#clock.nowISO(),
    });
  }

  async #appendLedger(
    direction: LedgerEntry['direction'],
    input: {
      provider: ProviderId;
      currency: string;
      amount: number;
      reason: string;
      resourceId?: string | null;
    },
  ): Promise<LedgerEntry> {
    validateAmount(input.amount);
    return this.#storage.ledger.append({
      id: this.#ids.next('led'),
      provider: input.provider,
      currency: input.currency.toUpperCase(),
      direction,
      amount: input.amount,
      reason: input.reason,
      resourceId: input.resourceId ?? null,
      createdAt: this.#clock.nowISO(),
    });
  }

  /* ---------------------------------------------------------------- *
   * Disputes
   * ---------------------------------------------------------------- */

  /**
   * Open a chargeback against a successful payment.
   *
   * Only a payment that actually collected money can be disputed -- there is
   * nothing to charge back otherwise, and allowing it would let a test
   * construct a state no provider can produce.
   */
  async createDispute(input: {
    paymentId: string;
    category?: string;
    refundAmount?: number;
    dueInMs?: number;
    message?: string | null;
    providerDisputeId?: string;
    metadata?: Metadata;
  }): Promise<Dispute> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const payment = await this.#requirePayment(tx, input.paymentId);
      if (
        payment.status !== 'successful' &&
        payment.status !== 'partially_refunded' &&
        payment.status !== 'refunded'
      ) {
        throw new PayboxError(
          'invalid_state_transition',
          `Only a payment that collected money can be disputed; this one is ${payment.status}.`,
          { details: { paymentId: payment.id, status: payment.status } },
        );
      }

      const refundAmount = input.refundAmount ?? payment.amount;
      if (refundAmount > payment.amount) {
        throw new PayboxError(
          'validation_failed',
          `Disputed amount ${refundAmount} exceeds the payment's ${payment.amount}.`,
          { details: { refundAmount, amount: payment.amount } },
        );
      }

      const now = this.#clock.nowISO();
      const dispute: Dispute = {
        id: this.#ids.next('dsp'),
        provider: payment.provider,
        providerDisputeId: input.providerDisputeId ?? this.#ids.token(12),
        paymentId: payment.id,
        customerId: payment.customerId,
        category: input.category ?? 'chargeback',
        status: 'awaiting_merchant_feedback',
        providerStatus: 'awaiting-merchant-feedback',
        resolution: null,
        refundAmount,
        currency: payment.currency,
        // Providers give the merchant a window to respond. Default to a week.
        dueAt: new Date(this.#clock.now() + (input.dueInMs ?? 7 * 24 * 60 * 60_000)).toISOString(),
        resolvedAt: null,
        evidence: null,
        message: input.message ?? null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };

      const created = await tx.disputes.insert(dispute);
      const event = await this.#appendEvent(tx, {
        type: 'dispute.created',
        provider: created.provider,
        resourceId: created.id,
        resourceType: 'dispute',
        data: disputeEventData(created),
        previousStatus: null,
        currentStatus: created.status,
      });
      return { result: created, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  async transitionDispute(
    disputeId: string,
    to: DisputeStatus,
    options: { eventType?: string } = {},
  ): Promise<Dispute> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const dispute = await tx.disputes.byId(disputeId);
      if (!dispute) throw new PayboxError('not_found', `No dispute with id ${disputeId}.`);
      assertDisputeTransition(dispute.status, to);

      const updated = await tx.disputes.update(disputeId, {
        status: to,
        providerStatus: to.replace(/_/g, '-'),
        updatedAt: this.#clock.nowISO(),
      });
      const event = await this.#appendEvent(tx, {
        type: options.eventType ?? `dispute.${to}`,
        provider: updated.provider,
        resourceId: updated.id,
        resourceType: 'dispute',
        data: disputeEventData(updated),
        previousStatus: dispute.status,
        currentStatus: to,
      });
      return { result: updated, events: [event] };
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /** Attach the merchant's rebuttal. Does not by itself resolve anything. */
  async addDisputeEvidence(disputeId: string, evidence: Metadata): Promise<Dispute> {
    const dispute = await this.#storage.disputes.byId(disputeId);
    if (!dispute) throw new PayboxError('not_found', `No dispute with id ${disputeId}.`);
    return this.#storage.disputes.update(disputeId, {
      evidence: { ...(dispute.evidence ?? {}), ...evidence },
      updatedAt: this.#clock.nowISO(),
    });
  }

  /**
   * Close a dispute.
   *
   * `merchant-accepted` means the merchant conceded, so the money goes back:
   * a real refund is raised and settled, which moves the payment to
   * `refunded`/`partially_refunded` and debits the balance through the
   * ordinary path. `declined` closes it with no money movement.
   */
  async resolveDispute(
    disputeId: string,
    input: { resolution: DisputeResolution; message: string; refundAmount?: number },
  ): Promise<Dispute> {
    // One transaction for the whole resolution. `Storage.transaction` is
    // reentrant, so the refund calls below join this transaction rather than
    // committing on their own -- without that, a resolution that failed partway
    // left money moved against a dispute that was never resolved, and two
    // concurrent resolutions could each settle a partial refund before one of
    // them lost the race.
    const { result, events } = await this.#storage.transaction(async (tx) => {
      const dispute = await tx.disputes.byId(disputeId);
      if (!dispute) throw new PayboxError('not_found', `No dispute with id ${disputeId}.`);
      // Read and checked inside the transaction: the guard and the write have
      // to see the same state, or two concurrent resolutions can each settle a
      // refund before one of them loses the race.
      if (dispute.status === 'resolved') {
        throw new PayboxError(
          'invalid_state_transition',
          'This dispute has already been resolved.',
          { details: { disputeId } },
        );
      }
      assertDisputeTransition(dispute.status, 'resolved');

      const emitted: PayboxEvent[] = [];

      if (input.resolution === 'merchant-accepted') {
        const amount = input.refundAmount ?? dispute.refundAmount;
        if (amount > 0) {
          // Composed on this transaction, not nested in a fresh one.
          const created = await this.#createRefundIn(tx, {
            paymentId: dispute.paymentId,
            amount,
            reason: input.message,
            metadata: { dispute_id: dispute.id },
          });
          emitted.push(...created.events);
          const settled = await this.#transitionRefundIn(tx, created.result.id, 'successful');
          emitted.push(...settled.events);
        }
      }

      const now = this.#clock.nowISO();
      const updated = await tx.disputes.update(disputeId, {
        status: 'resolved',
        providerStatus: 'resolved',
        resolution: input.resolution,
        message: input.message,
        ...(input.refundAmount !== undefined ? { refundAmount: input.refundAmount } : {}),
        resolvedAt: now,
        updatedAt: now,
      });
      emitted.push(
        await this.#appendEvent(tx, {
          type: 'dispute.resolved',
          provider: updated.provider,
          resourceId: updated.id,
          resourceType: 'dispute',
          data: disputeEventData(updated),
          previousStatus: dispute.status,
          currentStatus: 'resolved',
        }),
      );

      return { result: updated, events: emitted };
    });

    // A resolved dispute has no deadline left to remind anyone about.
    await this.#storage.jobs.cancelGroup(`dispute:${disputeId}`);
    await this.#bus.emitAll(events);
    return result;
  }

  /** Schedule the deadline reminder a provider sends before a dispute expires. */
  async scheduleDisputeReminder(dispute: Dispute, leadMs = 24 * 60 * 60_000): Promise<void> {
    const remindAt = Date.parse(dispute.dueAt) - leadMs;
    await this.#enqueue({
      kind: 'dispute.remind',
      payload: { disputeId: dispute.id },
      runAt: new Date(Math.max(remindAt, this.#clock.now())).toISOString(),
      groupKey: `dispute:${dispute.id}`,
    });
  }

  async getDispute(id: string): Promise<Dispute | null> {
    return this.#storage.disputes.byId(id);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async #requirePayment(tx: Storage, id: string): Promise<Payment> {
    const payment = await tx.payments.byId(id);
    if (!payment) throw new PayboxError('not_found', `No payment with id ${id}.`);
    return payment;
  }

  async #appendEvent(
    tx: Storage,
    input: Omit<PayboxEvent, 'id' | 'sequence' | 'createdAt'>,
  ): Promise<PayboxEvent> {
    const sequence = await tx.events.nextSequence(input.resourceId);
    return tx.events.append({
      ...input,
      id: this.#ids.next('evt'),
      sequence,
      createdAt: this.#clock.nowISO(),
    });
  }

  async #enqueue(input: {
    kind: string;
    payload: Metadata;
    runAt: string;
    groupKey?: string;
    maxAttempts?: number;
  }): Promise<Job> {
    const now = this.#clock.nowISO();
    return this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind: input.kind,
      payload: input.payload,
      status: 'ready',
      runAt: input.runAt,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: input.groupKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function validateAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PayboxError(
      'validation_failed',
      `Amount must be a positive integer in minor units; received ${amount}.`,
      { details: { amount } },
    );
  }
}

function paymentEventData(payment: Payment): Metadata {
  return {
    id: payment.id,
    reference: payment.reference,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    provider_status: payment.providerStatus,
    payment_method: payment.paymentMethod,
    customer_id: payment.customerId,
    metadata: payment.metadata,
  };
}

function refundEventData(refund: Refund, payment: Payment): Metadata {
  return {
    id: refund.id,
    payment_id: refund.paymentId,
    payment_reference: payment.reference,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
  };
}

function authorizationEventData(authorization: Authorization): Metadata {
  return {
    id: authorization.id,
    authorization_code: authorization.providerAuthorizationCode,
    channel: authorization.channel,
    last4: authorization.last4,
    reusable: authorization.reusable,
    active: authorization.active,
    customer_id: authorization.customerId,
  };
}

function setupEventData(setup: InstrumentSetup): Metadata {
  return {
    id: setup.id,
    setup_id: setup.providerSetupId,
    customer_id: setup.customerId,
    authorization_id: setup.authorizationId,
    usage: setup.usage,
    channel: setup.channel,
    last4: setup.instrument.last4 ?? null,
  };
}

/**
 * The payment status a setup status corresponds to.
 *
 * Only used to reach the injected `ProviderStatusResolver`, so a setup's
 * `providerStatus` reads in the same vocabulary the adapter uses everywhere
 * else rather than growing a second, parallel mapping.
 */
function setupToPaymentStatus(status: SetupStatus): PaymentStatus {
  return status === 'cancelled' ? 'cancelled' : (status as PaymentStatus);
}

function dedicatedAccountEventData(account: DedicatedAccount): Metadata {
  return {
    id: account.id,
    account_number: account.accountNumber,
    account_name: account.accountName,
    bank: account.bankName,
    currency: account.currency,
    customer_id: account.customerId,
  };
}

function subscriptionEventData(subscription: Subscription): Metadata {
  return {
    id: subscription.id,
    subscription_code: subscription.providerSubscriptionCode,
    customer_id: subscription.customerId,
    plan_id: subscription.planId,
    amount: subscription.amount,
    currency: subscription.currency,
    status: subscription.status,
    next_payment_date: subscription.nextPaymentDate,
    trial_end: subscription.trialEnd,
  };
}

function invoiceEventData(invoice: Invoice): Metadata {
  return {
    id: invoice.id,
    invoice_code: invoice.providerInvoiceCode,
    subscription_id: invoice.subscriptionId,
    customer_id: invoice.customerId,
    payment_id: invoice.paymentId,
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    period_start: invoice.periodStart,
    period_end: invoice.periodEnd,
  };
}

function disputeEventData(dispute: Dispute): Metadata {
  return {
    id: dispute.id,
    payment_id: dispute.paymentId,
    status: dispute.status,
    category: dispute.category,
    refund_amount: dispute.refundAmount,
    currency: dispute.currency,
    resolution: dispute.resolution,
    due_at: dispute.dueAt,
  };
}

function transferEventData(transfer: Transfer): Metadata {
  return {
    id: transfer.id,
    reference: transfer.reference,
    amount: transfer.amount,
    currency: transfer.currency,
    status: transfer.status,
    recipient: transfer.recipientName,
  };
}

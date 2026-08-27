import {
  PayboxError,
  isSupportedCurrency,
  type Authorization,
  type Clock,
  type Customer,
  type DedicatedAccount,
  type IdFactory,
  type Metadata,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type PayboxEvent,
  type ProviderId,
  type Refund,
  type RefundStatus,
  type Transfer,
  type TransferStatus,
} from '@paybox/shared';
import type { Job, Storage } from './ports.js';
import { EventBus } from './event-bus.js';
import {
  assertPaymentTransition,
  assertRefundTransition,
  assertRefundable,
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

export interface TransitionOptions {
  providerStatus?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  paymentMethod?: PaymentMethod | null;
  paymentMethodDetails?: Metadata;
  /** Explicitly simulate a provider reversing a terminal decision (spec §7). */
  reversal?: boolean;
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

export interface EngineDeps {
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  bus: EventBus;
  providerStatus?: ProviderStatusResolver;
  mintAuthorization?: AuthorizationMinter;
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

  constructor(deps: EngineDeps) {
    this.#storage = deps.storage;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#bus = deps.bus;
    this.#providerStatus = deps.providerStatus ?? ((_provider, status) => status);
    this.#mintAuthorization = deps.mintAuthorization ?? (() => null);
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
      assertPaymentTransition(payment.status, to, { reversal: options.reversal });

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

  async createRefund(input: {
    paymentId: string;
    amount?: number;
    reason?: string | null;
    metadata?: Metadata;
    /** Refunds are asynchronous at every provider we emulate. */
    status?: RefundStatus;
  }): Promise<Refund> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
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
    });

    await this.#bus.emitAll(events);
    return result;
  }

  /**
   * Settle a refund. When it succeeds we also move the parent payment to
   * `partially_refunded` or `refunded`, which is the only place those two
   * statuses are ever set.
   */
  async transitionRefund(
    refundId: string,
    to: RefundStatus,
    options: { reason?: string | null } = {},
  ): Promise<Refund> {
    const { result, events } = await this.#storage.transaction(async (tx) => {
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
    });

    await this.#bus.emitAll(events);
    return result;
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
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const { result, events } = await this.#storage.transaction(async (tx) => {
      const created = await tx.transfers.insert(transfer);
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

    // A signature is the provider's fingerprint for the instrument, so the
    // same card charged twice must yield one authorization, not two. Channels
    // without a signature (mobile money) mint a fresh row every time, which is
    // what the provider does.
    const signature = draft.signature ?? null;
    if (signature) {
      const existing = await tx.authorizations.bySignature(payment.provider, signature);
      if (existing) return null;
    }

    const now = this.#clock.nowISO();
    const authorization: Authorization = {
      id: this.#ids.next('aut'),
      provider: payment.provider,
      providerAuthorizationCode:
        draft.providerAuthorizationCode ?? payment.providerTransactionId,
      customerId: payment.customerId,
      paymentId: payment.id,
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
    return this.#appendEvent(tx, {
      type: 'authorization.created',
      provider: created.provider,
      resourceId: created.id,
      resourceType: 'authorization',
      data: authorizationEventData(created),
      previousStatus: null,
      currentStatus: 'active',
    });
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

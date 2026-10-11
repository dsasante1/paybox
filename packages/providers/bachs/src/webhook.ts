import type { Customer, Payment, PayboxEvent, ProviderId } from '@paybox/shared';
import type { Storage } from '@paybox/core';
import type {
  AttemptRecord,
  FormattedWebhook,
  FormatterContext,
  ResponseClassification,
  RetryPolicy,
  SigningContext,
  TransportResult,
  WebhookFormatter,
} from '@paybox/webhooks';
import { createHash } from 'node:crypto';
import { eventId } from './ids.js';
import { refundRecord } from './refunds.js';
import { toDecimal } from './money.js';
import {
  amountPaidOf,
  corridorOf,
  dataTime,
  envelopeTime,
  feeOf,
  paymentMethodDetails,
  serializeWebhookCustomer,
  sessionAmount,
  customerName,
} from './serializers.js';
import { bachsSignatureHeaders } from './signature.js';
import { bachsState, type StoredCheckout } from './state.js';
import { paymentStatusOf, toBachsRefundEventStatus, webhookStatus } from './status.js';

const PROVIDER = 'bachs' as const;

/**
 * Bachs' published retry ladder: "up to 5 tries: the first one, then retries
 * about 1 minute, 5 minutes, 15 minutes and 1 hour after each failed try"
 * (guides/webhooks/overview, read 2026-10-10).
 */
const LADDER_MS = [60_000, 300_000, 900_000, 3_600_000];
export const BACHS_RETRY: RetryPolicy = {
  enabled: true,
  maxAttempts: 5,
  backoff: (attempt) => LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)]!,
};

/** Bachs' reading of a response (guides/webhooks/overview, "Retries"). */
export function classifyBachsResponse(result: TransportResult): ResponseClassification {
  const status = result.status;
  // Timed out or never connected.
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  // "Returns 408 or 429: Try again"; "a 5xx: Try again".
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  // "Returns any other 4xx ... Stop." and "Returns a redirect (3xx) ... Stop.
  // We do not follow redirects."
  return 'stop';
}

/** One Bachs event as stored: the exact payload, so a resend is byte-identical. */
export interface StoredBachsEvent {
  id: string;
  type: string;
  canonicalEventId: string;
  entityType: 'charge' | 'checkout' | 'customer' | 'refund';
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  seq: number;
}

/** One delivery attempt, as Bachs lists it (`WebhookEventAttempt`). */
export interface StoredAttempt {
  id: string;
  eventId: string;
  endpointId: string;
  deliveryId: string;
  attemptNo: number;
  status: 'pending' | 'succeeded' | 'failed';
  callbackUrl: string;
  httpStatus: number | null;
  responseSnippet: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EndpointHealth {
  failingSince: string | null;
  warnedAt: string | null;
}

const HOUR = 3_600_000;

/**
 * Bachs' webhook contract.
 *
 * Bodies follow the event pages (docs.bachs.io/guides/webhooks/events/*), which
 * win over the OpenAPI spec for payloads under docs/bachs.md's source rule.
 * Each Bachs event is built **once**, when its canonical event is published,
 * and stored. That is what makes `id` stable across a resend -- Bachs tells
 * subscribers to deduplicate on it -- and what lets the events API return "the
 * exact JSON body sent to your endpoint, byte for byte".
 */
export class BachsWebhookFormatter implements WebhookFormatter {
  readonly provider: ProviderId = PROVIDER;
  readonly resignsPerAttempt = true;
  readonly followsEndpointChanges = true;
  readonly retry = BACHS_RETRY;
  readonly #organizationId: string;
  #seq: number | null = null;

  constructor(options: { organizationId: string }) {
    this.#organizationId = options.organizationId;
  }

  classifyResponse(result: TransportResult): ResponseClassification {
    return classifyBachsResponse(result);
  }

  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    return bachsSignatureHeaders(rawBody, context.secrets ?? [secret], context.timestamp);
  }

  async format(event: PayboxEvent, context: FormatterContext): Promise<FormattedWebhook[] | null> {
    if (event.provider !== PROVIDER) return null;
    const state = bachsState(context.storage, () => event.createdAt);

    // Already built: a replay of the canonical event re-sends what was sent.
    const known = await context.storage.providerState.get(PROVIDER, `event-canonical:${event.id}`);
    if (known) {
      const ids = (JSON.parse(known) as { ids: string[] }).ids;
      const stored = await Promise.all(ids.map((id) => readEvent(context.storage, id)));
      return stored
        .filter((entry): entry is StoredBachsEvent => entry !== null)
        .map((entry) => ({ eventType: entry.type, body: entry.payload }));
    }

    const drafts = await this.#build(event, context.storage, state);
    if (drafts.length === 0) return null;

    const seq = await this.#reserveSeq(context.storage, drafts.length);
    const built: StoredBachsEvent[] = drafts.map((draft, index) => {
      const id = eventId(event.id, draft.type);
      return {
        id,
        type: draft.type,
        canonicalEventId: event.id,
        entityType: draft.entityType,
        entityId: draft.entityId,
        createdAt: event.createdAt,
        seq: seq + index,
        payload: {
          id,
          type: draft.type,
          created_at: envelopeTime(event.createdAt),
          organization_id: this.#organizationId,
          data: draft.data,
        },
      };
    });

    for (const entry of built) {
      await context.storage.providerState.put(
        PROVIDER,
        `event:${entry.id}`,
        JSON.stringify(entry),
        event.createdAt,
      );
    }
    await context.storage.providerState.put(
      PROVIDER,
      `event-canonical:${event.id}`,
      JSON.stringify({ ids: built.map((entry) => entry.id) }),
      event.createdAt,
    );
    return built.map((entry) => ({ eventType: entry.type, body: entry.payload }));
  }

  /**
   * Events are listed newest first in the order they were built. The counter
   * lives in memory so two concurrent publishes cannot draw the same number,
   * and starts from the highest stored one so it survives a restart.
   */
  async #reserveSeq(storage: Storage, count: number): Promise<number> {
    if (this.#seq === null) {
      const rows = await storage.providerState.listByPrefix(PROVIDER, 'event:');
      const highest = rows.reduce((max, row) => Math.max(max, (JSON.parse(row.value) as StoredBachsEvent).seq), 0);
      // Another publish may have initialised it while this one awaited.
      this.#seq ??= highest + 1;
    }
    const seq = this.#seq;
    this.#seq += count;
    return seq;
  }

  async #build(
    event: PayboxEvent,
    storage: Storage,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft[]> {
    switch (event.resourceType) {
      case 'payment':
        return this.#paymentEvents(event, storage, state);
      case 'refund':
        return this.#refundEvents(event, storage, state);
      case 'customer':
        return this.#customerEvents(event, storage, state);
      case 'checkout':
        return this.#checkoutOnlyEvents(event, storage, state);
      default:
        return [];
    }
  }

  async #paymentEvents(
    event: PayboxEvent,
    storage: Storage,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft[]> {
    const payment = await storage.payments.byId(event.resourceId);
    if (!payment) return [];
    const checkout = await state.checkouts.byPayment(payment.id);
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    const status = paymentStatusOf(payment);
    const priorFailure = await hadFailureBefore(storage, payment.id, event.sequence);

    switch (event.type) {
      case 'payment.successful': {
        const collection = this.#collectionSucceeded(payment, checkout, customer, state);
        const completed = checkout
          ? this.#checkoutCompleted(checkout, payment, customer, state)
          : null;
        return [await collection, ...(completed ? [await completed] : [])];
      }
      case 'payment.failed':
        // "Bachs sends this event once per payment, for the first failure."
        if (priorFailure) return [];
        return [await this.#collectionFailed(payment, checkout, customer, state, 'FAILED')];
      case 'payment.expired': {
        const drafts: Draft[] = [];
        // EXPIRED: "nobody paid before the charge closed" -- unless a failure
        // already reported this charge, which is the one collection.failed
        // it gets.
        if (!priorFailure && event.previousStatus !== 'failed') {
          drafts.push(await this.#collectionFailed(payment, checkout, customer, state, 'EXPIRED'));
        }
        if (checkout) drafts.push(await this.#checkoutExpired(checkout, customer, state));
        return drafts;
      }
      case 'payment.processing':
        // Crypto only: "A bank transfer that arrives short does not send this
        // event: the checkout does not complete" (collection-underpaid).
        if (status === 'underpaid' && corridorOf(payment) === 'CRYPTO') {
          return [this.#collectionUnderpaid(payment, checkout)];
        }
        return [];
      default:
        return [];
    }
  }

  async #collectionSucceeded(
    payment: Payment,
    checkout: StoredCheckout | null,
    customer: Customer | null,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft> {
    const c = payment.currency;
    const status = paymentStatusOf(payment);
    const fee = feeOf(payment) ?? 0;
    const paid = amountPaidOf(payment);
    const overpaid = status === 'overpaid';
    return {
      type: 'collection.succeeded',
      entityType: 'charge',
      entityId: payment.providerTransactionId,
      data: {
        charge_id: payment.providerTransactionId,
        checkout_id: checkout?.id ?? null,
        reference: checkout?.reference ?? null,
        status: webhookStatus(status),
        amount: toDecimal(payment.amount, c),
        currency: c,
        settlement_amount: toDecimal(payment.amount - fee, c),
        settlement_currency: c,
        processing_fee: toDecimal(fee, c),
        processing_fee_currency: c,
        fee_bearer: 'merchant',
        product_cart: cartOf(checkout),
        customer: await webhookCustomerRef(customer, checkout, state),
        payment_method_details: paymentMethodDetails(payment),
        metadata: checkout?.metadata ?? {},
        ...(overpaid
          ? {
              expected_amount: toDecimal(payment.amount, c),
              received_amount: toDecimal(paid, c),
              overpaid_amount: toDecimal(paid - payment.amount, c),
            }
          : {}),
      },
    };
  }

  async #collectionFailed(
    payment: Payment,
    checkout: StoredCheckout | null,
    customer: Customer | null,
    state: ReturnType<typeof bachsState>,
    status: 'FAILED' | 'EXPIRED',
  ): Promise<Draft> {
    const c = payment.currency;
    const fee = feeOf(payment) ?? 0;
    return {
      type: 'collection.failed',
      entityType: 'charge',
      entityId: payment.providerTransactionId,
      data: {
        charge_id: payment.providerTransactionId,
        checkout_id: checkout?.id ?? null,
        reference: checkout?.reference ?? null,
        status,
        amount: toDecimal(payment.amount, c),
        currency: c,
        settlement_amount: toDecimal(payment.amount - fee, c),
        settlement_currency: c,
        processing_fee: null,
        processing_fee_currency: null,
        fee_bearer: 'merchant',
        product_cart: cartOf(checkout),
        customer: await webhookCustomerRef(customer, checkout, state),
        payment_method_details: null,
        reason:
          status === 'EXPIRED'
            ? amountPaidOf(payment) > 0
              ? 'Payment window expired before the full amount was received'
              : 'Payment window expired before payment was received'
            : (payment.failureMessage ?? 'Payment authorization failed'),
        metadata: checkout?.metadata ?? {},
      },
    };
  }

  #collectionUnderpaid(payment: Payment, checkout: StoredCheckout | null): Draft {
    const c = payment.currency;
    const paid = amountPaidOf(payment);
    return {
      type: 'collection.underpaid',
      entityType: 'charge',
      entityId: payment.providerTransactionId,
      data: {
        charge_id: payment.providerTransactionId,
        reference: checkout?.reference ?? null,
        checkout_id: checkout?.id ?? null,
        amount_paid: toDecimal(paid, c),
        amount_expected: toDecimal(payment.amount, c),
        amount_remaining: toDecimal(Math.max(0, payment.amount - paid), c),
        currency: c,
        status: 'UNDERPAID',
        metadata: checkout?.metadata ?? {},
      },
    };
  }

  async #checkoutCompleted(
    checkout: StoredCheckout,
    payment: Payment | null,
    customer: Customer | null,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft> {
    const fee = payment ? (feeOf(payment) ?? 0) : 0;
    const completedAt = payment?.paidAt ?? checkout.completedAt ?? checkout.updatedAt;
    return {
      type: 'checkout.completed',
      entityType: 'checkout',
      entityId: checkout.id,
      data: {
        checkout_id: checkout.id,
        status: 'completed',
        mode: 'payment',
        payment_status: payment ? 'paid' : 'no_payment_required',
        // "`"0"` for a free checkout."
        amount: payment ? sessionAmount(checkout, payment) : '0',
        currency: checkout.currency,
        reference: checkout.reference,
        customer: await webhookCustomer(customer, state),
        customer_details: checkout.customerDetails,
        charge: payment
          ? {
              id: payment.providerTransactionId,
              organization_id: this.#organizationId,
              customer_id: customer?.providerCustomerId ?? null,
              amount: toDecimal(payment.amount, payment.currency),
              currency: payment.currency,
              settlement_currency: payment.currency,
              settlement_amount: toDecimal(payment.amount - fee, payment.currency),
              status: paymentStatusOf(payment),
              metadata: checkout.metadata,
              created_at: dataTime(payment.createdAt),
              updated_at: dataTime(payment.updatedAt),
            }
          : null,
        subscription: null,
        success_url: checkout.successUrl,
        cancel_url: checkout.cancelUrl,
        metadata: checkout.metadata,
        completed_at: envelopeTime(completedAt),
        expires_at: envelopeTime(checkout.expiresAt),
        created_at: envelopeTime(checkout.createdAt),
      },
    };
  }

  async #checkoutExpired(
    checkout: StoredCheckout,
    customer: Customer | null,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft> {
    return {
      type: 'checkout.expired',
      entityType: 'checkout',
      entityId: checkout.id,
      data: {
        checkout_id: checkout.id,
        status: 'expired',
        mode: 'payment',
        payment_status: null,
        amount: toDecimal(checkout.amount ?? 0, checkout.currency),
        currency: checkout.currency,
        reference: checkout.reference,
        customer: await webhookCustomer(customer, state),
        // "An expired checkout has no charge" -- even one that was attempted.
        charge: null,
        subscription: null,
        success_url: checkout.successUrl,
        cancel_url: checkout.cancelUrl,
        metadata: checkout.metadata,
        completed_at: null,
        expires_at: envelopeTime(checkout.expiresAt),
        created_at: envelopeTime(checkout.createdAt),
      },
    };
  }

  /** `checkout.completed` / `checkout.expired` for a session with no payment behind it. */
  async #checkoutOnlyEvents(
    event: PayboxEvent,
    storage: Storage,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft[]> {
    const checkout = await state.checkouts.get(event.resourceId);
    if (!checkout) return [];
    const customer = checkout.customerId ? await storage.customers.byId(checkout.customerId) : null;
    if (event.type === 'checkout.completed') {
      return [await this.#checkoutCompleted(checkout, null, customer, state)];
    }
    if (event.type === 'checkout.expired') {
      return [await this.#checkoutExpired(checkout, customer, state)];
    }
    return [];
  }

  async #refundEvents(
    event: PayboxEvent,
    storage: Storage,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft[]> {
    const type =
      event.type === 'refund.created'
        ? 'refund.created'
        : event.type === 'refund.successful'
          ? 'refund.paid'
          : event.type === 'refund.failed'
            ? 'refund.failed'
            : null;
    if (!type) return [];
    const refund = await storage.refunds.byId(event.resourceId);
    if (!refund) return [];
    const payment = await storage.payments.byId(refund.paymentId);
    if (!payment) return [];
    const stored = await refundRecord(state, refund, payment);
    const c = stored.currency;
    return [
      {
        type,
        entityType: 'refund',
        entityId: stored.id,
        data: {
          refund_id: stored.id,
          charge_id: stored.chargeId,
          reference: stored.reference,
          status: toBachsRefundEventStatus(refund.status),
          requested_amount: toDecimal(stored.requestedAmount, c),
          refunded_amount: toDecimal(refund.status === 'successful' ? refund.amount : 0, c),
          refund_fee_amount: toDecimal(0, c),
          // The event pages' vocabulary: `customer` or `merchant`, where the
          // REST object says `org`.
          fee_bearer: stored.feeBearer === 'org' ? 'merchant' : 'customer',
          reason: stored.reason,
        },
      },
    ];
  }

  async #customerEvents(
    event: PayboxEvent,
    storage: Storage,
    state: ReturnType<typeof bachsState>,
  ): Promise<Draft[]> {
    if (event.type !== 'customer.created' && event.type !== 'customer.updated') return [];
    const customer = await storage.customers.byId(event.resourceId);
    if (!customer) return [];
    const stored = await state.customers.get(customer.providerCustomerId);
    return [
      {
        type: event.type,
        entityType: 'customer',
        entityId: customer.providerCustomerId,
        data: serializeWebhookCustomer(customer, stored),
      },
    ];
  }

  /* ------------------------------ attempt log ------------------------------ */

  async afterAttempt(attempt: AttemptRecord, context: FormatterContext): Promise<void> {
    const { delivery } = attempt;
    if (delivery.provider !== PROVIDER) return;
    const storage = context.storage;
    const evtId = (JSON.parse(delivery.payload) as { id?: string }).id ?? '';
    const ok = attempt.classification === 'delivered';

    // Deterministic per delivery and attempt, so a resend can hand back the
    // attempt id before the attempt runs and this finds the same record.
    const id = attemptId(delivery.id, attempt.attemptNo);
    const existing = await storage.providerState.get(PROVIDER, `attempt:${id}`);
    const prior = existing ? (JSON.parse(existing) as StoredAttempt) : null;
    const record: StoredAttempt = {
      id,
      eventId: evtId,
      endpointId: delivery.endpointId,
      deliveryId: delivery.id,
      attemptNo: prior?.attemptNo ?? (await countAttempts(storage, evtId, delivery.endpointId)) + 1,
      status: ok ? 'succeeded' : 'failed',
      callbackUrl: attempt.url,
      httpStatus: attempt.result.status,
      responseSnippet: attempt.result.body === null ? null : attempt.result.body.slice(0, 500),
      lastError: ok
        ? null
        : (attempt.result.error ??
          (attempt.result.status !== null ? `Endpoint returned HTTP ${attempt.result.status}` : null)),
      createdAt: prior?.createdAt ?? attempt.at,
      updatedAt: attempt.at,
    };
    await storage.providerState.put(PROVIDER, `attempt:${id}`, JSON.stringify(record), attempt.at);
    await this.#trackHealth(storage, delivery.endpointId, ok, attempt.at);
  }

  /**
   * "When an endpoint keeps failing" (guides/webhooks/overview): after 24
   * hours of unbroken failure Bachs warns the owner; after 72 hours, and at
   * least 48 hours after that warning, it turns the endpoint off with
   * `disabled_reason: consecutive_failures`. One success resets the count,
   * every failed try counts, and the check happens only when a delivery fails.
   * paybox sends no email, so the warning is recorded rather than sent.
   */
  async #trackHealth(storage: Storage, endpointId: string, ok: boolean, at: string): Promise<void> {
    const key = `endpoint-health:${endpointId}`;
    if (ok) {
      await storage.providerState.delete(PROVIDER, key);
      return;
    }
    const raw = await storage.providerState.get(PROVIDER, key);
    const health: EndpointHealth = raw
      ? (JSON.parse(raw) as EndpointHealth)
      : { failingSince: at, warnedAt: null };
    const now = Date.parse(at);
    const since = Date.parse(health.failingSince ?? at);
    if (!health.warnedAt && now - since >= 24 * HOUR) health.warnedAt = at;
    const warned = health.warnedAt ? Date.parse(health.warnedAt) : null;
    if (now - since >= 72 * HOUR && warned !== null && now - warned >= 48 * HOUR) {
      const endpoint = await storage.webhooks.endpointById(endpointId);
      if (endpoint?.enabled) {
        await storage.webhooks.updateEndpoint(endpointId, { enabled: false, updatedAt: at });
        const state = bachsState(storage, () => at);
        const stored = await state.endpoints.get(endpointId);
        await state.endpoints.put({
          ...(stored ?? {}),
          id: endpointId,
          name: stored?.name ?? endpoint.description,
          eventSource: stored?.eventSource ?? 'account',
          disabledAt: at,
          disabledReason: 'consecutive_failures',
        });
      }
      await storage.providerState.delete(PROVIDER, key);
      return;
    }
    await storage.providerState.put(PROVIDER, key, JSON.stringify(health), at);
  }
}

interface Draft {
  type: string;
  entityType: StoredBachsEvent['entityType'];
  entityId: string;
  data: Record<string, unknown>;
}

/** `wha_` and 32 hex, stable for a delivery's nth attempt. */
export function attemptId(deliveryId: string, attemptNo: number): string {
  return `wha_${createHash('sha256').update(`${deliveryId}:${attemptNo}`).digest('hex').slice(0, 32)}`;
}

export async function readEvent(storage: Storage, id: string): Promise<StoredBachsEvent | null> {
  const raw = await storage.providerState.get(PROVIDER, `event:${id}`);
  return raw ? (JSON.parse(raw) as StoredBachsEvent) : null;
}

export async function listAttempts(storage: Storage): Promise<StoredAttempt[]> {
  const rows = await storage.providerState.listByPrefix(PROVIDER, 'attempt:');
  return rows.map((row) => JSON.parse(row.value) as StoredAttempt);
}

async function countAttempts(storage: Storage, evtId: string, endpointId: string): Promise<number> {
  const all = await listAttempts(storage);
  return all.filter((entry) => entry.eventId === evtId && entry.endpointId === endpointId).length;
}

/** Whether this payment failed at any point before the event at `sequence`. */
async function hadFailureBefore(storage: Storage, paymentId: string, sequence: number): Promise<boolean> {
  const history = await storage.events.listByResource(paymentId);
  return history.some((entry) => entry.sequence < sequence && entry.currentStatus === 'failed');
}

/** The request's cart, as `collection.*` webhooks echo it; null for a raw-amount checkout. */
function cartOf(checkout: StoredCheckout | null) {
  if (!checkout || checkout.source !== 'cart') return null;
  return checkout.lines.map((line) => ({
    product_id: line.productId,
    quantity: line.quantity,
    ...(line.priceType === 'custom' ? { amount: toDecimal(line.unitAmount, line.currency) } : {}),
  }));
}

/** `{ id, email, name }` on `collection.*`: `id` is always present, null for a guest. */
async function webhookCustomerRef(
  customer: Customer | null,
  checkout: StoredCheckout | null,
  state: ReturnType<typeof bachsState>,
) {
  if (customer) {
    const stored = await state.customers.get(customer.providerCustomerId);
    return {
      id: customer.providerCustomerId,
      email: customer.email,
      name: customerName(customer, stored),
    };
  }
  return {
    id: null,
    email: checkout?.customerDetails?.email ?? null,
    name: checkout?.customerDetails?.name ?? null,
  };
}

/** The full customer object on `checkout.*`, or null when no record backs the checkout. */
async function webhookCustomer(customer: Customer | null, state: ReturnType<typeof bachsState>) {
  if (!customer) return null;
  return serializeWebhookCustomer(customer, await state.customers.get(customer.providerCustomerId));
}

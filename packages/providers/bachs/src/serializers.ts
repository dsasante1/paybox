import type { Customer, Payment, PayboxEvent, Product, Refund } from '@paybox/shared';
import type { WebhookEndpoint } from '@paybox/core';
import { processingFee, type Corridor } from './fees.js';
import { toDecimal, toDecimalOrNull } from './money.js';
import type {
  StoredCheckout,
  StoredCustomer,
  StoredEndpoint,
  StoredLine,
  StoredPrice,
  StoredProduct,
  StoredRefund,
} from './state.js';
import {
  checkoutPaymentStatusFor,
  checkoutStatusFor,
  paymentMessage,
  paymentStatusOf,
  toBachsPaymentStatus,
  toBachsRefundStatus,
  type CheckoutStatus,
} from './status.js';

/**
 * Bachs wire shapes, built from paybox resources.
 *
 * Each function names the OpenAPI component it reproduces (pinned spec,
 * sha256 9c2265585c2b…4810). Field order follows the spec's own examples so a
 * response diffs cleanly against Bachs documentation.
 */

/* ------------------------------- timestamps ------------------------------- */

/**
 * Bachs writes timestamps three ways and each surface keeps its own:
 *
 *   REST objects             2026-07-13T14:00:00.000Z
 *   webhook envelopes        2026-04-27T12:00:00.000000+00:00
 *   most webhook `data`      2026-04-27T12:00:00Z
 *
 * paybox's clock produces the first; the other two are derived from it.
 */
export function envelopeTime(iso: string): string {
  return iso.replace(/\.(\d{3})Z$/, '.$1000+00:00');
}

export function dataTime(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------- pagination ------------------------------- */

/**
 * `PaginationResponse`. Cursors are offsets in disguise -- "Invalid cursor
 * format. Expected 'cur_<offset>'." (guides/pagination) -- so they are made
 * and read the same way.
 */
export function pagination(total: number, limit: number, offset: number, returned: number) {
  const nextOffset = offset + returned;
  return {
    next_cursor: nextOffset < total ? `cur_${nextOffset}` : null,
    prev_cursor: offset > 0 ? `cur_${Math.max(0, offset - limit)}` : null,
    has_more: nextOffset < total,
    limit,
    offset,
    returned,
    total,
  };
}

/* --------------------------------- products -------------------------------- */

function serializePrice(price: StoredPrice) {
  const c = price.currency;
  return {
    currency: c,
    price_type: price.priceType,
    amount: price.priceType === 'fixed' ? toDecimal(price.amount ?? 0, c) : price.priceType === 'free' ? '0.00' : null,
    preset_amount: toDecimalOrNull(price.preset, c),
    minimum_amount: toDecimalOrNull(price.minimum, c),
    maximum_amount: toDecimalOrNull(price.maximum, c),
    currency_options: price.currencyOptions.map((option) => ({
      currency: option.currency,
      amount: toDecimalOrNull(option.amount, option.currency),
      minimum_amount: toDecimalOrNull(option.minimum, option.currency),
      maximum_amount: toDecimalOrNull(option.maximum, option.currency),
    })),
  };
}

/** `ProductResponse.prices`: one row per currency, the primary marked default. */
function serializePrices(price: StoredPrice) {
  const primary = {
    currency: price.currency,
    amount: price.priceType === 'fixed' ? toDecimal(price.amount ?? 0, price.currency) : null,
    minimum_amount: toDecimalOrNull(price.minimum, price.currency),
    maximum_amount: toDecimalOrNull(price.maximum, price.currency),
    is_default: true,
  };
  return [
    primary,
    ...price.currencyOptions.map((option) => ({
      currency: option.currency,
      amount: toDecimalOrNull(option.amount, option.currency),
      minimum_amount: toDecimalOrNull(option.minimum, option.currency),
      maximum_amount: toDecimalOrNull(option.maximum, option.currency),
      is_default: false,
    })),
  ];
}

/** `ProductResponse`. */
export function serializeProduct(
  product: Product,
  stored: StoredProduct,
  context: { organizationId: string; totalPayments: number; totalAmount: number },
) {
  return {
    id: stored.id,
    organization_id: context.organizationId,
    name: product.name,
    description: product.description,
    price: serializePrice(stored.price),
    prices: serializePrices(stored.price),
    billing_cycle: stored.billingCycle,
    trial_period: stored.trialPeriod,
    status: stored.archivedAt ? 'archived' : 'active',
    metadata: product.metadata,
    media: [],
    // "Identifier of the user or key that created the product." The only
    // actor in a local emulator is the sandbox key.
    actor_id: 'key_sandbox_local',
    total_payments: context.totalPayments,
    total_amount: toDecimal(context.totalAmount, stored.price.currency),
    created_at: product.createdAt,
    updated_at: product.updatedAt,
    archived_at: stored.archivedAt,
  };
}

/* -------------------------------- customers -------------------------------- */

function billingAddress(stored: StoredCustomer | null) {
  return stored?.billingAddress ?? null;
}

export function customerName(customer: Customer, stored: StoredCustomer | null): string | null {
  if (stored) return stored.name;
  const joined = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
  return joined || null;
}

/** `CustomerDetailResponse`. */
export function serializeCustomer(customer: Customer, stored: StoredCustomer | null) {
  return {
    customer_id: customer.providerCustomerId,
    email: customer.email,
    name: customerName(customer, stored),
    phone_number: customer.phone,
    metadata: customer.metadata,
    billing_address: billingAddress(stored),
    created_at: customer.createdAt,
    updated_at: customer.updatedAt,
  };
}

/** `CustomerListItem`: no phone, no address, no `updated_at`. */
export function serializeCustomerListItem(customer: Customer, stored: StoredCustomer | null) {
  return {
    customer_id: customer.providerCustomerId,
    email: customer.email,
    name: customerName(customer, stored),
    metadata: customer.metadata,
    created_at: customer.createdAt,
  };
}

/** The customer object inside `customer.*` and `checkout.*` webhooks. */
export function serializeWebhookCustomer(customer: Customer, stored: StoredCustomer | null) {
  return {
    customer_id: customer.providerCustomerId,
    email: customer.email,
    name: customerName(customer, stored),
    phone_number: customer.phone,
    metadata: customer.metadata,
    billing_address: billingAddress(stored),
    created_at: dataTime(customer.createdAt),
    updated_at: dataTime(customer.updatedAt),
  };
}

/* --------------------------------- payments -------------------------------- */

export function corridorOf(payment: Payment): Corridor | null {
  const corridor = payment.paymentMethodDetails.corridor;
  return typeof corridor === 'string' ? (corridor as Corridor) : null;
}

/** What Bachs takes from a payment, in its currency; null until one was attempted. */
export function feeOf(payment: Payment): number | null {
  const corridor = corridorOf(payment);
  return corridor ? processingFee(payment.amount, corridor) : null;
}

/** Amount received so far: the full amount once collected, a partial one when underpaid. */
export function amountPaidOf(payment: Payment): number {
  const recorded = payment.paymentMethodDetails.amount_paid;
  if (typeof recorded === 'number') return recorded;
  const status = paymentStatusOf(payment);
  return ['succeeded', 'accepted', 'overpaid', 'refunded', 'partially_refunded'].includes(status)
    ? payment.amount
    : 0;
}

/**
 * When the payment reached an outcome: paid, or ended without paying.
 * "Completion timestamp when available" -- null while still open.
 */
export function completedAtOf(payment: Payment): string | null {
  if (payment.paidAt) return payment.paidAt;
  return ['failed', 'expired', 'cancelled'].includes(payment.status) ? payment.updatedAt : null;
}

/** True when the status allows a refund at Bachs and the rail supports one. */
export function isRefundable(payment: Payment, hasLiveRefund: boolean): boolean {
  if (hasLiveRefund) return false;
  // guides/refunds: an NGN bank transfer cannot be refunded.
  if (corridorOf(payment) === 'NGN_BANK_TRANSFER') return false;
  // Bachs also refunds an underpaid charge; paybox cannot (docs/bachs.md), and
  // the flag must not promise a refund the API then refuses.
  return ['succeeded', 'accepted'].includes(paymentStatusOf(payment));
}

export interface PaymentContext {
  checkout: StoredCheckout | null;
  customer: { email: string; name: string | null } | null;
  refunds: StoredRefund[];
  history: PayboxEvent[];
  hasLiveRefund: boolean;
}

/** `status_history`: one entry per status change, from the event log. */
export function statusHistory(payment: Payment, history: PayboxEvent[]) {
  return history
    .filter((event) => event.currentStatus !== null)
    .map((event) => ({
      status:
        typeof event.data.provider_status === 'string' && event.data.provider_status
          ? event.data.provider_status
          : toBachsPaymentStatus(event.currentStatus as Payment['status']),
      occurred_at: event.createdAt,
      reason: event.currentStatus === 'failed' ? (payment.failureMessage ?? null) : null,
    }));
}

function lineItems(lines: StoredLine[]) {
  return lines.map((line) => ({
    product_id: line.productId,
    product_name: line.productName,
    quantity: line.quantity,
    unit_amount: toDecimal(line.unitAmount, line.currency),
    currency: line.currency,
    line_total: toDecimal(line.unitAmount * line.quantity, line.currency),
  }));
}

/** `payment_method_details`, keyed by type, as on the payment and `collection.succeeded`. */
export function paymentMethodDetails(payment: Payment): Record<string, unknown> | null {
  const details = payment.paymentMethodDetails;
  const corridor = corridorOf(payment);
  if (!corridor) return null;
  if (corridor === 'NGN_BANK_TRANSFER' && details.virtual_account) {
    return {
      type: 'bank_transfer',
      bank_transfer: {
        sender_name: details.sender_name ?? null,
        sender_bank: details.sender_bank ?? null,
        sender_bank_code: details.sender_bank_code ?? null,
        sender_account_number: details.sender_account_number ?? null,
        session_id: details.session_id ?? null,
        narration: details.narration ?? null,
        virtual_account: details.virtual_account,
      },
    };
  }
  if (corridor === 'USD_CARD' || corridor === 'NGN_CARD') {
    return {
      type: 'card',
      card: { brand: details.brand ?? null, last4: details.last4 ?? null },
    };
  }
  if (corridor === 'CRYPTO') {
    return { type: 'crypto', crypto: { asset: details.asset ?? null, address: details.address ?? null } };
  }
  return {
    type: 'mobile_money',
    mobile_money: { phone_number: details.phone_number ?? null, provider: details.provider ?? null },
  };
}

/** `PaymentResponse`. */
export function serializePayment(payment: Payment, context: PaymentContext) {
  const c = payment.currency;
  const status = paymentStatusOf(payment);
  const fee = feeOf(payment);
  const settled = ['succeeded', 'accepted', 'overpaid', 'refunded', 'partially_refunded'].includes(status);
  const paid = amountPaidOf(payment);
  return {
    reference: context.checkout?.reference ?? null,
    payment_id: payment.providerTransactionId,
    billing_reason: 'purchase',
    checkout_id: context.checkout?.id ?? null,
    status,
    is_refundable: isRefundable(payment, context.hasLiveRefund),
    amount: toDecimal(payment.amount, c),
    amount_paid: toDecimal(paid, c),
    amount_remaining: toDecimal(Math.max(0, payment.amount - paid), c),
    currency: c,
    fee_usd: settled && fee !== null && c === 'USD' ? toDecimal(fee, c) : null,
    fees: fee !== null ? { amount: toDecimal(fee, c), currency: c } : null,
    merchant_bears_cost: true,
    platform_fee: null,
    destination_amount: null,
    fee_paid_by: settled ? 'merchant' : null,
    payment_method: corridorOf(payment),
    channel: 'checkout',
    narration: null,
    meta: context.checkout?.metadata ?? {},
    message: paymentMessage(status),
    customer: context.customer,
    line_items: context.checkout ? lineItems(context.checkout.lines) : null,
    subscription_id: null,
    invoice: null,
    refunds: context.refunds.length > 0 ? context.refunds.map((refund) => refund.id) : null,
    status_history: statusHistory(payment, context.history),
    payment_method_details: paymentMethodDetails(payment),
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
    completed_at: completedAtOf(payment),
  };
}

/**
 * `ChargeStatusResponse` (getChargeStatus) -- a different shape for the same
 * id, as published: `charge_id` rather than `payment_id`, a settlement figure,
 * `metadata` rather than `meta`.
 */
export function serializeChargeStatus(
  payment: Payment,
  context: { organizationId: string; customerId: string | null; checkout: StoredCheckout | null; history: PayboxEvent[] },
) {
  const c = payment.currency;
  const fee = feeOf(payment) ?? 0;
  return {
    charge_id: payment.providerTransactionId,
    organization_id: context.organizationId,
    customer_id: context.customerId,
    amount: toDecimal(payment.amount, c),
    currency: c,
    settlement_currency: c,
    settlement_amount: toDecimal(Math.max(0, payment.amount - fee), c),
    status: paymentStatusOf(payment),
    metadata: context.checkout?.metadata ?? {},
    status_history: statusHistory(payment, context.history),
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
  };
}

/** `PaymentListItemResponse`: a third shape, with `id` and a lowercased method object. */
export function serializePaymentListItem(
  payment: Payment,
  context: { checkout: StoredCheckout | null; customer: { email: string; name: string | null } | null; hasLiveRefund: boolean },
) {
  const c = payment.currency;
  const status = paymentStatusOf(payment);
  const fee = feeOf(payment);
  const settled = ['succeeded', 'accepted', 'overpaid', 'refunded', 'partially_refunded'].includes(status);
  const paid = amountPaidOf(payment);
  const corridor = corridorOf(payment);
  const details = payment.paymentMethodDetails;
  return {
    id: payment.providerTransactionId,
    reference: context.checkout?.reference ?? null,
    status,
    is_refundable: isRefundable(payment, context.hasLiveRefund),
    amount: toDecimal(payment.amount, c),
    customer_name: context.customer?.name ?? '',
    customer_email: context.customer?.email ?? '',
    amount_paid: toDecimal(paid, c),
    amount_remaining: toDecimal(Math.max(0, payment.amount - paid), c),
    settlement_amount: settled && fee !== null ? toDecimal(payment.amount - fee, c) : null,
    settlement_currency: settled ? c : null,
    fee: settled && fee !== null ? toDecimal(fee, c) : null,
    vat: null,
    currency: c,
    meta: context.checkout?.metadata ?? {},
    transaction_date: payment.createdAt,
    completed_at: completedAtOf(payment),
    platform_fee: null,
    destination_amount: null,
    payment_method: corridor
      ? {
          type: corridor.toLowerCase(),
          brand: typeof details.brand === 'string' ? details.brand : null,
          last4: typeof details.last4 === 'string' ? details.last4 : null,
        }
      : null,
    source: {
      type: 'CHECKOUT_SESSION',
      checkout_id: context.checkout?.id ?? null,
      reference: context.checkout?.reference ?? null,
    },
    description: null,
    fee_paid_by: settled ? 'merchant' : null,
  };
}

/* --------------------------------- checkouts -------------------------------- */

/** A session's status: from its payment when it has one, from its own record when not. */
export function sessionStatus(checkout: StoredCheckout, payment: Payment | null): CheckoutStatus {
  return payment ? checkoutStatusFor(payment.status) : checkout.status;
}

/** `CreateCheckoutSessionResponse`. */
export function serializeCheckoutCreated(checkout: StoredCheckout, checkoutUrl: string) {
  return {
    checkout_id: checkout.id,
    checkout_url: checkoutUrl,
    status: checkout.status,
    expires_at: checkout.expiresAt,
    created_at: checkout.createdAt,
    reference: checkout.reference,
    platform_fee: null,
    destination_amount: null,
  };
}

export function sessionLines(checkout: StoredCheckout) {
  return checkout.lines.map((line) => ({
    product_id: line.productId,
    product_name: line.productName,
    quantity: line.quantity,
    unit_amount: toDecimal(line.unitAmount, line.currency),
    currency: line.currency,
    price_type: line.priceType,
    minimum_amount: toDecimalOrNull(line.minimum, line.currency),
    maximum_amount: toDecimalOrNull(line.maximum, line.currency),
    line_total: toDecimal(line.unitAmount * line.quantity, line.currency),
  }));
}

/** The session's amount: the chosen PWYW amount, the fixed total, or "0.00". */
export function sessionAmount(checkout: StoredCheckout, payment: Payment | null): string {
  if (payment && payment.currency === checkout.currency) return toDecimal(payment.amount, checkout.currency);
  return toDecimal(checkout.amount ?? 0, checkout.currency);
}

/** `CheckoutSessionApiResponse`. */
export function serializeCheckout(
  checkout: StoredCheckout,
  payment: Payment | null,
  context: {
    customer: { id: string | null; email: string | null; name: string | null };
    charge: Record<string, unknown> | null;
  },
) {
  const corridor = payment ? corridorOf(payment) : null;
  return {
    checkout_id: checkout.id,
    status: sessionStatus(checkout, payment),
    recurring: null,
    payment_status: payment
      ? checkoutPaymentStatusFor(payment.status)
      : checkout.status === 'open'
        ? checkoutPaymentStatusFor(null)
        : null,
    source_type: 'CHECKOUT_SESSION',
    amount: sessionAmount(checkout, payment),
    currency: checkout.currency,
    reference: checkout.reference,
    charge: context.charge,
    // "Card charges report CARD rather than USD_CARD or NGN_CARD."
    payment_method: corridor === 'USD_CARD' || corridor === 'NGN_CARD' ? 'CARD' : corridor,
    customer: context.customer,
    customer_details: checkout.customerDetails,
    success_url: checkout.successUrl,
    cancel_url: checkout.cancelUrl,
    products: checkout.source === 'cart' ? sessionLines(checkout) : null,
    billing_currency: checkout.billingCurrency,
    platform_fee: null,
    destination_amount: null,
    session_mode: checkout.sessionMode,
    metadata: checkout.metadata,
    created_at: checkout.createdAt,
    expires_at: checkout.expiresAt,
    completed_at: payment ? (payment.paidAt ?? null) : checkout.completedAt,
    updated_at: payment && payment.updatedAt > checkout.updatedAt ? payment.updatedAt : checkout.updatedAt,
  };
}

/* ---------------------------------- refunds --------------------------------- */

/** `RefundResponse`. */
export function serializeRefund(refund: Refund, stored: StoredRefund) {
  const status = toBachsRefundStatus(refund.status);
  return {
    refund_id: stored.id,
    charge_id: stored.chargeId,
    reference: stored.reference,
    status,
    requested_amount: toDecimal(stored.requestedAmount, stored.currency),
    refunded_amount: status === 'success' ? toDecimal(refund.amount, stored.currency) : null,
    refund_fee_amount: toDecimal(0, stored.currency),
    fee_bearer: stored.feeBearer,
    reason: stored.reason,
    created_at: refund.createdAt,
    updated_at: refund.updatedAt,
    // "When the refund reached a terminal status (success or failed)." The
    // engine moves the refund; its last update is that moment.
    completed_at: status === 'processing' ? null : refund.updatedAt,
  };
}

/* ----------------------------- webhook endpoints ---------------------------- */

/** `WebhookEndpoint`. */
export function serializeEndpoint(endpoint: WebhookEndpoint, stored: StoredEndpoint | null) {
  return {
    endpoint_id: endpoint.id,
    name: stored?.name ?? endpoint.description ?? null,
    url: endpoint.url,
    enabled: endpoint.enabled,
    // Only an endpoint that is off has a reason to be off. paybox's control
    // API can turn one back on without passing through the adapter.
    disabled_at: endpoint.enabled ? null : (stored?.disabledAt ?? null),
    disabled_reason: endpoint.enabled ? null : (stored?.disabledReason ?? null),
    event_types: stored ? publicEventTypes(endpoint.eventTypes) : endpoint.eventTypes,
    event_source: stored?.eventSource ?? 'account',
    created_at: endpoint.createdAt,
    updated_at: endpoint.updatedAt,
  };
}

/**
 * An endpoint whose `event_source` is `connect` receives only connected
 * accounts' events, and this emulator has no connected accounts yet. Its
 * subscriptions are stored under a `connect:` prefix that no event type can
 * match, so the dispatcher sends it nothing, and are shown without it.
 */
export const CONNECT_ONLY_PREFIX = 'connect:';

export function publicEventTypes(stored: string[]): string[] {
  return stored.map((type) =>
    type.startsWith(CONNECT_ONLY_PREFIX) ? type.slice(CONNECT_ONLY_PREFIX.length) : type,
  );
}

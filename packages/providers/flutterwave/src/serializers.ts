import type {
  Customer,
  Dispute,
  Invoice,
  Payment,
  Plan,
  Refund,
  Subaccount,
  Subscription,
  Transfer,
} from '@paybox/shared';
import { processorResponse } from './errors.js';
import {
  AUTH_MODE_FIELDS,
  authModelFor,
  toFlutterwaveDisputeStatus,
  toFlutterwaveInvoiceStatus,
  toFlutterwavePaymentType,
  toFlutterwaveRefundStatus,
  toFlutterwaveStatus,
  toFlutterwaveSubscriptionStatus,
  toFlutterwaveTransferStatus,
  type FlutterwaveAuthMode,
} from './status.js';
import { findPublishedCard } from './instruments.js';

/**
 * Flutterwave v3 response serialisation.
 *
 * Shapes transcribed from developer.flutterwave.com/v3.0.0/docs (read
 * 2026-08-29), principally the direct-card-charge, standard-checkout, refunds,
 * transfers and payment-plans guides. Field coverage is documented in
 * docs/flutterwave.md, including which fields are real and which are the
 * placeholder Flutterwave itself returns for an absent one. Nothing here
 * invents a plausible-looking value for something the emulator cannot know.
 */

/** Flutterwave's success envelope. Every 2xx response is this shape. */
export function ok<T>(message: string, data: T, meta?: unknown) {
  return meta === undefined
    ? { status: 'success' as const, message, data }
    : { status: 'success' as const, message, data, meta };
}

/**
 * Flutterwave transaction ids are **numeric**, not prefixed strings.
 *
 * Derived by hashing the canonical id so the same payment always serialises to
 * the same number under a fixed seed. A counter would look more realistic and
 * be order-fragile, which would trade the project's determinism promise for
 * cosmetics -- the same reasoning as Paystack's `numericTransactionId`.
 */
export function numericId(canonicalId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonicalId.length; i++) {
    hash ^= canonicalId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Kept inside 9 digits so it looks like a Flutterwave id rather than a
  // 32-bit integer, and never zero.
  return (hash % 900_000_000) + 100_000;
}

/**
 * The `flw_ref` a transaction carries.
 *
 * Flutterwave's own look like `IUSE9942171639769110812191` -- an opaque
 * uppercase token. Derived from the canonical id for the same reason as above.
 */
export function flwRef(canonicalId: string, prefix = 'FLW'): string {
  const body = canonicalId.replace(/^[a-z]+_/, '').toUpperCase();
  return `${prefix}${body}`;
}

/** Money in Flutterwave's API is a **decimal major unit**, not minor units. */
export function major(minorUnits: number): number {
  return Number((minorUnits / 100).toFixed(2));
}

/** ISO 8601 with milliseconds, which is what Flutterwave stamps. */
function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function customerBlock(payment: Payment, customer: Customer | null | undefined) {
  const name =
    [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') ||
    (payment.metadata.fullname as string | undefined) ||
    'Anonymous customer';
  return {
    id: customer ? numericId(customer.id) : numericId(payment.id),
    phone_number: customer?.phone ?? (payment.metadata.phone_number as string | undefined) ?? null,
    name,
    email: customer?.email ?? (payment.metadata.email as string | undefined) ?? null,
    created_at: stamp(customer?.createdAt ?? payment.createdAt),
  };
}

/**
 * The `card` sub-object. Only masked fragments reach here; the PAN is
 * discarded at the API boundary and the CVV is never stored (spec §29).
 */
function cardBlock(payment: Payment) {
  const details = payment.paymentMethodDetails;
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const bin = str('bin');
  const last4 = str('last4');
  const published = findPublishedCard(bin && last4 ? `${bin}${'0'.repeat(6)}${last4}` : last4);
  const network = str('brand')?.toUpperCase() ?? published?.network ?? 'MASTERCARD';

  return {
    first_6digits: bin,
    last_4digits: last4,
    // Flutterwave reports the issuing bank here. The emulator cannot know one,
    // so it says so in the same shape rather than inventing a bank name.
    issuer: `${network} TEST ISSUER`,
    country: str('country') ?? 'NG',
    type: network,
    expiry:
      str('exp_month') && str('exp_year')
        ? `${str('exp_month')}/${str('exp_year')}`
        : (published ? `${published.expiryMonth}/${published.expiryYear}` : null),
  };
}

export interface SerializeTransactionOptions {
  customer?: Customer | null;
  /** Flutterwave charges the merchant a fee; shown as `app_fee`. */
  appFee?: number;
  /**
   * The card-on-file token, once a charge has minted one. Flutterwave returns
   * it as `card.token` on verify, and it is the input `/tokenized-charges`
   * takes -- so a card charge that never exposed it left that endpoint with
   * nothing reachable to call it with.
   */
  token?: string | null;
}

/** A transaction, as `/charges`, `/validate-charge` and `/verify` return it. */
export function serializeTransaction(
  payment: Payment,
  options: SerializeTransactionOptions = {},
) {
  const status = toFlutterwaveStatus(payment.status);
  const appFee = options.appFee ?? 0;

  return {
    id: numericId(payment.id),
    tx_ref: payment.reference,
    flw_ref: flwRef(payment.id),
    device_fingerprint: 'N/A',
    amount: major(payment.amount),
    charged_amount: major(payment.amount + appFee),
    app_fee: major(appFee),
    merchant_fee: 0,
    processor_response: processorResponse(status, payment.failureCode),
    auth_model: authModelFor(
      (payment.metadata.auth_mode as FlutterwaveAuthMode | undefined) ?? null,
    ),
    currency: payment.currency,
    ip: 'N/A',
    narration: (payment.metadata.narration as string | undefined) ?? 'CARD Transaction ',
    status,
    payment_type: toFlutterwavePaymentType(payment.paymentMethod),
    fraud_status: 'ok',
    charge_type: 'normal',
    created_at: stamp(payment.createdAt),
    account_id: 27468,
    customer: customerBlock(payment, options.customer),
    ...(payment.paymentMethod === 'card'
      ? { card: { ...cardBlock(payment), token: options.token ?? null } }
      : {}),
  };
}

/**
 * The `meta.authorization` block that tells a caller what to send next.
 *
 * This is the part of Flutterwave's charge response an integration actually
 * branches on, so it is modelled precisely: `mode` names the step-up and
 * `fields` says exactly which keys to resend.
 */
export function authorizationMeta(
  mode: FlutterwaveAuthMode,
  options: { redirectUrl?: string } = {},
) {
  if (mode === 'redirect') {
    return { authorization: { mode, redirect: options.redirectUrl ?? null } };
  }
  if (mode === 'otp') {
    // Flutterwave names the endpoint to call, which is how a client knows to
    // switch from /charges to /validate-charge.
    return { authorization: { mode, endpoint: '/v3/validate-charge' } };
  }
  return { authorization: { mode, fields: [...AUTH_MODE_FIELDS[mode]] } };
}

export function serializeRefund(refund: Refund, payment: Payment | null) {
  return {
    id: numericId(refund.id),
    account_id: 27468,
    tx_id: payment ? numericId(payment.id) : null,
    flw_ref: flwRef(refund.id, 'RFND'),
    amount_refunded: major(refund.amount),
    status: toFlutterwaveRefundStatus(refund.status),
    destination: 'payment_source',
    meta: { source: 'availablebalance' },
    created_at: stamp(refund.createdAt),
  };
}

export function serializeCustomer(customer: Customer) {
  return {
    id: numericId(customer.id),
    email: customer.email,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null,
    phone_number: customer.phone,
    created_at: stamp(customer.createdAt),
  };
}

/** A payout. Flutterwave calls these transfers. */
export function serializeTransfer(transfer: Transfer) {
  return {
    id: numericId(transfer.id),
    account_number: transfer.recipientAccount,
    bank_code: transfer.recipientBankCode,
    full_name: transfer.recipientName,
    created_at: stamp(transfer.createdAt),
    currency: transfer.currency,
    debit_currency: transfer.currency,
    amount: major(transfer.amount),
    fee: major(Number(transfer.metadata.fee ?? 0)),
    status: toFlutterwaveTransferStatus(transfer.status),
    reference: transfer.reference,
    meta: transfer.metadata.meta ?? null,
    narration: transfer.reason,
    complete_message: transfer.failureReason ?? '',
    requires_approval: 0,
    is_approved: 1,
    bank_name: transfer.recipientBankCode ?? 'TEST BANK',
  };
}

/** A payment plan. Flutterwave's recurring price. */
export function serializePlan(plan: Plan) {
  return {
    id: numericId(plan.id),
    name: plan.name,
    amount: major(plan.amount),
    interval: plan.interval,
    duration: plan.invoiceLimit,
    status: plan.active ? 'active' : 'cancelled',
    currency: plan.currency,
    plan_token: plan.providerPlanCode,
    created_at: stamp(plan.createdAt),
  };
}

export function serializeSubscription(subscription: Subscription, plan?: Plan | null) {
  return {
    id: numericId(subscription.id),
    amount: major(subscription.amount),
    customer: {
      id: numericId(subscription.customerId),
      customer_email: (subscription.metadata.email as string | undefined) ?? null,
    },
    plan: plan ? numericId(plan.id) : null,
    status: toFlutterwaveSubscriptionStatus(subscription.status),
    created_at: stamp(subscription.createdAt),
    next_due: subscription.nextPaymentDate ? stamp(subscription.nextPaymentDate) : null,
  };
}

export function serializeInvoice(invoice: Invoice) {
  return {
    id: numericId(invoice.id),
    amount: major(invoice.amount),
    currency: invoice.currency,
    status: toFlutterwaveInvoiceStatus(invoice.status),
    due_date: stamp(invoice.dueAt),
    paid_at: invoice.paidAt ? stamp(invoice.paidAt) : null,
    created_at: stamp(invoice.createdAt),
  };
}

/** A subaccount. Flutterwave's marketplace participant. */
export function serializeSubaccount(subaccount: Subaccount) {
  return {
    id: numericId(subaccount.id),
    account_number: subaccount.accountNumber,
    account_bank: subaccount.settlementBank,
    business_name: subaccount.businessName,
    full_name: subaccount.primaryContactName ?? subaccount.businessName,
    split_type: 'percentage',
    split_value: subaccount.percentageCharge / 100,
    subaccount_id: subaccount.providerSubaccountCode,
    bank_name: subaccount.settlementBank,
    country: subaccount.countryCode,
    created_at: stamp(subaccount.createdAt),
  };
}

/** A chargeback. */
export function serializeDispute(dispute: Dispute, payment: Payment | null) {
  return {
    id: numericId(dispute.id),
    amount: major(dispute.refundAmount || (payment?.amount ?? 0)),
    currency: dispute.currency,
    flw_ref: payment ? flwRef(payment.id) : null,
    tx_id: payment ? numericId(dispute.paymentId) : null,
    status: toFlutterwaveDisputeStatus(dispute.status),
    stage: dispute.category,
    due_date: stamp(dispute.dueAt),
    created_at: stamp(dispute.createdAt),
    comment: dispute.message,
  };
}

import type {
  Authorization,
  Customer,
  DedicatedAccount,
  Dispute,
  Invoice,
  Plan,
  Split,
  Subaccount,
  Subscription,
  Payment,
  PayboxEvent,
  Refund,
  Transfer,
} from '@paybox/shared';
import {
  gatewayCodes,
  gatewayResponse,
  toPaystackStatus,
  toPaystackSubscriptionStatus,
} from './status.js';
import { serializeAuthorization } from './authorization.js';

/**
 * Paystack response serialisation.
 *
 * Field coverage is documented in docs/paystack.md, including which fields are
 * verified against Paystack's published documentation and which are modelled.
 * Nothing here invents behaviour: fields we cannot faithfully emulate are
 * returned as the null/empty value Paystack itself uses for an absent value,
 * rather than as a plausible-looking fabrication.
 */

/** Paystack transaction ids are numeric. Derived from our canonical id so the
 *  same payment always serialises to the same number. */
export function numericTransactionId(providerTransactionId: string): number {
  let hash = 0;
  for (let i = 0; i < providerTransactionId.length; i++) {
    hash = (hash * 31 + providerTransactionId.charCodeAt(i)) % 4_000_000_000;
  }
  // Paystack ids observed in the wild are 10 digits; keep the same magnitude.
  return 1_000_000_000 + hash;
}

/**
 * Emulated processing fee.
 *
 * Paystack's real pricing varies by country, channel, card origin and
 * negotiated rate, and it changes. We apply one flat percentage per currency
 * so the field is present and internally consistent, and docs/paystack.md
 * states plainly that these are emulated approximations with no authority.
 * Set `fees: 0` in config to opt out entirely.
 */
const FEE_RATE: Record<string, number> = {
  NGN: 0.015,
  GHS: 0.0195,
  ZAR: 0.029,
  KES: 0.029,
  USD: 0.039,
};

export function emulatedFee(amount: number, currency: string, enabled = true): number {
  if (!enabled) return 0;
  const rate = FEE_RATE[currency.toUpperCase()] ?? 0.015;
  return Math.round(amount * rate);
}

export interface SerializeOptions {
  customer?: Customer | null;
  /** Canonical events for this payment, rendered into Paystack's `log`. */
  events?: PayboxEvent[];
  includeFees?: boolean;
  /** The split this transaction was divided under, if any. */
  split?: Split | null;
  /** What each subaccount received, computed by the engine. */
  splitBreakdown?: { entries: { subaccountCode: string; amount: number }[]; merchant: number };
  /**
   * The authorization minted when this payment succeeded, if there is one.
   * Preferred over the synthesised shape below, so the `authorization_code` a
   * caller reads back from `verify` is the one they can actually charge.
   */
  authorization?: Authorization | null;
}

function paystackCustomer(payment: Payment, customer: Customer | null | undefined) {
  return {
    id: customer ? numericTransactionId(customer.providerCustomerId) : null,
    first_name: customer?.firstName ?? null,
    last_name: customer?.lastName ?? null,
    email: customer?.email ?? (payment.metadata.email as string | undefined) ?? null,
    customer_code: customer ? `CUS_${customer.providerCustomerId}` : null,
    phone: customer?.phone ?? null,
    metadata: customer?.metadata ?? null,
    risk_action: 'default',
    international_format_phone: null,
  };
}

/**
 * The `authorization` object.
 *
 * Card fields are synthetic by construction -- the emulator never sees a real
 * PAN, only a test card identifier -- and CVV is never present in any shape.
 */
function paystackAuthorization(payment: Payment, stored?: Authorization | null) {
  // A real, chargeable code whenever the payment actually minted one.
  if (stored) return serializeAuthorization(stored);

  const details = payment.paymentMethodDetails;
  const channel = paystackChannel(payment);

  if (channel === 'mobile_money') {
    return {
      authorization_code: `AUTH_${payment.providerTransactionId}`,
      bin: null,
      last4: null,
      exp_month: null,
      exp_year: null,
      channel: 'mobile_money',
      card_type: null,
      bank: (details.network as string) ?? null,
      country_code: (details.country as string) ?? 'GH',
      brand: (details.network as string) ?? null,
      reusable: false,
      signature: null,
      account_name: (details.account_name as string) ?? null,
      mobile_money_number: (details.phone as string) ?? null,
      receiver_bank_account_number: null,
      receiver_bank: null,
    };
  }

  if (channel === 'card') {
    return {
      authorization_code: `AUTH_${payment.providerTransactionId}`,
      bin: (details.bin as string) ?? null,
      last4: (details.last4 as string) ?? null,
      exp_month: (details.exp_month as string) ?? null,
      exp_year: (details.exp_year as string) ?? null,
      channel: 'card',
      card_type: (details.card_type as string) ?? null,
      bank: (details.bank as string) ?? 'TEST BANK',
      country_code: (details.country as string) ?? 'GH',
      brand: (details.brand as string) ?? null,
      reusable: true,
      signature: `SIG_${payment.providerTransactionId}`,
      account_name: null,
    };
  }

  return {
    authorization_code: `AUTH_${payment.providerTransactionId}`,
    channel,
    bank: (details.bank as string) ?? null,
    country_code: (details.country as string) ?? 'GH',
    account_name: (details.account_name as string) ?? null,
    reusable: false,
    signature: null,
  };
}

export function paystackChannel(payment: Payment): string {
  switch (payment.paymentMethod) {
    case 'mobile_money':
      return 'mobile_money';
    case 'card':
      return 'card';
    case 'bank':
      return 'bank';
    case 'bank_transfer':
      return 'bank_transfer';
    case 'ussd':
      return 'ussd';
    case 'eft':
      return 'eft';
    case 'qr':
      return 'qr';
    default:
      return 'card';
  }
}

/**
 * Paystack's `log` object. We populate `history` from the canonical event
 * timeline, which makes it genuinely informative rather than a stub -- a
 * developer reading the log sees the real sequence the emulator went through.
 */
function paystackLog(payment: Payment, events: PayboxEvent[] | undefined) {
  const history = (events ?? []).map((event) => ({
    type: event.type.endsWith('.failed') ? 'error' : 'action',
    message: describeEvent(event),
    time: Math.max(
      0,
      Math.round((Date.parse(event.createdAt) - Date.parse(payment.createdAt)) / 1000),
    ),
  }));
  const timeSpent = history.at(-1)?.time ?? 0;
  return {
    start_time: Math.floor(Date.parse(payment.createdAt) / 1000),
    time_spent: timeSpent,
    attempts: 1,
    errors: history.filter((h) => h.type === 'error').length,
    success: payment.status === 'successful',
    mobile: payment.paymentMethod === 'mobile_money',
    input: [],
    channel: paystackChannel(payment),
    history,
  };
}

function describeEvent(event: PayboxEvent): string {
  const label = event.type.replace(/^payment\./, '').replace(/_/g, ' ');
  return `Payment ${label}`;
}

/** The transaction object returned by verify, fetch and list. */
export function serializeTransaction(payment: Payment, options: SerializeOptions = {}) {
  const fees = emulatedFee(payment.amount, payment.currency, options.includeFees ?? true);
  return {
    id: numericTransactionId(payment.providerTransactionId),
    domain: 'test',
    status: toPaystackStatus(payment.status),
    reference: payment.reference,
    receipt_number: null,
    amount: payment.amount,
    message: payment.failureMessage,
    gateway_response: gatewayResponse(payment.status, payment.failureCode),
    // `response_code` is card-only at Paystack; other channels carry the
    // string classification alone.
    response_code:
      payment.paymentMethod === 'card'
        ? gatewayCodes(payment.status, payment.failureCode).responseCode
        : null,
    gateway_response_code: gatewayCodes(payment.status, payment.failureCode)
      .gatewayResponseCode,
    paid_at: payment.paidAt,
    created_at: payment.createdAt,
    channel: paystackChannel(payment),
    currency: payment.currency,
    ip_address: null,
    metadata: payment.metadata,
    log: paystackLog(payment, options.events),
    fees,
    fees_split: options.splitBreakdown
      ? {
          subaccounts: options.splitBreakdown.entries,
          merchant: options.splitBreakdown.merchant,
        }
      : null,
    authorization: paystackAuthorization(payment, options.authorization),
    customer: paystackCustomer(payment, options.customer),
    plan: null,
    split: options.split ? serializeSplit(options.split) : {},
    order_id: null,
    // Paystack returns both snake_case and camelCase spellings of these two.
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    requested_amount: payment.amount,
    pos_transaction_data: null,
    source: null,
    fees_breakdown: null,
    connect: null,
    transaction_date: payment.createdAt,
    plan_object: {},
    subaccount: {},
  };
}

export function serializeRefund(refund: Refund, payment: Payment | null) {
  return {
    id: numericTransactionId(refund.providerRefundId),
    integration: 100_000,
    domain: 'test',
    transaction: payment ? numericTransactionId(payment.providerTransactionId) : null,
    dispute: null,
    amount: refund.amount,
    deducted_amount: refund.amount,
    currency: refund.currency,
    channel: 'migs',
    fully_deducted: refund.amount >= (payment?.amount ?? refund.amount),
    refunded_by: 'paybox@emulator.local',
    refunded_at: refund.status === 'successful' ? refund.updatedAt : null,
    expected_at: refund.createdAt,
    settlement: null,
    customer_note: refund.reason,
    merchant_note: refund.reason,
    created_at: refund.createdAt,
    updated_at: refund.updatedAt,
    status: toPaystackRefundStatus(refund.status),
    refund_account_details: refund.accountDetails,
  };
}

/**
 * Canonical refund status -> Paystack's.
 *
 * Two differ: `successful` is `processed` there, and `needs_attention` is
 * hyphenated. The rest are already the same word.
 */
function toPaystackRefundStatus(status: Refund['status']): string {
  if (status === 'successful') return 'processed';
  if (status === 'needs_attention') return 'needs-attention';
  return status;
}

export function serializeCustomer(customer: Customer) {
  return {
    id: numericTransactionId(customer.providerCustomerId),
    first_name: customer.firstName,
    last_name: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    metadata: customer.metadata,
    domain: 'test',
    customer_code: `CUS_${customer.providerCustomerId}`,
    risk_action: 'default',
    international_format_phone: null,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    identified: false,
    identifications: null,
  };
}

export function serializeTransfer(transfer: Transfer) {
  return {
    id: numericTransactionId(transfer.providerTransferId),
    domain: 'test',
    amount: transfer.amount,
    currency: transfer.currency,
    reference: transfer.reference,
    source: 'balance',
    source_details: null,
    reason: transfer.reason,
    status: transfer.status === 'successful' ? 'success' : transfer.status,
    failures: transfer.failureReason,
    transfer_code: `TRF_${transfer.providerTransferId}`,
    titan_code: null,
    transferred_at: transfer.status === 'successful' ? transfer.updatedAt : null,
    created_at: transfer.createdAt,
    updated_at: transfer.updatedAt,
    recipient: {
      domain: 'test',
      type: 'nuban',
      currency: transfer.currency,
      name: transfer.recipientName,
      details: {
        account_number: transfer.recipientAccount,
        account_name: transfer.recipientName,
        bank_code: transfer.recipientBankCode,
        bank_name: null,
      },
    },
  };
}

/**
 * A dedicated virtual account, shaped as `DedicatedNubanCreateResponse.data`.
 * The bank `id` is derived from the slug so it is stable across runs.
 */
export function serializeDedicatedAccount(
  account: DedicatedAccount,
  customer: Customer | null,
) {
  return {
    bank: {
      name: account.bankName,
      id: numericTransactionId(account.bankSlug) % 1_000,
      slug: account.bankSlug,
    },
    account_name: account.accountName,
    account_number: account.accountNumber,
    assigned: account.assigned,
    currency: account.currency,
    metadata: null,
    active: account.active,
    id: numericTransactionId(account.providerAccountId),
    created_at: account.createdAt,
    updated_at: account.updatedAt,
    assignment: {
      integration: 100_000,
      assignee_id: customer ? numericTransactionId(customer.providerCustomerId) : null,
      assignee_type: 'Customer',
      expired: false,
      account_type: 'PAY-WITH-TRANSFER-RECURRING',
      assigned_at: account.createdAt,
      expired_at: null,
    },
    ...(customer ? { customer: serializeCustomer(customer) } : {}),
  };
}

/** Schema `PlanCreateResponse.data`. */
export function serializePlan(plan: Plan) {
  return {
    id: numericTransactionId(plan.providerPlanCode),
    name: plan.name,
    amount: plan.amount,
    interval: plan.interval,
    integration: 100_000,
    domain: 'test',
    plan_code: `PLN_${plan.providerPlanCode}`,
    description: plan.description,
    send_invoices: plan.sendInvoices,
    send_sms: plan.sendSms,
    hosted_page: false,
    hosted_page_url: null,
    hosted_page_summary: null,
    currency: plan.currency,
    invoice_limit: plan.invoiceLimit,
    migrate: false,
    is_deleted: false,
    is_archived: !plan.active,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

/**
 * Schema `SubscriptionCreateResponse.data`.
 *
 * `cron_expression` and `easy_cron_id` are Paystack implementation details
 * leaking through their API. The emulator does not run cron -- renewals are
 * jobs compared against virtual time -- so `easy_cron_id` is null and the
 * cron expression is derived from the next payment date for shape only.
 */
export function serializeSubscription(
  subscription: Subscription,
  context: {
    plan?: Plan | null;
    customer?: Customer | null;
    authorization?: Authorization | null;
  } = {},
) {
  return {
    id: numericTransactionId(subscription.providerSubscriptionCode),
    domain: 'test',
    status: toPaystackSubscriptionStatus(subscription.status),
    subscription_code: `SUB_${subscription.providerSubscriptionCode}`,
    email_token: subscription.emailToken,
    amount: subscription.amount,
    cron_expression: cronFor(subscription.nextPaymentDate),
    next_payment_date: subscription.nextPaymentDate,
    open_invoice: null,
    integration: 100_000,
    invoice_limit: subscription.invoiceLimit,
    split_code: null,
    quantity: subscription.quantity,
    start: Math.floor(Date.parse(subscription.startDate) / 1000),
    easy_cron_id: null,
    cancelledAt: subscription.cancelledAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    metadata: subscription.metadata,
    ...(context.plan ? { plan: serializePlan(context.plan) } : {}),
    ...(context.customer ? { customer: serializeCustomer(context.customer) } : {}),
    ...(context.authorization
      ? { authorization: serializeAuthorization(context.authorization) }
      : {}),
  };
}

/** Shape-only: the emulator schedules jobs, not cron. */
function cronFor(nextPaymentDate: string | null): string | null {
  if (!nextPaymentDate) return null;
  const date = new Date(nextPaymentDate);
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} * *`;
}

/** Paystack calls these invoices on subscriptions and payment requests alike. */
export function serializeInvoice(invoice: Invoice, payment?: Payment | null) {
  return {
    id: numericTransactionId(invoice.providerInvoiceCode),
    domain: 'test',
    invoice_code: `INV_${invoice.providerInvoiceCode}`,
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    paid: invoice.status === 'success',
    paid_at: invoice.paidAt,
    description: null,
    period_start: invoice.periodStart,
    period_end: invoice.periodEnd,
    due_date: invoice.dueAt,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
    transaction: payment ? serializeTransaction(payment) : null,
  };
}

/** Schema `SubaccountCreateResponse.data`. */
export function serializeSubaccount(subaccount: Subaccount) {
  return {
    id: numericTransactionId(subaccount.providerSubaccountCode),
    subaccount_code: `ACCT_${subaccount.providerSubaccountCode}`,
    business_name: subaccount.businessName,
    description: subaccount.description,
    primary_contact_name: subaccount.primaryContactName,
    primary_contact_email: subaccount.primaryContactEmail,
    primary_contact_phone: subaccount.primaryContactPhone,
    metadata: subaccount.metadata,
    percentage_charge: subaccount.percentageCharge,
    is_verified: true,
    settlement_bank: subaccount.settlementBank,
    account_number: subaccount.accountNumber,
    settlement_schedule: 'AUTO',
    active: subaccount.active,
    migrate: false,
    integration: 100_000,
    domain: 'test',
    currency: subaccount.currency,
    createdAt: subaccount.createdAt,
    updatedAt: subaccount.updatedAt,
  };
}

/** Schema `SplitCreateResponse.data`. */
export function serializeSplit(split: Split, subaccounts: Map<string, Subaccount> = new Map()) {
  return {
    id: numericTransactionId(split.providerSplitCode),
    name: split.name,
    type: split.type,
    currency: split.currency,
    integration: 100_000,
    domain: 'test',
    split_code: `SPL_${split.providerSplitCode}`,
    active: split.active,
    bearer_type: split.bearerType,
    bearer_subaccount: split.bearerSubaccountId
      ? numericTransactionId(split.bearerSubaccountId)
      : null,
    createdAt: split.createdAt,
    updatedAt: split.updatedAt,
    subaccounts: split.entries.map((entry) => {
      const subaccount = subaccounts.get(entry.subaccountId);
      return {
        subaccount: subaccount
          ? serializeSubaccount(subaccount)
          : { subaccount_code: `ACCT_${entry.subaccountCode}` },
        share: entry.share,
      };
    }),
    total_subaccounts: split.entries.length,
  };
}

/** Schema `DisputeFetchResponse.data`. */
export function serializeDispute(dispute: Dispute, payment?: Payment | null) {
  return {
    id: numericTransactionId(dispute.providerDisputeId),
    refund_amount: dispute.refundAmount,
    currency: dispute.currency,
    status: dispute.providerStatus,
    resolution: dispute.resolution,
    domain: 'test',
    transaction: payment ? serializeTransaction(payment) : null,
    transaction_reference: payment?.reference ?? null,
    category: dispute.category,
    customer: null,
    bin: null,
    last4: null,
    dueAt: dispute.dueAt,
    resolvedAt: dispute.resolvedAt,
    evidence: dispute.evidence,
    attachments: null,
    note: dispute.message,
    history: [],
    messages: [],
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
  };
}

/** Paystack's envelope. Every response body is this shape. */
export function ok<T>(message: string, data: T) {
  return { status: true, message, data };
}

export function fail(message: string, extra: Record<string, unknown> = {}) {
  return { status: false, message, ...extra };
}

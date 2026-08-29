import type {
  Authorization,
  Customer,
  DedicatedAccount,
  Dispute,
  DisputeResolution,
  DisputeStatus,
  InstrumentSetup,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  LedgerEntry,
  Metadata,
  Payment,
  PaymentMethod,
  PaymentStatus,
  PayboxEvent,
  Plan,
  PlanInterval,
  Product,
  ProviderId,
  Refund,
  RefundStatus,
  SetupStatus,
  Split,
  SplitEntry,
  Subaccount,
  Subscription,
  SubscriptionItem,
  SubscriptionStatus,
  Transfer,
  TransferStatus,
} from '@paybox/shared';
import type {
  DeliveryStatus,
  Job,
  JobStatus,
  TransferRecipient,
  WebhookDelivery,
  WebhookEndpoint,
} from '@paybox/core';
import type {
  AuthorizationRow,
  DedicatedAccountRow,
  DisputeRow,
  InstrumentSetupRow,
  InvoiceItemRow,
  InvoiceRow,
  LedgerEntryRow,
  PlanRow,
  ProductRow,
  SplitRow,
  SubaccountRow,
  SubscriptionItemRow,
  SubscriptionRow,
  TransferRecipientRow,
  CustomerRow,
  EventRow,
  JobRow,
  PaymentRow,
  RefundRow,
  TransferRow,
  WebhookDeliveryRow,
  WebhookEndpointRow,
} from './schema.js';

/** Tolerant JSON read: a hand-edited database should not crash the emulator. */
function readJson(value: string | null, fallback: Metadata = {}): Metadata {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Metadata) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  provider: row.provider as ProviderId,
  reference: row.reference,
  providerTransactionId: row.provider_transaction_id,
  amount: row.amount,
  currency: row.currency,
  status: row.status as PaymentStatus,
  providerStatus: row.provider_status,
  paymentMethod: row.payment_method as PaymentMethod | null,
  paymentMethodDetails: readJson(row.payment_method_details),
  customerId: row.customer_id,
  callbackUrl: row.callback_url,
  amountRefunded: row.amount_refunded,
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  authorizedAt: row.authorized_at,
  paidAt: row.paid_at,
});

export const fromPayment = (payment: Payment): PaymentRow => ({
  id: payment.id,
  provider: payment.provider,
  reference: payment.reference,
  provider_transaction_id: payment.providerTransactionId,
  amount: payment.amount,
  currency: payment.currency,
  status: payment.status,
  provider_status: payment.providerStatus,
  payment_method: payment.paymentMethod,
  payment_method_details: writeJson(payment.paymentMethodDetails),
  customer_id: payment.customerId,
  callback_url: payment.callbackUrl,
  amount_refunded: payment.amountRefunded,
  failure_code: payment.failureCode,
  failure_message: payment.failureMessage,
  metadata: writeJson(payment.metadata),
  created_at: payment.createdAt,
  updated_at: payment.updatedAt,
  expires_at: payment.expiresAt,
  authorized_at: payment.authorizedAt,
  paid_at: payment.paidAt,
});

/** Domain patch -> column patch. Only keys actually present are emitted, so a
 *  partial update never clobbers a column with undefined. */
export function paymentPatch(patch: Partial<Payment>): Partial<PaymentRow> {
  const out: Partial<PaymentRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.paymentMethod !== undefined) out.payment_method = patch.paymentMethod;
  if (patch.paymentMethodDetails !== undefined) {
    out.payment_method_details = writeJson(patch.paymentMethodDetails);
  }
  if (patch.customerId !== undefined) out.customer_id = patch.customerId;
  if (patch.callbackUrl !== undefined) out.callback_url = patch.callbackUrl;
  if (patch.amountRefunded !== undefined) out.amount_refunded = patch.amountRefunded;
  if (patch.failureCode !== undefined) out.failure_code = patch.failureCode;
  if (patch.failureMessage !== undefined) out.failure_message = patch.failureMessage;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  if (patch.expiresAt !== undefined) out.expires_at = patch.expiresAt;
  if (patch.authorizedAt !== undefined) out.authorized_at = patch.authorizedAt;
  if (patch.paidAt !== undefined) out.paid_at = patch.paidAt;
  return out;
}

export const toRefund = (row: RefundRow): Refund => ({
  id: row.id,
  paymentId: row.payment_id,
  provider: row.provider as ProviderId,
  providerRefundId: row.provider_refund_id,
  amount: row.amount,
  currency: row.currency,
  status: row.status as RefundStatus,
  providerStatus: row.provider_status,
  reason: row.reason,
  accountDetails: row.account_details ? readJson(row.account_details) : null,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromRefund = (refund: Refund): RefundRow => ({
  id: refund.id,
  payment_id: refund.paymentId,
  provider: refund.provider,
  provider_refund_id: refund.providerRefundId,
  amount: refund.amount,
  currency: refund.currency,
  status: refund.status,
  provider_status: refund.providerStatus,
  reason: refund.reason,
  account_details: refund.accountDetails ? writeJson(refund.accountDetails) : null,
  metadata: writeJson(refund.metadata),
  created_at: refund.createdAt,
  updated_at: refund.updatedAt,
});

export function refundPatch(patch: Partial<Refund>): Partial<RefundRow> {
  const out: Partial<RefundRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.reason !== undefined) out.reason = patch.reason;
  if (patch.accountDetails !== undefined) {
    out.account_details = patch.accountDetails ? writeJson(patch.accountDetails) : null;
  }
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toTransfer = (row: TransferRow): Transfer => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerTransferId: row.provider_transfer_id,
  reference: row.reference,
  amount: row.amount,
  currency: row.currency,
  status: row.status as TransferStatus,
  providerStatus: row.provider_status,
  recipientName: row.recipient_name,
  recipientAccount: row.recipient_account,
  recipientBankCode: row.recipient_bank_code,
  reason: row.reason,
  failureReason: row.failure_reason,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromTransfer = (transfer: Transfer): TransferRow => ({
  id: transfer.id,
  provider: transfer.provider,
  provider_transfer_id: transfer.providerTransferId,
  reference: transfer.reference,
  amount: transfer.amount,
  currency: transfer.currency,
  status: transfer.status,
  provider_status: transfer.providerStatus,
  recipient_name: transfer.recipientName,
  recipient_account: transfer.recipientAccount,
  recipient_bank_code: transfer.recipientBankCode,
  reason: transfer.reason,
  failure_reason: transfer.failureReason,
  metadata: writeJson(transfer.metadata),
  created_at: transfer.createdAt,
  updated_at: transfer.updatedAt,
});

export function transferPatch(patch: Partial<Transfer>): Partial<TransferRow> {
  const out: Partial<TransferRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.failureReason !== undefined) out.failure_reason = patch.failureReason;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toCustomer = (row: CustomerRow): Customer => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerCustomerId: row.provider_customer_id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromCustomer = (customer: Customer): CustomerRow => ({
  id: customer.id,
  provider: customer.provider,
  provider_customer_id: customer.providerCustomerId,
  email: customer.email,
  first_name: customer.firstName,
  last_name: customer.lastName,
  phone: customer.phone,
  metadata: writeJson(customer.metadata),
  created_at: customer.createdAt,
  updated_at: customer.updatedAt,
});

export function customerPatch(patch: Partial<Customer>): Partial<CustomerRow> {
  const out: Partial<CustomerRow> = {};
  if (patch.email !== undefined) out.email = patch.email;
  if (patch.firstName !== undefined) out.first_name = patch.firstName;
  if (patch.lastName !== undefined) out.last_name = patch.lastName;
  if (patch.phone !== undefined) out.phone = patch.phone;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toAuthorization = (row: AuthorizationRow): Authorization => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerAuthorizationCode: row.provider_authorization_code,
  customerId: row.customer_id,
  paymentId: row.payment_id,
  channel: row.channel as PaymentMethod,
  bin: row.bin,
  last4: row.last4,
  expMonth: row.exp_month,
  expYear: row.exp_year,
  cardType: row.card_type,
  bank: row.bank,
  brand: row.brand,
  countryCode: row.country_code,
  signature: row.signature,
  reusable: row.reusable === 1,
  active: row.active === 1,
  accountName: row.account_name,
  mobileMoneyNumber: row.mobile_money_number,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromAuthorization = (auth: Authorization): AuthorizationRow => ({
  id: auth.id,
  provider: auth.provider,
  provider_authorization_code: auth.providerAuthorizationCode,
  customer_id: auth.customerId,
  payment_id: auth.paymentId,
  channel: auth.channel,
  bin: auth.bin,
  last4: auth.last4,
  exp_month: auth.expMonth,
  exp_year: auth.expYear,
  card_type: auth.cardType,
  bank: auth.bank,
  brand: auth.brand,
  country_code: auth.countryCode,
  signature: auth.signature,
  reusable: auth.reusable ? 1 : 0,
  active: auth.active ? 1 : 0,
  account_name: auth.accountName,
  mobile_money_number: auth.mobileMoneyNumber,
  metadata: writeJson(auth.metadata),
  created_at: auth.createdAt,
  updated_at: auth.updatedAt,
});

export function authorizationPatch(patch: Partial<Authorization>): Partial<AuthorizationRow> {
  const out: Partial<AuthorizationRow> = {};
  if (patch.customerId !== undefined) out.customer_id = patch.customerId;
  if (patch.reusable !== undefined) out.reusable = patch.reusable ? 1 : 0;
  if (patch.active !== undefined) out.active = patch.active ? 1 : 0;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toDedicatedAccount = (row: DedicatedAccountRow): DedicatedAccount => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerAccountId: row.provider_account_id,
  customerId: row.customer_id,
  accountNumber: row.account_number,
  accountName: row.account_name,
  bankName: row.bank_name,
  bankSlug: row.bank_slug,
  currency: row.currency,
  active: row.active === 1,
  assigned: row.assigned === 1,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromDedicatedAccount = (a: DedicatedAccount): DedicatedAccountRow => ({
  id: a.id,
  provider: a.provider,
  provider_account_id: a.providerAccountId,
  customer_id: a.customerId,
  account_number: a.accountNumber,
  account_name: a.accountName,
  bank_name: a.bankName,
  bank_slug: a.bankSlug,
  currency: a.currency,
  active: a.active ? 1 : 0,
  assigned: a.assigned ? 1 : 0,
  metadata: writeJson(a.metadata),
  created_at: a.createdAt,
  updated_at: a.updatedAt,
});

export function dedicatedAccountPatch(
  patch: Partial<DedicatedAccount>,
): Partial<DedicatedAccountRow> {
  const out: Partial<DedicatedAccountRow> = {};
  if (patch.active !== undefined) out.active = patch.active ? 1 : 0;
  if (patch.assigned !== undefined) out.assigned = patch.assigned ? 1 : 0;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toPlan = (row: PlanRow): Plan => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerPlanCode: row.provider_plan_code,
  name: row.name,
  amount: row.amount,
  currency: row.currency,
  interval: row.interval as PlanInterval,
  intervalCount: row.interval_count,
  productId: row.product_id,
  description: row.description,
  invoiceLimit: row.invoice_limit,
  sendInvoices: row.send_invoices === 1,
  sendSms: row.send_sms === 1,
  active: row.active === 1,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromPlan = (plan: Plan): PlanRow => ({
  id: plan.id,
  provider: plan.provider,
  provider_plan_code: plan.providerPlanCode,
  name: plan.name,
  amount: plan.amount,
  currency: plan.currency,
  interval: plan.interval,
  interval_count: plan.intervalCount,
  product_id: plan.productId,
  description: plan.description,
  invoice_limit: plan.invoiceLimit,
  send_invoices: plan.sendInvoices ? 1 : 0,
  send_sms: plan.sendSms ? 1 : 0,
  active: plan.active ? 1 : 0,
  metadata: writeJson(plan.metadata),
  created_at: plan.createdAt,
  updated_at: plan.updatedAt,
});

export function planPatch(patch: Partial<Plan>): Partial<PlanRow> {
  const out: Partial<PlanRow> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.amount !== undefined) out.amount = patch.amount;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.invoiceLimit !== undefined) out.invoice_limit = patch.invoiceLimit;
  if (patch.sendInvoices !== undefined) out.send_invoices = patch.sendInvoices ? 1 : 0;
  if (patch.sendSms !== undefined) out.send_sms = patch.sendSms ? 1 : 0;
  if (patch.active !== undefined) out.active = patch.active ? 1 : 0;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerProductId: row.provider_product_id,
  name: row.name,
  description: row.description,
  active: row.active === 1,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromProduct = (product: Product): ProductRow => ({
  id: product.id,
  provider: product.provider,
  provider_product_id: product.providerProductId,
  name: product.name,
  description: product.description,
  active: product.active ? 1 : 0,
  metadata: writeJson(product.metadata),
  created_at: product.createdAt,
  updated_at: product.updatedAt,
});

export function productPatch(patch: Partial<Product>): Partial<ProductRow> {
  const out: Partial<ProductRow> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.active !== undefined) out.active = patch.active ? 1 : 0;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerSubscriptionCode: row.provider_subscription_code,
  customerId: row.customer_id,
  planId: row.plan_id,
  authorizationId: row.authorization_id,
  status: row.status as SubscriptionStatus,
  providerStatus: row.provider_status,
  quantity: row.quantity,
  amount: row.amount,
  currency: row.currency,
  startDate: row.start_date,
  // Rows written before the column existed fall back to the start date, which
  // is what the current period was for a subscription in its first cycle.
  currentPeriodStart: row.current_period_start ?? row.start_date,
  trialStart: row.trial_start,
  trialEnd: row.trial_end,
  nextPaymentDate: row.next_payment_date,
  invoiceLimit: row.invoice_limit,
  invoiceCount: row.invoice_count,
  emailToken: row.email_token,
  cancelledAt: row.cancelled_at,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromSubscription = (sub: Subscription): SubscriptionRow => ({
  id: sub.id,
  provider: sub.provider,
  provider_subscription_code: sub.providerSubscriptionCode,
  customer_id: sub.customerId,
  plan_id: sub.planId,
  authorization_id: sub.authorizationId,
  status: sub.status,
  provider_status: sub.providerStatus,
  current_period_start: sub.currentPeriodStart,
  trial_start: sub.trialStart,
  trial_end: sub.trialEnd,
  quantity: sub.quantity,
  amount: sub.amount,
  currency: sub.currency,
  start_date: sub.startDate,
  next_payment_date: sub.nextPaymentDate,
  invoice_limit: sub.invoiceLimit,
  invoice_count: sub.invoiceCount,
  email_token: sub.emailToken,
  cancelled_at: sub.cancelledAt,
  metadata: writeJson(sub.metadata),
  created_at: sub.createdAt,
  updated_at: sub.updatedAt,
});

export function subscriptionPatch(patch: Partial<Subscription>): Partial<SubscriptionRow> {
  const out: Partial<SubscriptionRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.nextPaymentDate !== undefined) out.next_payment_date = patch.nextPaymentDate;
  if (patch.invoiceCount !== undefined) out.invoice_count = patch.invoiceCount;
  if (patch.cancelledAt !== undefined) out.cancelled_at = patch.cancelledAt;
  if (patch.amount !== undefined) out.amount = patch.amount;
  if (patch.quantity !== undefined) out.quantity = patch.quantity;
  if (patch.planId !== undefined) out.plan_id = patch.planId;
  if (patch.authorizationId !== undefined) out.authorization_id = patch.authorizationId;
  if (patch.currentPeriodStart !== undefined) out.current_period_start = patch.currentPeriodStart;
  if (patch.trialStart !== undefined) out.trial_start = patch.trialStart;
  if (patch.trialEnd !== undefined) out.trial_end = patch.trialEnd;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

/* --- subscription items (one price on a subscription) --- */

export const toSubscriptionItem = (row: SubscriptionItemRow): SubscriptionItem => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerItemId: row.provider_item_id,
  subscriptionId: row.subscription_id,
  planId: row.plan_id,
  quantity: row.quantity,
  position: row.position,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromSubscriptionItem = (item: SubscriptionItem): SubscriptionItemRow => ({
  id: item.id,
  provider: item.provider,
  provider_item_id: item.providerItemId,
  subscription_id: item.subscriptionId,
  plan_id: item.planId,
  quantity: item.quantity,
  position: item.position,
  metadata: writeJson(item.metadata),
  created_at: item.createdAt,
  updated_at: item.updatedAt,
});

export function subscriptionItemPatch(
  patch: Partial<SubscriptionItem>,
): Partial<SubscriptionItemRow> {
  const out: Partial<SubscriptionItemRow> = {};
  if (patch.planId !== undefined) out.plan_id = patch.planId;
  if (patch.quantity !== undefined) out.quantity = patch.quantity;
  if (patch.position !== undefined) out.position = patch.position;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toInvoice = (row: InvoiceRow): Invoice => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerInvoiceCode: row.provider_invoice_code,
  subscriptionId: row.subscription_id,
  customerId: row.customer_id,
  paymentId: row.payment_id,
  amount: row.amount,
  currency: row.currency,
  status: row.status as InvoiceStatus,
  providerStatus: row.provider_status,
  billingReason: row.billing_reason,
  attemptCount: row.attempt_count,
  number: row.number,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  dueAt: row.due_at,
  paidAt: row.paid_at,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromInvoice = (invoice: Invoice): InvoiceRow => ({
  id: invoice.id,
  provider: invoice.provider,
  provider_invoice_code: invoice.providerInvoiceCode,
  subscription_id: invoice.subscriptionId,
  customer_id: invoice.customerId,
  payment_id: invoice.paymentId,
  amount: invoice.amount,
  currency: invoice.currency,
  status: invoice.status,
  provider_status: invoice.providerStatus,
  billing_reason: invoice.billingReason,
  attempt_count: invoice.attemptCount,
  number: invoice.number,
  period_start: invoice.periodStart,
  period_end: invoice.periodEnd,
  due_at: invoice.dueAt,
  paid_at: invoice.paidAt,
  metadata: writeJson(invoice.metadata),
  created_at: invoice.createdAt,
  updated_at: invoice.updatedAt,
});

export function invoicePatch(patch: Partial<Invoice>): Partial<InvoiceRow> {
  const out: Partial<InvoiceRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.paymentId !== undefined) out.payment_id = patch.paymentId;
  if (patch.paidAt !== undefined) out.paid_at = patch.paidAt;
  if (patch.amount !== undefined) out.amount = patch.amount;
  if (patch.billingReason !== undefined) out.billing_reason = patch.billingReason;
  if (patch.attemptCount !== undefined) out.attempt_count = patch.attemptCount;
  if (patch.number !== undefined) out.number = patch.number;
  if (patch.dueAt !== undefined) out.due_at = patch.dueAt;
  if (patch.periodStart !== undefined) out.period_start = patch.periodStart;
  if (patch.periodEnd !== undefined) out.period_end = patch.periodEnd;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

/* --- invoice line items --- */

export const toInvoiceItem = (row: InvoiceItemRow): InvoiceItem => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerItemId: row.provider_item_id,
  customerId: row.customer_id,
  invoiceId: row.invoice_id,
  subscriptionId: row.subscription_id,
  planId: row.plan_id,
  description: row.description,
  amount: row.amount,
  currency: row.currency,
  quantity: row.quantity,
  unitAmount: row.unit_amount,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  proration: row.proration === 1,
  position: row.position,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromInvoiceItem = (item: InvoiceItem): InvoiceItemRow => ({
  id: item.id,
  provider: item.provider,
  provider_item_id: item.providerItemId,
  customer_id: item.customerId,
  invoice_id: item.invoiceId,
  subscription_id: item.subscriptionId,
  plan_id: item.planId,
  description: item.description,
  amount: item.amount,
  currency: item.currency,
  quantity: item.quantity,
  unit_amount: item.unitAmount,
  period_start: item.periodStart,
  period_end: item.periodEnd,
  proration: item.proration ? 1 : 0,
  position: item.position,
  metadata: writeJson(item.metadata),
  created_at: item.createdAt,
  updated_at: item.updatedAt,
});

export function invoiceItemPatch(patch: Partial<InvoiceItem>): Partial<InvoiceItemRow> {
  const out: Partial<InvoiceItemRow> = {};
  if (patch.invoiceId !== undefined) out.invoice_id = patch.invoiceId;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.amount !== undefined) out.amount = patch.amount;
  if (patch.quantity !== undefined) out.quantity = patch.quantity;
  if (patch.unitAmount !== undefined) out.unit_amount = patch.unitAmount;
  if (patch.periodStart !== undefined) out.period_start = patch.periodStart;
  if (patch.periodEnd !== undefined) out.period_end = patch.periodEnd;
  if (patch.position !== undefined) out.position = patch.position;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

/* --- instrument setups (card-on-file without a charge) --- */

export const toInstrumentSetup = (row: InstrumentSetupRow): InstrumentSetup => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerSetupId: row.provider_setup_id,
  customerId: row.customer_id,
  authorizationId: row.authorization_id,
  status: row.status as SetupStatus,
  providerStatus: row.provider_status,
  usage: row.usage === 'on_session' ? 'on_session' : 'off_session',
  channel: (row.channel as PaymentMethod | null) ?? null,
  instrument: readJson(row.instrument),
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  cancellationReason: row.cancellation_reason,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromInstrumentSetup = (setup: InstrumentSetup): InstrumentSetupRow => ({
  id: setup.id,
  provider: setup.provider,
  provider_setup_id: setup.providerSetupId,
  customer_id: setup.customerId,
  authorization_id: setup.authorizationId,
  status: setup.status,
  provider_status: setup.providerStatus,
  usage: setup.usage,
  channel: setup.channel,
  instrument: writeJson(setup.instrument),
  failure_code: setup.failureCode,
  failure_message: setup.failureMessage,
  cancellation_reason: setup.cancellationReason,
  metadata: writeJson(setup.metadata),
  created_at: setup.createdAt,
  updated_at: setup.updatedAt,
});

export function instrumentSetupPatch(
  patch: Partial<InstrumentSetup>,
): Partial<InstrumentSetupRow> {
  const out: Partial<InstrumentSetupRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.customerId !== undefined) out.customer_id = patch.customerId;
  if (patch.authorizationId !== undefined) out.authorization_id = patch.authorizationId;
  if (patch.usage !== undefined) out.usage = patch.usage;
  if (patch.channel !== undefined) out.channel = patch.channel;
  if (patch.instrument !== undefined) out.instrument = writeJson(patch.instrument);
  if (patch.failureCode !== undefined) out.failure_code = patch.failureCode;
  if (patch.failureMessage !== undefined) out.failure_message = patch.failureMessage;
  if (patch.cancellationReason !== undefined) out.cancellation_reason = patch.cancellationReason;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toSubaccount = (row: SubaccountRow): Subaccount => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerSubaccountCode: row.provider_subaccount_code,
  businessName: row.business_name,
  settlementBank: row.settlement_bank,
  accountNumber: row.account_number,
  percentageCharge: row.percentage_charge,
  description: row.description,
  primaryContactEmail: row.primary_contact_email,
  primaryContactName: row.primary_contact_name,
  primaryContactPhone: row.primary_contact_phone,
  currency: row.currency,
  active: row.active === 1,
  accountType: row.account_type,
  countryCode: row.country_code,
  chargesEnabled: row.charges_enabled === 1,
  payoutsEnabled: row.payouts_enabled === 1,
  detailsSubmitted: row.details_submitted === 1,
  requirements: readJson(row.requirements),
  capabilities: readJson(row.capabilities),
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromSubaccount = (a: Subaccount): SubaccountRow => ({
  id: a.id,
  provider: a.provider,
  provider_subaccount_code: a.providerSubaccountCode,
  business_name: a.businessName,
  settlement_bank: a.settlementBank,
  account_number: a.accountNumber,
  percentage_charge: a.percentageCharge,
  description: a.description,
  primary_contact_email: a.primaryContactEmail,
  primary_contact_name: a.primaryContactName,
  primary_contact_phone: a.primaryContactPhone,
  currency: a.currency,
  active: a.active ? 1 : 0,
  account_type: a.accountType,
  country_code: a.countryCode,
  charges_enabled: a.chargesEnabled ? 1 : 0,
  payouts_enabled: a.payoutsEnabled ? 1 : 0,
  details_submitted: a.detailsSubmitted ? 1 : 0,
  requirements: writeJson(a.requirements),
  capabilities: writeJson(a.capabilities),
  metadata: writeJson(a.metadata),
  created_at: a.createdAt,
  updated_at: a.updatedAt,
});

export function subaccountPatch(patch: Partial<Subaccount>): Partial<SubaccountRow> {
  const out: Partial<SubaccountRow> = {};
  if (patch.businessName !== undefined) out.business_name = patch.businessName;
  if (patch.settlementBank !== undefined) out.settlement_bank = patch.settlementBank;
  if (patch.accountNumber !== undefined) out.account_number = patch.accountNumber;
  if (patch.percentageCharge !== undefined) out.percentage_charge = patch.percentageCharge;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.primaryContactEmail !== undefined) {
    out.primary_contact_email = patch.primaryContactEmail;
  }
  if (patch.primaryContactName !== undefined) out.primary_contact_name = patch.primaryContactName;
  if (patch.primaryContactPhone !== undefined) {
    out.primary_contact_phone = patch.primaryContactPhone;
  }
  if (patch.active !== undefined) out.active = patch.active ? 1 : 0;
  if (patch.accountType !== undefined) out.account_type = patch.accountType;
  if (patch.countryCode !== undefined) out.country_code = patch.countryCode;
  if (patch.chargesEnabled !== undefined) out.charges_enabled = patch.chargesEnabled ? 1 : 0;
  if (patch.payoutsEnabled !== undefined) out.payouts_enabled = patch.payoutsEnabled ? 1 : 0;
  if (patch.detailsSubmitted !== undefined) {
    out.details_submitted = patch.detailsSubmitted ? 1 : 0;
  }
  if (patch.requirements !== undefined) out.requirements = writeJson(patch.requirements);
  if (patch.capabilities !== undefined) out.capabilities = writeJson(patch.capabilities);
  if (patch.currency !== undefined) out.currency = patch.currency;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

/** Splits are assembled from two tables; `entries` comes from the join. */
export const toSplit = (row: SplitRow, entries: SplitEntry[]): Split => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerSplitCode: row.provider_split_code,
  name: row.name,
  type: row.type as Split['type'],
  currency: row.currency,
  bearerType: row.bearer_type as Split['bearerType'],
  bearerSubaccountId: row.bearer_subaccount_id,
  active: row.active === 1,
  entries,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromSplit = (split: Split): SplitRow => ({
  id: split.id,
  provider: split.provider,
  provider_split_code: split.providerSplitCode,
  name: split.name,
  type: split.type,
  currency: split.currency,
  bearer_type: split.bearerType,
  bearer_subaccount_id: split.bearerSubaccountId,
  active: split.active ? 1 : 0,
  created_at: split.createdAt,
  updated_at: split.updatedAt,
});

export const toLedgerEntry = (row: LedgerEntryRow): LedgerEntry => ({
  id: row.id,
  provider: row.provider as ProviderId,
  currency: row.currency,
  direction: row.direction as LedgerEntry['direction'],
  amount: row.amount,
  reason: row.reason,
  resourceId: row.resource_id,
  createdAt: row.created_at,
});

export const fromLedgerEntry = (entry: LedgerEntry): LedgerEntryRow => ({
  id: entry.id,
  provider: entry.provider,
  currency: entry.currency,
  direction: entry.direction,
  amount: entry.amount,
  reason: entry.reason,
  resource_id: entry.resourceId,
  created_at: entry.createdAt,
});

export const toDispute = (row: DisputeRow): Dispute => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerDisputeId: row.provider_dispute_id,
  paymentId: row.payment_id,
  customerId: row.customer_id,
  category: row.category,
  status: row.status as DisputeStatus,
  providerStatus: row.provider_status,
  resolution: row.resolution as DisputeResolution | null,
  refundAmount: row.refund_amount,
  currency: row.currency,
  dueAt: row.due_at,
  resolvedAt: row.resolved_at,
  evidence: row.evidence ? readJson(row.evidence) : null,
  message: row.message,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromDispute = (dispute: Dispute): DisputeRow => ({
  id: dispute.id,
  provider: dispute.provider,
  provider_dispute_id: dispute.providerDisputeId,
  payment_id: dispute.paymentId,
  customer_id: dispute.customerId,
  category: dispute.category,
  status: dispute.status,
  provider_status: dispute.providerStatus,
  resolution: dispute.resolution,
  refund_amount: dispute.refundAmount,
  currency: dispute.currency,
  due_at: dispute.dueAt,
  resolved_at: dispute.resolvedAt,
  evidence: dispute.evidence ? writeJson(dispute.evidence) : null,
  message: dispute.message,
  metadata: writeJson(dispute.metadata),
  created_at: dispute.createdAt,
  updated_at: dispute.updatedAt,
});

export function disputePatch(patch: Partial<Dispute>): Partial<DisputeRow> {
  const out: Partial<DisputeRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.resolution !== undefined) out.resolution = patch.resolution;
  if (patch.refundAmount !== undefined) out.refund_amount = patch.refundAmount;
  if (patch.resolvedAt !== undefined) out.resolved_at = patch.resolvedAt;
  if (patch.evidence !== undefined) {
    out.evidence = patch.evidence ? writeJson(patch.evidence) : null;
  }
  if (patch.message !== undefined) out.message = patch.message;
  if (patch.metadata !== undefined) out.metadata = writeJson(patch.metadata);
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toEvent = (row: EventRow): PayboxEvent => ({
  id: row.id,
  type: row.type,
  provider: row.provider as ProviderId,
  resourceId: row.resource_id,
  resourceType: row.resource_type as PayboxEvent['resourceType'],
  sequence: row.sequence,
  data: readJson(row.data),
  previousStatus: row.previous_status,
  currentStatus: row.current_status,
  createdAt: row.created_at,
});

export const fromEvent = (event: PayboxEvent): EventRow => ({
  id: event.id,
  type: event.type,
  provider: event.provider,
  resource_id: event.resourceId,
  resource_type: event.resourceType,
  sequence: event.sequence,
  data: writeJson(event.data),
  previous_status: event.previousStatus,
  current_status: event.currentStatus,
  created_at: event.createdAt,
});

export const toEndpoint = (row: WebhookEndpointRow): WebhookEndpoint => ({
  id: row.id,
  provider: row.provider as ProviderId,
  url: row.url,
  secret: row.secret,
  enabled: row.enabled === 1,
  eventTypes: JSON.parse(row.event_types || '[]') as string[],
  description: row.description,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromEndpoint = (endpoint: WebhookEndpoint): WebhookEndpointRow => ({
  id: endpoint.id,
  provider: endpoint.provider,
  url: endpoint.url,
  secret: endpoint.secret,
  enabled: endpoint.enabled ? 1 : 0,
  event_types: JSON.stringify(endpoint.eventTypes),
  description: endpoint.description,
  created_at: endpoint.createdAt,
  updated_at: endpoint.updatedAt,
});

export function endpointPatch(patch: Partial<WebhookEndpoint>): Partial<WebhookEndpointRow> {
  const out: Partial<WebhookEndpointRow> = {};
  if (patch.url !== undefined) out.url = patch.url;
  if (patch.secret !== undefined) out.secret = patch.secret;
  if (patch.enabled !== undefined) out.enabled = patch.enabled ? 1 : 0;
  if (patch.eventTypes !== undefined) out.event_types = JSON.stringify(patch.eventTypes);
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toDelivery = (row: WebhookDeliveryRow): WebhookDelivery => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  provider: row.provider as ProviderId,
  eventType: row.event_type,
  url: row.url,
  payload: row.payload,
  headers: readJson(row.headers) as Record<string, string>,
  status: row.status as DeliveryStatus,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  responseStatus: row.response_status,
  responseBody: row.response_body,
  errorMessage: row.error_message,
  durationMs: row.duration_ms,
  nextRetryAt: row.next_retry_at,
  replayOfDeliveryId: row.replay_of_delivery_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromDelivery = (delivery: WebhookDelivery): WebhookDeliveryRow => ({
  id: delivery.id,
  endpoint_id: delivery.endpointId,
  event_id: delivery.eventId,
  provider: delivery.provider,
  event_type: delivery.eventType,
  url: delivery.url,
  payload: delivery.payload,
  headers: writeJson(delivery.headers),
  status: delivery.status,
  attempt: delivery.attempt,
  max_attempts: delivery.maxAttempts,
  response_status: delivery.responseStatus,
  response_body: delivery.responseBody,
  error_message: delivery.errorMessage,
  duration_ms: delivery.durationMs,
  next_retry_at: delivery.nextRetryAt,
  replay_of_delivery_id: delivery.replayOfDeliveryId,
  created_at: delivery.createdAt,
  updated_at: delivery.updatedAt,
});

export function deliveryPatch(patch: Partial<WebhookDelivery>): Partial<WebhookDeliveryRow> {
  const out: Partial<WebhookDeliveryRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.attempt !== undefined) out.attempt = patch.attempt;
  if (patch.responseStatus !== undefined) out.response_status = patch.responseStatus;
  if (patch.responseBody !== undefined) out.response_body = patch.responseBody;
  if (patch.errorMessage !== undefined) out.error_message = patch.errorMessage;
  if (patch.durationMs !== undefined) out.duration_ms = patch.durationMs;
  if (patch.nextRetryAt !== undefined) out.next_retry_at = patch.nextRetryAt;
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  return out;
}

export const toJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  payload: readJson(row.payload),
  status: row.status as JobStatus,
  runAt: row.run_at,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  leaseExpiresAt: row.lease_expires_at,
  lastError: row.last_error,
  groupKey: row.group_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromJob = (job: Job): JobRow => ({
  id: job.id,
  kind: job.kind,
  payload: writeJson(job.payload),
  status: job.status,
  run_at: job.runAt,
  attempt: job.attempt,
  max_attempts: job.maxAttempts,
  lease_expires_at: job.leaseExpiresAt,
  last_error: job.lastError,
  group_key: job.groupKey,
  created_at: job.createdAt,
  updated_at: job.updatedAt,
});

export const toRecipient = (row: TransferRecipientRow): TransferRecipient => ({
  id: row.id,
  provider: row.provider as ProviderId,
  providerRecipientId: row.provider_recipient_id,
  type: row.type,
  name: row.name,
  accountNumber: row.account_number,
  bankCode: row.bank_code,
  bankName: row.bank_name,
  currency: row.currency,
  metadata: readJson(row.metadata),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const fromRecipient = (r: TransferRecipient): TransferRecipientRow => ({
  id: r.id,
  provider: r.provider,
  provider_recipient_id: r.providerRecipientId,
  type: r.type,
  name: r.name,
  account_number: r.accountNumber,
  bank_code: r.bankCode,
  bank_name: r.bankName,
  currency: r.currency,
  metadata: writeJson(r.metadata),
  created_at: r.createdAt,
  updated_at: r.updatedAt,
});

import type {
  Customer,
  Metadata,
  Payment,
  PaymentMethod,
  PaymentStatus,
  PayboxEvent,
  ProviderId,
  Refund,
  RefundStatus,
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
  metadata: writeJson(refund.metadata),
  created_at: refund.createdAt,
  updated_at: refund.updatedAt,
});

export function refundPatch(patch: Partial<Refund>): Partial<RefundRow> {
  const out: Partial<RefundRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.providerStatus !== undefined) out.provider_status = patch.providerStatus;
  if (patch.reason !== undefined) out.reason = patch.reason;
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

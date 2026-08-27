/**
 * Kysely row types. These describe what is on disk, not the domain model --
 * JSON columns are `string` here and objects in @paybox/shared, and the
 * mappers in ./mappers.ts are the only place the two meet.
 */
export interface PaymentRow {
  id: string;
  provider: string;
  reference: string;
  provider_transaction_id: string;
  amount: number;
  currency: string;
  status: string;
  provider_status: string;
  payment_method: string | null;
  payment_method_details: string;
  customer_id: string | null;
  callback_url: string | null;
  amount_refunded: number;
  failure_code: string | null;
  failure_message: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  authorized_at: string | null;
  paid_at: string | null;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  provider: string;
  provider_refund_id: string;
  amount: number;
  currency: string;
  status: string;
  provider_status: string;
  reason: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface TransferRow {
  id: string;
  provider: string;
  provider_transfer_id: string;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  provider_status: string;
  recipient_name: string | null;
  recipient_account: string | null;
  recipient_bank_code: string | null;
  reason: string | null;
  failure_reason: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: string;
  provider: string;
  provider_customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  type: string;
  provider: string;
  resource_id: string;
  resource_type: string;
  sequence: number;
  data: string;
  previous_status: string | null;
  current_status: string | null;
  created_at: string;
}

export interface WebhookEndpointRow {
  id: string;
  provider: string;
  url: string;
  secret: string;
  enabled: number;
  event_types: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  provider: string;
  event_type: string;
  url: string;
  payload: string;
  headers: string;
  status: string;
  attempt: number;
  max_attempts: number;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  duration_ms: number | null;
  next_retry_at: string | null;
  replay_of_delivery_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: string;
  run_at: string;
  attempt: number;
  max_attempts: number;
  lease_expires_at: string | null;
  last_error: string | null;
  group_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRow {
  provider: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: string;
}

export interface EventSequenceRow {
  resource_id: string;
  next_sequence: number;
}

export interface TransferRecipientRow {
  id: string;
  provider: string;
  provider_recipient_id: string;
  type: string;
  name: string;
  account_number: string | null;
  bank_code: string | null;
  bank_name: string | null;
  currency: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface MigrationRow {
  id: string;
  applied_at: string;
}

export interface Database {
  payments: PaymentRow;
  refunds: RefundRow;
  transfers: TransferRow;
  customers: CustomerRow;
  events: EventRow;
  webhook_endpoints: WebhookEndpointRow;
  webhook_deliveries: WebhookDeliveryRow;
  jobs: JobRow;
  idempotency_keys: IdempotencyRow;
  transfer_recipients: TransferRecipientRow;
  event_sequences: EventSequenceRow;
  schema_migrations: MigrationRow;
}

import type { Customer, Payment, Transfer } from '@paybox/shared';
import {
  isFinalized,
  payoutStatusLabel,
  toAttemptStatus,
  toQuiddpayPayoutStatus,
  toQuiddpaySessionStatus,
} from './status.js';
import { QUIDDPAY_RAILS, bankName, networkName } from './rails.js';
import type { StoredAttempt, StoredCashSlip, StoredQuote, StoredRecipient } from './state.js';

/**
 * Engine model -> Quid Payments wire shapes.
 *
 * Every shape below is transcribed from a named component of Quid's published
 * OpenAPI document (`docs.quiddpayments.com/openapi.json`, contract `2026-06`,
 * read 2026-09-15); the component name is on each function. Required fields
 * are always present — Quid marks a great many of them required *and*
 * nullable, so the adapter emits `null` rather than omitting the key, which is
 * the difference between a client's optional-chaining working here and
 * failing there.
 *
 * Amounts need no conversion in either direction: Quid speaks `amount_minor`
 * in pesewas and the engine speaks integer minor units. The two agree, which
 * is why nothing in this file multiplies or divides.
 */

/** Quid is test-mode-only here, and says so in every envelope that has room. */
export const ENVIRONMENT = 'test';
export const LIVEMODE = false;

/** The merchant name shown on hosted checkout and on receipts. */
export const MERCHANT_NAME = 'paybox Test Merchant';

function customerName(payment: Payment, customer: Customer | null): string {
  const stored = payment.metadata.customer_name;
  if (typeof stored === 'string' && stored.length > 0) return stored;
  if (!customer) return '';
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ');
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** `CheckoutSessionResponse` — what the merchant's backend receives. */
export function serializeSession(
  payment: Payment,
  options: { checkoutUrl: string; apiKeyLabel: string },
): Record<string, unknown> {
  return {
    id: payment.providerTransactionId,
    status: toQuiddpaySessionStatus(payment.status),
    amount_minor: payment.amount,
    currency: payment.currency,
    invoice_ref: text(payment.metadata, 'invoice_ref'),
    description: text(payment.metadata, 'description'),
    checkout_url: options.checkoutUrl,
    expires_at: payment.expiresAt,
    environment: ENVIRONMENT,
    livemode: LIVEMODE,
    // Required and nullable: the key that created the session, as a label
    // rather than the secret itself. Echoing a credential into a response body
    // would put it in every log that captured one (spec §29).
    api_key: { environment: ENVIRONMENT, label: options.apiKeyLabel },
  };
}

/**
 * `PublicCheckoutSession` — what hosted checkout itself reads.
 *
 * Deliberately a different shape from the merchant-facing one: no
 * `checkout_url`, no `api_key`, but a merchant name, the payer's details and
 * the rails this session may use. The public view is what an unauthenticated
 * browser holds, so it carries only what a payer needs to see.
 */
export function serializePublicSession(
  payment: Payment,
  customer: Customer | null,
  options: { paidRail: string | null; receipt: Record<string, unknown> | null },
): Record<string, unknown> {
  return {
    id: payment.providerTransactionId,
    merchant_name: MERCHANT_NAME,
    status: toQuiddpaySessionStatus(payment.status),
    amount_minor: payment.amount,
    currency: payment.currency,
    invoice_ref: text(payment.metadata, 'invoice_ref'),
    description: text(payment.metadata, 'description'),
    customer_name: customerName(payment, customer),
    customer_email: customer?.email ?? '',
    allowed_rails: [...QUIDDPAY_RAILS],
    expires_at: payment.expiresAt,
    finalized_at: isFinalized(payment.status) ? payment.updatedAt : null,
    paid_rail: options.paidRail ?? '',
    receipt: options.receipt,
  };
}

/** `PublicCheckoutQuoteResponse` — the amount and rails, before a rail is picked. */
export function serializeCheckoutQuote(payment: Payment): Record<string, unknown> {
  return {
    id: payment.providerTransactionId,
    status: toQuiddpaySessionStatus(payment.status),
    base_minor: payment.amount,
    currency: payment.currency,
    expires_at: payment.expiresAt,
    allowed_rails: [...QUIDDPAY_RAILS],
    // Quid displays per-rail surcharges at checkout. paybox charges none, and
    // an empty map says that honestly rather than inventing a fee table that
    // would then disagree with the amount actually collected.
    surcharges: {},
  };
}

/** `ProviderPaymentInitiationResponse` — the answer to starting an attempt. */
export function serializeAttemptInitiation(
  attempt: StoredAttempt,
  options: { replayed: boolean },
): Record<string, unknown> {
  return {
    attempt_reference: attempt.reference,
    provider: 'paybox',
    provider_reference: attempt.providerReference,
    rail: attempt.rail,
    status: attempt.status,
    amount_charged_minor: attempt.amountMinor,
    currency: attempt.currency,
    instructions: attempt.instructions,
    replayed: options.replayed,
  };
}

/**
 * `ProviderPaymentStatusResponse` — the attempt *and* its session.
 *
 * `finalized` is the field Quid's fulfilment checklist is built on, and it
 * describes the **session**, not the attempt: a failed attempt on a session
 * that is still open is not a final answer, because the payer can try another
 * rail. Deriving it from the session status is what keeps that true.
 */
export function serializeAttemptStatus(
  attempt: StoredAttempt,
  payment: Payment,
  options: { refreshed: boolean },
): Record<string, unknown> {
  return {
    attempt_reference: attempt.reference,
    provider: 'paybox',
    provider_reference: attempt.providerReference,
    rail: attempt.rail,
    status: toAttemptStatus(payment.status) === 'pending' ? attempt.status : toAttemptStatus(payment.status),
    amount_charged_minor: attempt.amountMinor,
    currency: attempt.currency,
    session_id: payment.providerTransactionId,
    session_status: toQuiddpaySessionStatus(payment.status),
    session_finalized_at: isFinalized(payment.status) ? payment.updatedAt : null,
    raw_status: attempt.rawStatus,
    refreshed: options.refreshed,
    finalized: isFinalized(payment.status),
    payment_declared_at: attempt.declaredAt,
  };
}

/** `PaymentReceiptResponse`. */
export function serializeReceipt(
  payment: Payment,
  options: { rail: string; emailStatus: string },
): Record<string, unknown> {
  return {
    reference: payment.providerTransactionId,
    merchant_name: MERCHANT_NAME,
    amount_minor: payment.amount,
    currency: payment.currency,
    rail: options.rail,
    paid_at: payment.paidAt ?? payment.updatedAt,
    is_test: true,
    email_status: options.emailStatus,
  };
}

/** `CashDepositSlipResponse`. */
export function serializeCashSlip(
  slip: StoredCashSlip,
  payment: Payment,
  customer: Customer | null,
  options: { replayed: boolean },
): Record<string, unknown> {
  return {
    slip_token: slip.token,
    reference: slip.reference,
    amount_minor: slip.amountMinor,
    currency: slip.currency,
    merchant_name: MERCHANT_NAME,
    session_reference: payment.providerTransactionId,
    invoice_ref: text(payment.metadata, 'invoice_ref'),
    customer_name: customerName(payment, customer),
    status: toQuiddpaySessionStatus(payment.status),
    expires_at: slip.expiresAt,
    replayed: options.replayed,
    // A teller can only record a deposit while the session is still payable.
    can_record: !isFinalized(payment.status),
  };
}

/**
 * `PayoutRecipient` — required in full for both account types.
 *
 * Quid marks every field required, including the ones the other account type
 * uses, so a bank recipient still carries `phone` and `network` as empty
 * strings. Reproduced exactly: a client that reads `recipient.network` on a
 * bank recipient gets `""` here and `""` there, rather than a crash here and
 * a working integration there.
 */
export function serializeRecipient(recipient: StoredRecipient): Record<string, unknown> {
  return {
    id: recipient.id,
    account_name: recipient.accountName,
    account_number: recipient.accountNumber,
    bank_name: recipient.bankName,
    bank_id: recipient.bankId,
    account_type: recipient.accountType,
    phone: recipient.phone,
    network: recipient.network,
    network_name: recipient.networkName,
    environment: recipient.environment,
    verified: recipient.verified,
    verification_status: recipient.verificationStatus,
    purpose: 'payout',
    status: recipient.status,
    version: recipient.version,
    rejection_reason: recipient.rejectionReason,
    channel_id: recipient.channelId,
    customer_id: recipient.customerId,
  };
}

/** `PayoutQuote` — a preview that reserves nothing and locks no pricing. */
export function serializePayoutQuote(quote: StoredQuote): Record<string, unknown> {
  return {
    quote_id: quote.id,
    recipient_id: quote.recipientId,
    amount_minor: quote.amountMinor,
    fee_minor: quote.feeMinor,
    total_debit_minor: quote.amountMinor + quote.feeMinor,
    currency: quote.currency,
    expires_at: quote.expiresAt,
  };
}

/**
 * `Payout`.
 *
 * `bank_reference` carries the rail's transaction reference for **either**
 * account type — Quid's guide says so explicitly, and a test payout returns
 * one prefixed `TEST-`. `reconciliation_status` is deliberately separate from
 * `status`, also as documented, and reads `not_required` for a test payout.
 */
export function serializePayout(
  transfer: Transfer,
  recipient: StoredRecipient | null,
): Record<string, unknown> {
  const status = toQuiddpayPayoutStatus(transfer.status);
  const fee = typeof transfer.metadata.fee_minor === 'number' ? transfer.metadata.fee_minor : 0;
  return {
    id: transfer.providerTransferId,
    reference: transfer.reference,
    client_reference: text(transfer.metadata, 'client_reference'),
    amount_minor: transfer.amount,
    fee_minor: fee,
    total_debit_minor: transfer.amount + fee,
    currency: transfer.currency,
    environment: ENVIRONMENT,
    status,
    status_label: payoutStatusLabel(status),
    reconciliation_status: 'not_required',
    recipient: recipient ? serializeRecipient(recipient) : null,
    bank_reference: text(transfer.metadata, 'bank_reference'),
    created_at: transfer.createdAt,
    // Receipt and evidence are generated on demand, so the list carries their
    // metadata only. Quid's `PayoutEvidence` shape, one entry per payout.
    evidence: [
      {
        id: `ev_${transfer.providerTransferId}`,
        filename: `${transfer.reference}.pdf`,
        content_type: 'application/pdf',
        purpose: 'receipt',
      },
    ],
    // Quid: cancellable "while can_cancel is true", and a completed Test
    // payout cannot be cancelled.
    can_cancel: transfer.status === 'pending' || transfer.status === 'processing',
    // An API key cannot approve a payout, whatever the account's settings.
    can_approve: false,
    processing_expectation:
      status === 'paid' ? 'Completed' : 'Test payouts settle immediately on creation',
    exception_reason: transfer.failureReason ?? '',
  };
}

/** `MerchantWebhookPayout` — the trimmed payout a webhook carries. */
export function serializeWebhookPayout(transfer: Transfer): Record<string, unknown> {
  const fee = typeof transfer.metadata.fee_minor === 'number' ? transfer.metadata.fee_minor : 0;
  return {
    id: transfer.providerTransferId,
    reference: transfer.reference,
    status: toQuiddpayPayoutStatus(transfer.status),
    amount_minor: transfer.amount,
    fee_minor: fee,
    currency: transfer.currency,
    bank_reference: text(transfer.metadata, 'bank_reference'),
    return_reference: text(transfer.metadata, 'return_reference'),
    reconciliation_status: 'not_required',
  };
}

/** `MerchantWebhookSession` — the trimmed session a webhook carries. */
export function serializeWebhookSession(payment: Payment): Record<string, unknown> {
  return {
    id: payment.providerTransactionId,
    status: toQuiddpaySessionStatus(payment.status),
    amount_minor: payment.amount,
    currency: payment.currency,
    invoice_ref: text(payment.metadata, 'invoice_ref'),
    metadata: publicMetadata(payment.metadata),
  };
}

/**
 * The metadata a merchant gets back.
 *
 * `invoice_ref`, `description` and `customer_name` are promoted to real fields
 * on the session, so echoing them inside `metadata` as well would report keys
 * the merchant never sent. Stripped here, in one place, the way the
 * Flutterwave v4 adapter strips its own version marker.
 */
export function publicMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { invoice_ref, description, customer_name, callback_url, ...rest } = metadata;
  void invoice_ref;
  void description;
  void customer_name;
  void callback_url;
  return rest;
}

/** Bank and network display names, for a recipient built from ids alone. */
export function describeRecipient(input: {
  accountType: 'bank' | 'momo';
  bankId?: string | undefined;
  network?: string | undefined;
}): { bankName: string; networkName: string } {
  return {
    bankName: input.accountType === 'bank' ? bankName(input.bankId ?? '') : '',
    networkName: input.accountType === 'momo' ? networkName(input.network ?? '') : '',
  };
}

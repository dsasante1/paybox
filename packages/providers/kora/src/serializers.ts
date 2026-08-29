import type { Customer, Payment, Refund, Transfer } from '@paybox/shared';
import { responseMessage } from './errors.js';
import {
  toKoraPaymentMethod,
  toKoraRefundStatus,
  toKoraStatus,
  toKoraTransferStatus,
  type KoraAuthModel,
} from './status.js';

/**
 * Kora response serialisation.
 *
 * Shapes transcribed from the Kora Public APIs Postman collection
 * (docs.korapay.com, collection 303979/SVzxXeSM, read 2026-08-29). Coverage is
 * documented in docs/kora.md, including which fields are real and which are
 * the placeholder Kora itself returns. Nothing here invents a
 * plausible-looking value for something the emulator cannot know.
 */

/** Kora's success envelope. `status` is a **boolean**, unlike Flutterwave's. */
export function ok<T>(message: string, data: T) {
  return { status: true as const, message, data };
}

/**
 * Kora references are prefixed and opaque: `KPY-CA-…` for a charge attempt,
 * `KPY-PAY-…` for a settled payment, `KPY-PI-…` for a checkout.
 *
 * Derived from the canonical id so the same resource always serialises to the
 * same string under a fixed seed.
 */
export function koraRef(prefix: string, canonicalId: string): string {
  const body = canonicalId.replace(/^[a-z]+_/, '').toUpperCase().slice(0, 12);
  return `KPY-${prefix}-${body}`;
}

/** Kora reports money as major units, often as a fixed-2 string. */
export function major(minorUnits: number): number {
  return Number((minorUnits / 100).toFixed(2));
}

export function majorString(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

function customerBlock(payment: Payment, customer: Customer | null | undefined) {
  return {
    name:
      [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') ||
      (payment.metadata.customer_name as string | undefined) ||
      null,
    email: customer?.email ?? (payment.metadata.email as string | undefined) ?? null,
    phone: customer?.phone ?? null,
  };
}

/** Only masked fragments reach here; the PAN is discarded (spec §29). */
function cardBlock(payment: Payment) {
  const details = payment.paymentMethodDetails;
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    card_type: str('brand')?.toLowerCase() ?? 'mastercard',
    first_six: str('bin'),
    last_four: str('last4'),
    expiry: str('exp_month') && str('exp_year') ? `${str('exp_month')}/${str('exp_year')}` : null,
  };
}

export interface SerializeChargeOptions {
  customer?: Customer | null;
  authModel?: KoraAuthModel | null;
  /** The message Kora shows the payer, e.g. the OTP prompt. */
  message?: string;
}

/** A charge, as `/charges/*` and `/charges/:reference` return it. */
export function serializeCharge(payment: Payment, options: SerializeChargeOptions = {}) {
  const status = toKoraStatus(payment.status);
  const method = toKoraPaymentMethod(payment.paymentMethod);

  return {
    reference: payment.reference,
    payment_reference: payment.reference,
    transaction_reference: koraRef('CA', payment.id),
    amount: majorString(payment.amount),
    amount_paid: status === 'success' ? majorString(payment.amount) : majorString(0),
    amount_expected: majorString(payment.amount),
    // paybox does not model Kora's pricing, so fee and VAT are zero rather
    // than an invented figure. docs/kora.md says so.
    fee: 0,
    vat: 0,
    currency: payment.currency,
    status,
    description: (payment.metadata.description as string | undefined) ?? null,
    narration: (payment.metadata.narration as string | undefined) ?? null,
    merchant_bears_cost: payment.metadata.merchant_bears_cost === true,
    payment_method: method,
    ...(options.authModel ? { auth_model: options.authModel } : {}),
    ...(options.message ? { message: options.message } : {}),
    response_message: responseMessage(status, payment.failureCode),
    customer: customerBlock(payment, options.customer),
    ...(payment.paymentMethod === 'card' ? { card: cardBlock(payment) } : {}),
    ...(payment.paymentMethod === 'mobile_money'
      ? {
          mobile_money: {
            number: (payment.paymentMethodDetails.phone_number as string | undefined) ?? null,
          },
        }
      : {}),
    ...(payment.paymentMethod === 'bank_transfer'
      ? { bank_account: bankAccountBlock(payment) }
      : {}),
  };
}

/**
 * The virtual account a bank-transfer charge is paid into.
 *
 * Synthetic and generated, like every account number in the emulator: nothing
 * can move real money into it (spec §29).
 */
function bankAccountBlock(payment: Payment) {
  const details = payment.paymentMethodDetails;
  return {
    account_name: (details.account_name as string | undefined) ?? 'PAYBOX TEST ACCOUNT',
    account_number: (details.account_number as string | undefined) ?? null,
    bank_name: (details.bank_name as string | undefined) ?? 'PAYBOX TEST BANK',
    bank_code: (details.bank_code as string | undefined) ?? '000',
    // Kora's virtual accounts for a transfer charge are short-lived.
    expiry_date_in_utc: payment.expiresAt,
  };
}

export function serializeRefund(refund: Refund, payment: Payment | null) {
  return {
    refund_reference: refund.providerRefundId,
    reference: refund.providerRefundId,
    payment_reference: payment?.reference ?? null,
    status: toKoraRefundStatus(refund.status),
    amount: majorString(refund.amount),
    amount_returned: major(refund.amount),
    transaction_amount: payment ? majorString(payment.amount) : null,
    currency: refund.currency,
    destination: 'customer',
    reason: refund.reason,
    channel: 'api',
    payment_method: payment ? toKoraPaymentMethod(payment.paymentMethod) : null,
    refund_date: refund.createdAt,
    created_at: refund.createdAt,
    completed_at: refund.status === 'successful' ? refund.updatedAt : null,
  };
}

/** A payout. Kora calls these disbursements. */
export function serializePayout(transfer: Transfer) {
  return {
    reference: transfer.reference,
    status: toKoraTransferStatus(transfer.status),
    amount: majorString(transfer.amount),
    fee: majorString(Number(transfer.metadata.fee ?? 0)),
    currency: transfer.currency,
    narration: transfer.reason,
    // Kora returns a trace id for reconciliation with the receiving bank.
    trace_id: koraRef('TRC', transfer.id),
    message: transfer.failureReason ?? 'Payout processing',
    customer: {
      name: transfer.recipientName,
      email: (transfer.metadata.email as string | undefined) ?? null,
      phone: null,
    },
  };
}

export function serializeVirtualAccount(options: {
  accountReference: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode: string;
  currency: string;
  customer: { name: string | null; email: string | null };
  createdAt: string;
}) {
  return {
    account_reference: options.accountReference,
    unique_id: options.accountReference,
    account_name: options.accountName,
    account_number: options.accountNumber,
    bank_name: options.bankName,
    bank_code: options.bankCode,
    account_status: 'active',
    currency: options.currency,
    customer: options.customer,
    created_at: options.createdAt,
  };
}

import type { Customer, Authorization, Payment, Refund, Transfer } from '@paybox/shared';
import { toKoraLikeId } from './ids.js';
import { toFlutterwaveStatus } from '../status.js';

/**
 * Flutterwave v4 response serialisation.
 *
 * v4's shapes share almost nothing with v3's: ids are prefixed strings rather
 * than integers, timestamps are `created_datetime`, names and phones are
 * objects, and the envelope's `status` can itself be `pending`. Verified at
 * developer.flutterwave.com/docs/charging-a-card (read 2026-08-29).
 */

/**
 * v4's envelope.
 *
 * `status` describes the *request*, not just its success: a charge waiting on
 * a step-up answers `pending`, and one the issuer declined answers `failed`
 * with a 200 body rather than an error envelope. That three-way status is a
 * real difference from v3, where the envelope only ever said success or error.
 */
export type V4EnvelopeStatus = 'success' | 'pending' | 'failed';

export function v4Ok<T>(status: V4EnvelopeStatus, message: string, data: T) {
  return { status, message, data };
}

/** v4 timestamps are RFC 3339 with nanosecond-ish precision and a Z. */
function stamp(iso: string): string {
  return new Date(iso).toISOString().replace('Z', '000Z');
}

function nameBlock(customer: Customer | null | undefined) {
  return {
    first: customer?.firstName ?? null,
    middle: null,
    last: customer?.lastName ?? null,
  };
}

export function serializeV4Customer(customer: Customer) {
  return {
    id: toKoraLikeId('cus', customer.id),
    address: {
      city: null,
      country: null,
      line1: null,
      line2: '',
      postal_code: null,
      state: null,
    },
    email: customer.email,
    name: nameBlock(customer),
    phone: customer.phone
      ? { country_code: null, number: customer.phone }
      : { country_code: null, number: null },
    meta: customer.metadata,
    created_datetime: stamp(customer.createdAt),
  };
}

/** A stored payment method. v4 gives these their own `pmd_` resource. */
export function serializeV4PaymentMethod(authorization: Authorization) {
  return {
    id: toKoraLikeId('pmd', authorization.id),
    type: authorization.channel === 'card' ? 'card' : authorization.channel,
    ...(authorization.channel === 'card'
      ? {
          card: {
            expiry_month: Number(authorization.expMonth ?? 12),
            expiry_year: Number(authorization.expYear ?? 32),
            first6: authorization.bin,
            last4: authorization.last4,
            network: (authorization.brand ?? 'mastercard').toLowerCase(),
          },
        }
      : {}),
    customer_id: authorization.customerId
      ? toKoraLikeId('cus', authorization.customerId)
      : null,
    meta: authorization.metadata,
    created_datetime: stamp(authorization.createdAt),
  };
}

/**
 * The step-up a charge is waiting on.
 *
 * v4 calls this `next_action` and nests the detail by kind, where v3 used
 * `meta.authorization`. An integration branches on `next_action.type`.
 */
export type V4NextAction =
  | { type: 'authorize'; authorization: { type: string } }
  | { type: 'redirect_url'; redirect_url: { url: string } }
  | null;

export interface SerializeV4ChargeOptions {
  customer?: Customer | null;
  nextAction?: V4NextAction;
  /** The issuer's answer, echoed as it was requested. */
  processorResponse?: string;
}

export function serializeV4Charge(payment: Payment, options: SerializeV4ChargeOptions = {}) {
  const status = toFlutterwaveStatus(payment.status);
  return {
    id: toKoraLikeId('chg', payment.id),
    amount: payment.amount / 100,
    currency: payment.currency,
    reference: payment.reference,
    customer_id: payment.customerId ? toKoraLikeId('cus', payment.customerId) : null,
    payment_method_details: payment.paymentMethod
      ? {
          type: payment.paymentMethod === 'card' ? 'card' : payment.paymentMethod,
          ...(payment.paymentMethod === 'card'
            ? {
                card: {
                  first6: payment.paymentMethodDetails.bin ?? null,
                  last4: payment.paymentMethodDetails.last4 ?? null,
                  network: String(payment.paymentMethodDetails.brand ?? 'mastercard').toLowerCase(),
                },
              }
            : {}),
        }
      : {},
    status,
    processor_response: {
      // v4 reports the issuer's own slug, which is what the scenario key asked
      // for. Echoing it is the point: an integration surfacing this to support
      // staff should see the string it requested.
      type: options.processorResponse ?? 'approved',
    },
    next_action: options.nextAction ?? null,
    meta: payment.metadata,
    created_datetime: stamp(payment.createdAt),
  };
}

export function serializeV4Refund(refund: Refund, payment: Payment | null) {
  return {
    id: toKoraLikeId('rfd', refund.id),
    charge_id: payment ? toKoraLikeId('chg', payment.id) : null,
    amount: refund.amount / 100,
    currency: refund.currency,
    status: refund.status === 'successful' ? 'succeeded' : refund.status,
    meta: refund.metadata,
    created_datetime: stamp(refund.createdAt),
  };
}

export function serializeV4Transfer(transfer: Transfer) {
  return {
    id: toKoraLikeId('trf', transfer.id),
    reference: transfer.reference,
    amount: transfer.amount / 100,
    currency: transfer.currency,
    status:
      transfer.status === 'successful'
        ? 'successful'
        : transfer.status === 'reversed'
          ? 'reversed'
          : transfer.status === 'failed' || transfer.status === 'cancelled'
            ? 'failed'
            : 'pending',
    narration: transfer.reason,
    meta: transfer.metadata,
    created_datetime: stamp(transfer.createdAt),
  };
}

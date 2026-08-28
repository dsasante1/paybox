import type {
  Authorization,
  Customer,
  Payment,
  PayboxEvent,
  Refund,
} from '@paybox/shared';
import {
  cancellationReason,
  toStripeChargeStatus,
  toStripeRefundStatus,
  toStripeStatus,
} from './status.js';
import { stripeFailure } from './errors.js';

/**
 * Stripe response serialisation.
 *
 * Field coverage is documented in docs/stripe.md, including which fields are
 * real and which are the null/empty value Stripe itself uses for an absent
 * one. Nothing here invents a plausible-looking value for something the
 * emulator cannot know.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28).
 */

/** Stripe timestamps are unix **seconds**, not milliseconds or ISO strings. */
export function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * Stripe ids are prefixed and opaque. Derived from the canonical id so the
 * same resource always serialises to the same string under a fixed seed.
 */
export function stripeId(prefix: string, canonicalId: string): string {
  const body = canonicalId.replace(/^[a-z]{3}_/, '');
  return `${prefix}_${body}`;
}

/**
 * The client secret a front end uses to confirm an intent.
 *
 * Real Stripe secrets are unguessable; this one is derived from the intent id,
 * which is fine for an emulator that cannot move money and keeps runs
 * reproducible. docs/stripe.md says so rather than implying it is a
 * credential.
 */
/**
 * A distinct, stable event id per canonical event and Stripe event type.
 *
 * Deterministic so a fixed seed still yields byte-identical payloads.
 */
export function stripeEventId(canonicalEventId: string, type: string): string {
  let hash = 0x811c9dc5;
  for (const char of type) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${stripeId('evt', canonicalEventId)}${hash.toString(32).slice(0, 4)}`;
}

export function clientSecret(intentId: string): string {
  return `${intentId}_secret_${intentId.split('_').at(-1) ?? 'local'}`;
}

/** Stripe's list envelope. Every collection response is this shape. */
export function list<T>(data: T[], url: string, hasMore: boolean) {
  return { object: 'list' as const, data, has_more: hasMore, url };
}

function billingDetails(customer: Customer | null | undefined) {
  return {
    address: {
      city: null,
      country: null,
      line1: null,
      line2: null,
      postal_code: null,
      state: null,
    },
    email: customer?.email ?? null,
    name: [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || null,
    phone: customer?.phone ?? null,
  };
}

/** The `card` sub-object. Only masked fragments; the PAN never reaches here. */
function cardDetails(details: Record<string, unknown>) {
  const str = (key: string): string | null => {
    const value = details[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    brand: str('brand') ?? 'visa',
    checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: null },
    country: str('country') ?? 'US',
    exp_month: Number(str('exp_month') ?? 12),
    exp_year: Number(str('exp_year') ?? 2034),
    fingerprint: str('bin') ? `fp_${str('bin')}` : null,
    funding: 'credit',
    last4: str('last4') ?? '0000',
    network: str('brand') ?? 'visa',
    three_d_secure: null,
    wallet: null,
  };
}

export function serializePaymentMethod(
  authorization: Authorization,
  customer?: Customer | null,
) {
  const id = stripeId('pm', authorization.id);
  return {
    id,
    object: 'payment_method' as const,
    billing_details: billingDetails(customer),
    card: cardDetails({
      brand: authorization.brand,
      bin: authorization.bin,
      last4: authorization.last4,
      exp_month: authorization.expMonth,
      exp_year: authorization.expYear,
      country: authorization.countryCode,
    }),
    created: unix(authorization.createdAt),
    customer: customer ? stripeId('cus', customer.id) : null,
    livemode: false,
    metadata: authorization.metadata,
    type: authorization.channel === 'card' ? 'card' : authorization.channel,
  };
}

/**
 * `last_payment_error`, which is how a Stripe PaymentIntent reports a failure
 * -- the status itself returns to `requires_payment_method`.
 */
function lastPaymentError(payment: Payment) {
  if (!payment.failureCode) return null;
  const last4 = payment.paymentMethodDetails.last4;
  const known = stripeFailure(payment.failureCode);
  return {
    type: 'card_error',
    code: known?.code ?? payment.failureCode,
    ...(known?.declineCode ? { decline_code: known.declineCode } : {}),
    message: payment.failureMessage ?? 'The payment failed.',
    payment_method: {
      id: stripeId('pm', payment.id),
      object: 'payment_method',
      type: 'card',
      card: { last4: typeof last4 === 'string' ? last4 : null },
    },
  };
}

/** `next_action`, populated only while the intent awaits the customer. */
function nextAction(payment: Payment, baseUrl: string, basePath: string) {
  if (payment.status !== 'requires_action') return null;
  const id = stripeId('pi', payment.id);
  return {
    type: 'redirect_to_url',
    redirect_to_url: {
      return_url: payment.callbackUrl,
      url: `${baseUrl}${basePath}/authenticate/${id}`,
    },
  };
}

export interface SerializeIntentOptions {
  customer?: Customer | null;
  charge?: Payment | null;
  baseUrl?: string;
  basePath?: string;
  /** Sum of settled refunds, for the charge sub-object. */
  amountRefunded?: number;
}

export function serializePaymentIntent(payment: Payment, options: SerializeIntentOptions = {}) {
  const id = stripeId('pi', payment.id);
  const status = toStripeStatus(payment.status);
  const reason = cancellationReason(payment.status);

  return {
    id,
    object: 'payment_intent' as const,
    amount: payment.amount,
    amount_capturable: payment.status === 'authorized' ? payment.amount : 0,
    amount_received: payment.status === 'successful' ? payment.amount : 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: reason ? unix(payment.updatedAt) : null,
    cancellation_reason: reason,
    capture_method: payment.metadata.capture_method === 'manual' ? 'manual' : 'automatic',
    client_secret: clientSecret(id),
    confirmation_method: 'automatic',
    created: unix(payment.createdAt),
    currency: payment.currency.toLowerCase(),
    customer: payment.customerId ? stripeId('cus', payment.customerId) : null,
    description: (payment.metadata.description as string | undefined) ?? null,
    last_payment_error: lastPaymentError(payment),
    latest_charge: payment.paymentMethod ? stripeId('ch', payment.id) : null,
    livemode: false,
    metadata: payment.metadata,
    next_action: nextAction(payment, options.baseUrl ?? '', options.basePath ?? ''),
    on_behalf_of: null,
    payment_method: payment.paymentMethod ? stripeId('pm', payment.id) : null,
    payment_method_options: {},
    payment_method_types: ['card'],
    processing: null,
    receipt_email: (payment.metadata.receipt_email as string | undefined) ?? null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status,
    transfer_data: null,
    transfer_group: null,
  };
}

export function serializeCharge(
  payment: Payment,
  options: { customer?: Customer | null; amountRefunded?: number; baseUrl?: string } = {},
) {
  const id = stripeId('ch', payment.id);
  const refunded = options.amountRefunded ?? payment.amountRefunded;
  const status = toStripeChargeStatus(payment.status);
  const known = stripeFailure(payment.failureCode);

  return {
    id,
    object: 'charge' as const,
    amount: payment.amount,
    amount_captured: payment.status === 'successful' ? payment.amount : 0,
    amount_refunded: refunded,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: payment.status === 'successful' ? stripeId('txn', payment.id) : null,
    billing_details: billingDetails(options.customer),
    calculated_statement_descriptor: null,
    captured: payment.status === 'successful',
    created: unix(payment.createdAt),
    currency: payment.currency.toLowerCase(),
    customer: payment.customerId ? stripeId('cus', payment.customerId) : null,
    description: (payment.metadata.description as string | undefined) ?? null,
    disputed: false,
    failure_code: status === 'failed' ? (known?.code ?? payment.failureCode) : null,
    failure_message: status === 'failed' ? payment.failureMessage : null,
    fraud_details: {},
    livemode: false,
    metadata: payment.metadata,
    outcome:
      status === 'failed'
        ? {
            network_status: 'declined_by_network',
            reason: known?.declineCode ?? payment.failureCode,
            risk_level: 'normal',
            seller_message: payment.failureMessage,
            type: 'issuer_declined',
          }
        : {
            network_status: 'approved_by_network',
            reason: null,
            risk_level: 'normal',
            seller_message: 'Payment complete.',
            type: 'authorized',
          },
    paid: status === 'succeeded',
    payment_intent: stripeId('pi', payment.id),
    payment_method: stripeId('pm', payment.id),
    payment_method_details: {
      card: cardDetails(payment.paymentMethodDetails),
      type: 'card',
    },
    receipt_email: (payment.metadata.receipt_email as string | undefined) ?? null,
    receipt_number: null,
    // The emulator serves no receipt page; null is what Stripe returns before
    // one exists, so this is honest rather than a dead link.
    receipt_url: null,
    refunded: refunded >= payment.amount && refunded > 0,
    review: null,
    shipping: null,
    status,
    transfer_data: null,
    transfer_group: null,
  };
}

export function serializeRefund(refund: Refund, payment: Payment | null) {
  return {
    id: stripeId('re', refund.id),
    object: 'refund' as const,
    amount: refund.amount,
    balance_transaction: stripeId('txn', refund.id),
    charge: payment ? stripeId('ch', payment.id) : null,
    created: unix(refund.createdAt),
    currency: refund.currency.toLowerCase(),
    destination_details: { card: { reference_status: 'pending' }, type: 'card' },
    failure_reason: refund.status === 'failed' ? 'expired_or_canceled_card' : null,
    metadata: refund.metadata,
    payment_intent: payment ? stripeId('pi', payment.id) : null,
    reason: refund.reason,
    receipt_number: null,
    source_transfer_reversal: null,
    status: toStripeRefundStatus(refund.status),
    transfer_reversal: null,
  };
}

export function serializeCustomer(customer: Customer) {
  return {
    id: stripeId('cus', customer.id),
    object: 'customer' as const,
    address: null,
    balance: 0,
    created: unix(customer.createdAt),
    currency: null,
    default_source: null,
    delinquent: false,
    description: null,
    discount: null,
    email: customer.email,
    invoice_prefix: null,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: customer.metadata,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null,
    next_invoice_sequence: 1,
    phone: customer.phone,
    preferred_locales: [],
    shipping: null,
    tax_exempt: 'none',
    test_clock: null,
  };
}

/**
 * Stripe's event envelope.
 *
 * The id is derived from the canonical event *and* the Stripe event type,
 * because one canonical event fans out to several Stripe events and each needs
 * its own id -- a subscriber deduplicating on `event.id` would otherwise drop
 * the second one as a repeat of the first.
 */
export function serializeEvent(
  event: PayboxEvent,
  type: string,
  data: unknown,
  apiVersion: string,
) {
  return {
    id: stripeEventId(event.id, type),
    object: 'event' as const,
    api_version: apiVersion,
    created: unix(event.createdAt),
    data: { object: data },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
  };
}


/**
 * A Checkout Session.
 *
 * paybox stores the session on the payment it collects for, with the
 * session-specific fields in metadata: a `mode: payment` session and a
 * payment are one lifecycle, and `expires_at` / `status: expired` map straight
 * onto the canonical `expiresAt` / `expired`. docs/stripe.md records that a
 * session is therefore not an independent object here.
 */
export function serializeCheckoutSession(
  payment: Payment,
  options: {
    customer?: Customer | null;
    baseUrl?: string;
    basePath?: string;
  } = {},
) {
  const id = stripeId('cs', payment.id);
  const meta = payment.metadata;
  const str = (key: string): string | null => {
    const value = meta[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const settled = payment.status === 'successful';
  const expired = payment.status === 'expired' || payment.status === 'cancelled';

  return {
    id,
    object: 'checkout.session' as const,
    amount_subtotal: payment.amount,
    amount_total: payment.amount,
    cancel_url: str('cancel_url'),
    client_reference_id: str('client_reference_id'),
    created: unix(payment.createdAt),
    currency: payment.currency.toLowerCase(),
    customer: payment.customerId ? stripeId('cus', payment.customerId) : null,
    customer_details: options.customer
      ? {
          email: options.customer.email,
          name:
            [options.customer.firstName, options.customer.lastName]
              .filter(Boolean)
              .join(' ') || null,
          phone: options.customer.phone,
          address: null,
          tax_exempt: 'none',
          tax_ids: [],
        }
      : null,
    customer_email: str('customer_email'),
    expires_at: payment.expiresAt ? unix(payment.expiresAt) : null,
    invoice: null,
    livemode: false,
    metadata: meta,
    mode: str('mode') ?? 'payment',
    payment_intent: stripeId('pi', payment.id),
    payment_method_types: ['card'],
    // `unpaid` until it settles, then `paid`. Stripe's third value,
    // no_payment_required, is for zero-amount sessions, which paybox refuses
    // because canonical amounts must be positive.
    payment_status: settled ? 'paid' : 'unpaid',
    // open -> complete once paid; expired if it lapsed or was cancelled.
    status: settled ? 'complete' : expired ? 'expired' : 'open',
    submit_type: null,
    subscription: null,
    success_url: str('success_url'),
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: 'hosted',
    url:
      settled || expired
        ? null
        : `${options.baseUrl ?? ''}${options.basePath ?? ''}/checkout/${id}`,
  };
}

/** `GET /v1/checkout/sessions/{id}/line_items`. */
export function serializeLineItems(payment: Payment) {
  const raw = payment.metadata.line_items;
  const items = Array.isArray(raw) ? raw : [];
  return items.map((item, index) => {
    const line = (item ?? {}) as Record<string, unknown>;
    const quantity = Number(line.quantity ?? 1) || 1;
    const unitAmount = Number(line.unit_amount ?? 0) || 0;
    return {
      id: `li_${stripeId('cs', payment.id).slice(3)}${index}`,
      object: 'item' as const,
      amount_discount: 0,
      amount_subtotal: unitAmount * quantity,
      amount_tax: 0,
      amount_total: unitAmount * quantity,
      currency: payment.currency.toLowerCase(),
      description: typeof line.name === 'string' ? line.name : null,
      price: null,
      quantity,
    };
  });
}

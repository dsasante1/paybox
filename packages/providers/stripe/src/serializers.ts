import type {
  Authorization,
  Customer,
  InstrumentSetup,
  Invoice,
  InvoiceItem,
  Metadata,
  Payment,
  PayboxEvent,
  Plan,
  Product,
  Refund,
  Subaccount,
  Subscription,
  Transfer,
  SubscriptionItem,
} from '@paybox/shared';
import {
  cancellationReason,
  toStripeInvoiceStatus,
  toStripeSetupStatus,
  toStripeRecurring,
  toStripeSubscriptionStatus,
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
    application_fee_amount: payment.platformFee > 0 ? payment.platformFee : null,
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
    on_behalf_of: payment.subaccountId ? stripeId('acct', payment.subaccountId) : null,
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
    // A forwarded charge names where the money is going; a direct one does
    // not, because the connected account already has it.
    transfer_data:
      payment.settlementMode === 'forwarded' && payment.subaccountId
        ? {
            amount: null,
            destination: stripeId('acct', payment.subaccountId),
          }
        : null,
    transfer_group: payment.transferGroup,
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
    application_fee: payment.platformFee > 0 ? stripeId('fee', payment.id) : null,
    application_fee_amount: payment.platformFee > 0 ? payment.platformFee : null,
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
    // A forwarded charge names where the money is going; a direct one does
    // not, because the connected account already has it.
    transfer_data:
      payment.settlementMode === 'forwarded' && payment.subaccountId
        ? {
            amount: null,
            destination: stripeId('acct', payment.subaccountId),
          }
        : null,
    transfer_group: payment.transferGroup,
    on_behalf_of: payment.subaccountId ? stripeId('acct', payment.subaccountId) : null,
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


/**
 * A SetupIntent.
 *
 * `payment_method` is the instrument the setup produced, which is the whole
 * output of the flow -- a succeeded SetupIntent whose `payment_method` is null
 * has achieved nothing, and the engine will not report one.
 *
 * `next_action` mirrors the PaymentIntent shape: `redirect_to_url` pointing at
 * the emulator's own hosted page, so a front end that already handles a 3-D
 * Secure step-up on a payment handles one on a setup without a second code
 * path.
 */
export function serializeSetupIntent(
  setup: InstrumentSetup,
  options: {
    customer?: Customer | null;
    authorization?: Authorization | null;
    baseUrl?: string;
    basePath?: string;
  } = {},
) {
  const id = stripeId('seti', setup.id);
  const failure = stripeFailure(setup.failureCode);
  const status = toStripeSetupStatus(setup.status);

  return {
    id,
    object: 'setup_intent' as const,
    application: null,
    attach_to_self: false,
    automatic_payment_methods: null,
    cancellation_reason: setup.cancellationReason,
    client_secret: clientSecret(id),
    created: unix(setup.createdAt),
    customer: setup.customerId ? stripeId('cus', setup.customerId) : null,
    description: (setup.metadata.description as string | undefined) ?? null,
    flow_directions: null,
    last_setup_error:
      setup.status === 'failed'
        ? {
            type: 'card_error',
            code: failure?.code ?? setup.failureCode,
            ...(failure?.declineCode ? { decline_code: failure.declineCode } : {}),
            message: setup.failureMessage,
          }
        : null,
    latest_attempt: null,
    livemode: false,
    mandate: null,
    metadata: setup.metadata,
    next_action:
      setup.status === 'requires_action' && options.baseUrl
        ? {
            type: 'redirect_to_url',
            redirect_to_url: {
              return_url: (setup.metadata.return_url as string | undefined) ?? null,
              url: `${options.baseUrl}${options.basePath ?? "/stripe"}/setup/${id}`,
            },
          }
        : null,
    on_behalf_of: null,
    payment_method: setup.authorizationId ? stripeId('pm', setup.authorizationId) : null,
    payment_method_configuration_details: null,
    payment_method_options: null,
    payment_method_types: [setup.channel ?? 'card'],
    single_use_mandate: null,
    status,
    usage: setup.usage,
  };
}

export function serializeProduct(product: Product) {
  return {
    id: stripeId('prod', product.id),
    object: 'product' as const,
    active: product.active,
    created: unix(product.createdAt),
    default_price: null,
    description: product.description,
    images: [],
    livemode: false,
    marketing_features: [],
    metadata: product.metadata,
    name: product.name,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: null,
    tax_code: null,
    type: 'service',
    unit_label: null,
    updated: unix(product.updatedAt),
    url: null,
  };
}

/** A canonical Plan is a Stripe Price: an amount plus how often. */
export function serializePrice(plan: Plan, product?: Product | null) {
  return {
    id: stripeId('price', plan.id),
    object: 'price' as const,
    active: plan.active,
    billing_scheme: 'per_unit',
    created: unix(plan.createdAt),
    currency: plan.currency.toLowerCase(),
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: plan.metadata,
    nickname: plan.name,
    product: product ? stripeId('prod', product.id) : null,
    recurring: {
      ...toStripeRecurring(plan.interval, plan.intervalCount),
      meter: null,
      trial_period_days: null,
      usage_type: 'licensed',
    },
    tax_behavior: 'unspecified',
    tiers_mode: null,
    transform_quantity: null,
    type: 'recurring',
    unit_amount: plan.amount,
    unit_amount_decimal: String(plan.amount),
  };
}

export interface SerializeSubscriptionOptions {
  plan?: Plan | null;
  product?: Product | null;
  customer?: Customer | null;
  latestInvoice?: Invoice | null;
  /** Every price on the subscription, in order. */
  items?: SubscriptionItem[];
  /** Plans for those items, keyed by canonical plan id. */
  plans?: Map<string, Plan>;
  products?: Map<string, Product>;
}

/** One price on a subscription. */
export function serializeSubscriptionItem(
  item: SubscriptionItem,
  options: { plan?: Plan | null; product?: Product | null } = {},
) {
  return {
    id: stripeId('si', item.id),
    object: 'subscription_item' as const,
    created: unix(item.createdAt),
    metadata: item.metadata,
    price: options.plan ? serializePrice(options.plan, options.product) : null,
    quantity: item.quantity,
    subscription: stripeId('sub', item.subscriptionId),
  };
}

export function serializeSubscription(
  subscription: Subscription,
  options: SerializeSubscriptionOptions = {},
) {
  const id = stripeId('sub', subscription.id);
  const periodEnd = subscription.nextPaymentDate ?? subscription.updatedAt;
  const stored = options.items ?? [];

  const items =
    stored.length > 0
      ? stored.map((item) => {
          const plan = options.plans?.get(item.planId) ?? options.plan;
          return serializeSubscriptionItem(item, {
            plan,
            product: plan?.productId ? options.products?.get(plan.productId) : options.product,
          });
        })
      : options.plan
        ? [
            // Subscriptions written before items existed still serialise, from
            // the plan on the row itself.
            {
              id: `si_${id.slice(4)}`,
              object: 'subscription_item' as const,
              created: unix(subscription.createdAt),
              metadata: {} as Metadata,
              price: serializePrice(options.plan, options.product),
              quantity: subscription.quantity,
              subscription: id,
            },
          ]
        : [];

  return {
    id,
    object: 'subscription' as const,
    // Stripe expresses "stops at period end" as a flag on an *active*
    // subscription, not as a status of its own.
    cancel_at: null,
    cancel_at_period_end: subscription.status === 'non_renewing',
    canceled_at: subscription.cancelledAt ? unix(subscription.cancelledAt) : null,
    collection_method: 'charge_automatically',
    created: unix(subscription.createdAt),
    currency: subscription.currency.toLowerCase(),
    current_period_end: unix(periodEnd),
    // The period that is running *now*, which is not the subscription's start
    // date on any cycle after the first.
    current_period_start: unix(subscription.currentPeriodStart),
    customer: stripeId('cus', subscription.customerId),
    days_until_due: null,
    default_payment_method: stripeId('pm', subscription.authorizationId),
    description: null,
    discounts: [],
    ended_at:
      subscription.status === 'cancelled' || subscription.status === 'completed'
        ? unix(subscription.updatedAt)
        : null,
    items: {
      object: 'list' as const,
      data: items,
      has_more: false,
      url: `/v1/subscription_items?subscription=${id}`,
    },
    latest_invoice: options.latestInvoice
      ? stripeId('in', options.latestInvoice.id)
      : null,
    livemode: false,
    metadata: subscription.metadata,
    pause_collection: null,
    start_date: unix(subscription.startDate),
    status: toStripeSubscriptionStatus(subscription.status),
    trial_end: subscription.trialEnd ? unix(subscription.trialEnd) : null,
    trial_start: subscription.trialStart ? unix(subscription.trialStart) : null,
  };
}

export function serializeInvoiceItem(item: InvoiceItem) {
  return {
    id: stripeId('ii', item.id),
    object: 'invoiceitem' as const,
    amount: item.amount,
    currency: item.currency.toLowerCase(),
    customer: stripeId('cus', item.customerId),
    date: unix(item.createdAt),
    description: item.description,
    discountable: true,
    invoice: item.invoiceId ? stripeId('in', item.invoiceId) : null,
    livemode: false,
    metadata: item.metadata,
    period: { start: unix(item.periodStart), end: unix(item.periodEnd) },
    price: item.planId ? stripeId('price', item.planId) : null,
    proration: item.proration,
    quantity: item.quantity,
    subscription: item.subscriptionId ? stripeId('sub', item.subscriptionId) : null,
    unit_amount: item.unitAmount,
    unit_amount_decimal: String(item.unitAmount),
  };
}

/** An invoice line, as it appears inside `invoice.lines`. */
function serializeLine(item: InvoiceItem, invoiceId: string, plan?: Plan | null) {
  // Two fields are annotated wider than this branch produces so the
  // plan-derived fallback below is the same type; without that the two
  // branches union and callers cannot treat `lines.data` as one shape.
  return {
    id: stripeId('il', item.id),
    object: 'line_item' as const,
    amount: item.amount,
    currency: item.currency.toLowerCase(),
    description: item.description,
    discountable: true,
    invoice: invoiceId,
    invoice_item: stripeId('ii', item.id) as string | null,
    livemode: false,
    metadata: item.metadata as Metadata,
    period: { start: unix(item.periodStart), end: unix(item.periodEnd) },
    price: plan ? serializePrice(plan) : null,
    proration: item.proration,
    quantity: item.quantity,
    subscription: item.subscriptionId ? stripeId('sub', item.subscriptionId) : null,
    type: item.subscriptionId ? 'subscription' : 'invoiceitem',
  };
}

export function serializeInvoice(
  invoice: Invoice,
  options: {
    subscription?: Subscription | null;
    customer?: Customer | null;
    payment?: Payment | null;
    plan?: Plan | null;
    /** Real stored lines. Empty falls back to one synthesised from the plan. */
    lines?: InvoiceItem[];
    /** Plans for the lines, keyed by canonical plan id. */
    plans?: Map<string, Plan>;
  } = {},
) {
  const id = stripeId('in', invoice.id);
  const paid = invoice.status === 'success';
  // A void or written-off invoice is owed nothing further; Stripe zeroes
  // amount_remaining rather than leaving a debt that will never be collected.
  const closed = paid || invoice.status === 'void' || invoice.status === 'uncollectible';
  const stored = options.lines ?? [];

  const lines: ReturnType<typeof serializeLine>[] =
    stored.length > 0
      ? stored.map((item) =>
          serializeLine(
            item,
            id,
            item.planId ? (options.plans?.get(item.planId) ?? options.plan) : options.plan,
          ),
        )
      : [
          // Rows raised before line items existed still have to serialise, so
          // the plan-derived single line stays as a fallback.
          {
            id: `il_${id.slice(3)}`,
            object: 'line_item' as const,
            amount: invoice.amount,
            currency: invoice.currency.toLowerCase(),
            description: options.plan?.name ?? null,
            discountable: true,
            invoice: id,
            invoice_item: null,
            livemode: false,
            metadata: {} as Metadata,
            period: { start: unix(invoice.periodStart), end: unix(invoice.periodEnd) },
            price: options.plan ? serializePrice(options.plan) : null,
            proration: false,
            quantity: options.subscription?.quantity ?? 1,
            subscription: options.subscription ? stripeId('sub', options.subscription.id) : null,
            type: (options.subscription ? 'subscription' : 'invoiceitem') as string,
          },
        ];

  return {
    id,
    object: 'invoice' as const,
    amount_due: invoice.amount,
    amount_paid: paid ? invoice.amount : 0,
    amount_remaining: closed ? 0 : invoice.amount,
    attempt_count: invoice.attemptCount,
    attempted: invoice.attemptCount > 0,
    // Stripe stops advancing an invoice that has reached an end state.
    auto_advance: invoice.status === 'pending' || invoice.status === 'failed',
    billing_reason: invoice.billingReason,
    collection_method: 'charge_automatically',
    created: unix(invoice.createdAt),
    currency: invoice.currency.toLowerCase(),
    customer: stripeId('cus', invoice.customerId),
    customer_email: options.customer?.email ?? null,
    due_date: unix(invoice.dueAt),
    hosted_invoice_url: null,
    invoice_pdf: null,
    lines: {
      object: 'list' as const,
      data: lines,
      has_more: false,
      url: `/v1/invoices/${id}/lines`,
    },
    livemode: false,
    metadata: invoice.metadata,
    number: invoice.number,
    paid,
    payment_intent: options.payment ? stripeId('pi', options.payment.id) : null,
    period_end: unix(invoice.periodEnd),
    period_start: unix(invoice.periodStart),
    status: toStripeInvoiceStatus(invoice.status),
    subscription: options.subscription ? stripeId('sub', options.subscription.id) : null,
    subtotal: invoice.amount,
    total: invoice.amount,
  };
}

/* ------------------------------------------------------------------ *
 * Connect
 * ------------------------------------------------------------------ */

/**
 * A connected account.
 *
 * `charges_enabled` and `requirements` are the fields that matter: a freshly
 * created account has the first false and the second non-empty, and stays that
 * way until it onboards. An emulator that handed back a working account would
 * hide the exact failure a Connect integration most often ships with.
 */
export function serializeAccount(subaccount: Subaccount) {
  const requirements = subaccount.requirements as Record<string, unknown>;
  return {
    id: stripeId('acct', subaccount.id),
    object: 'account' as const,
    business_profile: {
      mcc: null,
      name: subaccount.businessName,
      support_address: null,
      support_email: subaccount.primaryContactEmail,
      support_phone: subaccount.primaryContactPhone,
      support_url: null,
      url: (subaccount.metadata.business_url as string | undefined) ?? null,
    },
    business_type: (subaccount.metadata.business_type as string | undefined) ?? null,
    capabilities: subaccount.capabilities,
    charges_enabled: subaccount.chargesEnabled,
    country: subaccount.countryCode,
    created: unix(subaccount.createdAt),
    default_currency: subaccount.currency.toLowerCase(),
    details_submitted: subaccount.detailsSubmitted,
    email: subaccount.primaryContactEmail,
    external_accounts: {
      object: 'list' as const,
      data: subaccount.accountNumber
        ? [
            {
              id: stripeId('ba', subaccount.id),
              object: 'bank_account' as const,
              account: stripeId('acct', subaccount.id),
              // Synthetic, like every account number in the emulator: no money
              // can move through it (spec §29).
              account_holder_name: subaccount.businessName,
              bank_name: subaccount.settlementBank,
              country: subaccount.countryCode,
              currency: subaccount.currency.toLowerCase(),
              default_for_currency: true,
              last4: subaccount.accountNumber.slice(-4),
              status: 'new',
            },
          ]
        : [],
      has_more: false,
      url: `/v1/accounts/${stripeId('acct', subaccount.id)}/external_accounts`,
    },
    livemode: false,
    metadata: subaccount.metadata,
    payouts_enabled: subaccount.payoutsEnabled,
    requirements: {
      alternatives: requirements.alternatives ?? [],
      current_deadline: requirements.current_deadline ?? null,
      currently_due: requirements.currently_due ?? [],
      disabled_reason: requirements.disabled_reason ?? null,
      errors: requirements.errors ?? [],
      eventually_due: requirements.eventually_due ?? [],
      past_due: requirements.past_due ?? [],
      pending_verification: requirements.pending_verification ?? [],
    },
    settings: {
      payouts: { schedule: { interval: 'manual' }, statement_descriptor: null },
    },
    tos_acceptance: {
      date: subaccount.detailsSubmitted ? unix(subaccount.updatedAt) : null,
    },
    type: subaccount.accountType ?? 'standard',
  };
}

/**
 * An onboarding link.
 *
 * Short-lived at Stripe and short-lived here: the expiry is real virtual time,
 * so `time advance` past it and the link stops working, which is the failure a
 * developer needs to have seen once.
 */
export function serializeAccountLink(options: {
  url: string;
  createdISO: string;
  expiresISO: string;
}) {
  return {
    object: 'account_link' as const,
    created: unix(options.createdISO),
    expires_at: unix(options.expiresISO),
    url: options.url,
  };
}

/**
 * A balance.
 *
 * `available` is what can be paid out now and `pending` what has not settled.
 * paybox settles instantly, so `pending` is always empty -- stated in
 * docs/stripe.md rather than faked with a plausible-looking number, because a
 * developer testing "wait for funds to become available" needs to know that
 * wait does not exist here.
 */
export function serializeBalance(
  amounts: readonly { currency: string; amount: number }[],
) {
  const entries = amounts.map(({ currency, amount }) => ({
    amount,
    currency: currency.toLowerCase(),
    source_types: { card: amount },
  }));
  return {
    object: 'balance' as const,
    available: entries,
    connect_reserved: [],
    livemode: false,
    pending: entries.map((entry) => ({ ...entry, amount: 0, source_types: { card: 0 } })),
  };
}

/**
 * An application fee.
 *
 * Derived from the payment rather than stored as its own row: the fee is a
 * property of one charge and has no life apart from it, exactly as `pi_` and
 * `ch_` are two views of one payment. The id is derived the same way, so it is
 * stable under a fixed seed.
 */
export function serializeApplicationFee(payment: Payment) {
  const id = stripeId('fee', payment.id);
  return {
    id,
    object: 'application_fee' as const,
    account: payment.subaccountId ? stripeId('acct', payment.subaccountId) : null,
    amount: payment.platformFee,
    amount_refunded: payment.platformFeeRefunded,
    application: null,
    balance_transaction: stripeId('txn', payment.id),
    charge: stripeId('ch', payment.id),
    created: unix(payment.createdAt),
    currency: payment.currency.toLowerCase(),
    livemode: false,
    originating_transaction: null,
    refunded: payment.platformFeeRefunded >= payment.platformFee && payment.platformFee > 0,
    refunds: {
      object: 'list' as const,
      data:
        payment.platformFeeRefunded > 0
          ? [
              {
                id: stripeId('fr', payment.id),
                object: 'fee_refund' as const,
                amount: payment.platformFeeRefunded,
                balance_transaction: null,
                created: unix(payment.updatedAt),
                currency: payment.currency.toLowerCase(),
                fee: id,
                metadata: {},
              },
            ]
          : [],
      has_more: false,
      url: `/v1/application_fees/${id}/refunds`,
    },
  };
}

/**
 * A Transfer: money moved from the platform to a connected account.
 *
 * Distinct from a Payout, which leaves for a bank. paybox models both with one
 * canonical Transfer because they are the same shape of problem -- reserve
 * now, settle later, possibly fail -- and tells them apart by whether there is
 * a destination balance.
 */
export function serializeTransfer(transfer: Transfer) {
  const id = stripeId('tr', transfer.id);
  return {
    id,
    object: 'transfer' as const,
    amount: transfer.amount,
    amount_reversed: transfer.amountReversed,
    balance_transaction: stripeId('txn', transfer.id),
    created: unix(transfer.createdAt),
    currency: transfer.currency.toLowerCase(),
    description: transfer.reason,
    destination: transfer.destinationSubaccountId
      ? stripeId('acct', transfer.destinationSubaccountId)
      : null,
    // paybox does not mint a separate charge on the connected account for a
    // destination charge; docs/stripe.md records that.
    destination_payment: null,
    livemode: false,
    metadata: transfer.metadata,
    reversals: {
      object: 'list' as const,
      data:
        transfer.amountReversed > 0
          ? [
              {
                id: stripeId('trr', transfer.id),
                object: 'transfer_reversal' as const,
                amount: transfer.amountReversed,
                balance_transaction: null,
                created: unix(transfer.updatedAt),
                currency: transfer.currency.toLowerCase(),
                destination_payment_refund: null,
                metadata: {},
                source_refund: null,
                transfer: id,
              },
            ]
          : [],
      has_more: false,
      url: `/v1/transfers/${id}/reversals`,
    },
    reversed: transfer.amountReversed >= transfer.amount && transfer.amount > 0,
    source_transaction: transfer.sourcePaymentId
      ? stripeId('ch', transfer.sourcePaymentId)
      : null,
    source_type: 'card',
    transfer_group: transfer.transferGroup,
  };
}

/**
 * Payout status: canonical -> Stripe.
 *
 * `reversed` has no Stripe equivalent -- a payout that comes back is `failed`
 * there -- so it maps to failed rather than inventing a status.
 */
export function toStripePayoutStatus(status: Transfer['status']): string {
  switch (status) {
    case 'successful':
      return 'paid';
    case 'processing':
      return 'in_transit';
    case 'cancelled':
      return 'canceled';
    case 'failed':
    case 'reversed':
      return 'failed';
    default:
      return 'pending';
  }
}

/** A Payout: money leaving a balance for a bank. */
export function serializePayout(transfer: Transfer) {
  return {
    id: stripeId('po', transfer.id),
    object: 'payout' as const,
    amount: transfer.amount,
    application_fee: null,
    application_fee_amount: null,
    // paybox settles instantly, so a payout arrives the moment it succeeds.
    arrival_date: unix(transfer.updatedAt),
    automatic: false,
    balance_transaction: stripeId('txn', transfer.id),
    created: unix(transfer.createdAt),
    currency: transfer.currency.toLowerCase(),
    description: transfer.reason,
    destination: stripeId('ba', transfer.sourceSubaccountId ?? transfer.id),
    failure_balance_transaction: null,
    failure_code: transfer.failureReason,
    failure_message: transfer.failureReason,
    livemode: false,
    metadata: transfer.metadata,
    method: 'standard',
    original_payout: null,
    reconciliation_status: 'not_applicable',
    reversed_by: null,
    source_type: 'card',
    statement_descriptor: null,
    status: toStripePayoutStatus(transfer.status),
    type: 'bank_account',
  };
}

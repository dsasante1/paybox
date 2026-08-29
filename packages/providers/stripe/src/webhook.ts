import type { PayboxEvent } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { stripeSignatureHeaders } from './signature.js';
import {
  serializeAccount,
  serializeApplicationFee,
  serializeCharge,
  serializePayout,
  serializeTransfer,
  serializeCheckoutSession,
  serializeCustomer,
  serializeInvoice,
  serializePaymentMethod,
  serializeSetupIntent,
  serializeSubscription,
  serializeEvent,
  serializePaymentIntent,
  serializeRefund,
} from './serializers.js';

/**
 * The API version stamped on every event.
 *
 * Matches the spec this adapter was built against, so a developer comparing
 * payloads knows which shape to expect.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/**
 * Canonical event -> Stripe webhook event.
 *
 * Only events Stripe actually sends. Note the asymmetry with Paystack: Stripe
 * *does* have a failure webhook (`payment_intent.payment_failed`), because its
 * intent survives the failure and the merchant is expected to react. Paystack
 * has no `charge.failed` at all.
 *
 * A canonical failure fans out to two Stripe events -- the intent's and the
 * charge's -- because Stripe reports them on separate objects with different
 * lifetimes. Verified against `stripe/openapi`, read 2026-08-28.
 */
const EVENT_MAP: Record<string, readonly string[]> = {
  'payment.created': ['payment_intent.created'],
  'payment.processing': ['payment_intent.processing'],
  'payment.requires_action': ['payment_intent.requires_action'],
  'payment.authorized': ['payment_intent.amount_capturable_updated'],
  // A settled session also completes; the checkout entry is dropped for
  // payments that are not sessions, in #buildData.
  'payment.successful': [
    'payment_intent.succeeded',
    'charge.succeeded',
    'checkout.session.completed',
  ],
  'payment.failed': ['payment_intent.payment_failed', 'charge.failed'],
  'payment.cancelled': ['payment_intent.canceled'],
  'payment.expired': ['payment_intent.canceled', 'checkout.session.expired'],
  'refund.created': ['refund.created'],
  'refund.successful': ['charge.refunded', 'refund.updated'],
  'refund.failed': ['refund.failed'],
  'customer.created': ['customer.created'],
  // SetupIntents. Note the absence of anything for `processing` or
  // `requires_confirmation`: Stripe sends no event for either, and inventing
  // one would teach a developer to wait for a webhook that never arrives.
  'setup.created': ['setup_intent.created'],
  'setup.requires_action': ['setup_intent.requires_action'],
  'setup.successful': ['setup_intent.succeeded'],
  'setup.failed': ['setup_intent.setup_failed'],
  'setup.cancelled': ['setup_intent.canceled'],
  // An instrument bound to a customer. Dropped in #buildData when there is no
  // customer, because Stripe only reports an *attachment*.
  'authorization.created': ['payment_method.attached'],
  'authorization.attached': ['payment_method.attached'],
  'authorization.detached': ['payment_method.detached'],
  // Connect. Note there is no `account.created`: Stripe does not send one,
  // because the platform made the account and already knows.
  'subaccount.created': ['account.updated'],
  'subaccount.updated': ['account.updated'],
  'application_fee.refunded': ['application_fee.refunded'],
  // Transfers and payouts share one canonical resource, so the formatter
  // decides which Stripe object an event is about by whether it has a
  // destination balance -- see #buildData.
  'transfer.created': ['transfer.created', 'payout.created'],
  'transfer.pending': ['payout.created'],
  'transfer.processing': ['payout.updated'],
  'transfer.successful': ['transfer.created', 'payout.paid'],
  'transfer.failed': ['payout.failed'],
  'transfer.cancelled': ['payout.canceled'],
  'transfer.reversed': ['transfer.reversed'],
  'subscription.created': ['customer.subscription.created'],
  'subscription.updated': ['customer.subscription.updated'],
  'subscription.non_renewing': ['customer.subscription.updated'],
  'subscription.attention': ['customer.subscription.updated'],
  // A trial converting to paid is an update, not a creation.
  'subscription.active': ['customer.subscription.updated'],
  'subscription.trial_ending': ['customer.subscription.trial_will_end'],
  'subscription.cancelled': ['customer.subscription.deleted'],
  'subscription.completed': ['customer.subscription.deleted'],
  'invoice.created': ['invoice.created'],
  'invoice.finalized': ['invoice.finalized'],
  'invoice.success': ['invoice.paid', 'invoice.payment_succeeded'],
  'invoice.payment_failed': ['invoice.payment_failed'],
  'invoice.void': ['invoice.voided'],
  'invoice.uncollectible': ['invoice.marked_uncollectible'],
  'invoiceitem.created': ['invoiceitem.created'],
};

/** Which Stripe object each event carries in `data.object`. */
function subjectFor(
  eventType: string,
):
  | 'intent'
  | 'charge'
  | 'refund'
  | 'customer'
  | 'session'
  | 'subscription'
  | 'invoice'
  | 'setup'
  | 'account'
  | 'application_fee'
  | 'transfer'
  | 'payout'
  | 'payment_method' {
  if (eventType.startsWith('customer.subscription.')) return 'subscription';
  if (eventType.startsWith('setup_intent.')) return 'setup';
  if (eventType.startsWith('account.')) return 'account';
  if (eventType.startsWith('application_fee.')) return 'application_fee';
  if (eventType.startsWith('transfer.')) return 'transfer';
  if (eventType.startsWith('payout.')) return 'payout';
  if (eventType.startsWith('payment_method.')) return 'payment_method';
  if (eventType.startsWith('invoice.')) return 'invoice';
  if (eventType.startsWith('checkout.session.')) return 'session';
  if (eventType.startsWith('charge.refunded')) return 'charge';
  if (eventType.startsWith('charge.')) return 'charge';
  if (eventType.startsWith('refund.')) return 'refund';
  if (eventType.startsWith('customer.')) return 'customer';
  return 'intent';
}

export interface StripeFormatterOptions {
  baseUrl?: string;
  basePath?: string;
}

export class StripeWebhookFormatter implements WebhookFormatter {
  readonly provider = 'stripe' as const;
  /**
   * Stripe signs `${timestamp}.${payload}` and regenerates both on every
   * delivery attempt, so a retry must be re-signed rather than replayed.
   */
  readonly resignsPerAttempt = true;

  readonly #basePath: string;

  constructor(options: StripeFormatterOptions = {}) {
    this.#basePath = options.basePath ?? '/stripe';
  }

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook[] | null> {
    const types = EVENT_MAP[event.type];
    if (!types || types.length === 0) return null;

    // Stripe reports one thing happening on several objects: a settlement is
    // both `payment_intent.succeeded` and `charge.succeeded`, each carrying its
    // own object. Each becomes its own delivery, so an endpoint subscribed to
    // only one of them receives only that.
    const webhooks: FormattedWebhook[] = [];
    for (const eventType of types) {
      const data = await this.#buildData(event, eventType, context);
      if (!data) continue;
      webhooks.push({
        eventType,
        body: serializeEvent(event, eventType, data, STRIPE_API_VERSION),
      });
    }
    return webhooks.length > 0 ? webhooks : null;
  }

  async #buildData(
    event: PayboxEvent,
    eventType: string,
    context: FormatterContext,
  ): Promise<unknown> {
    const { storage, baseUrl } = context;
    const subject = subjectFor(eventType);

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment) return null;
      const customer = payment.customerId
        ? await storage.customers.byId(payment.customerId)
        : null;

      if (subject === 'application_fee') {
        // The fee lives on the charge, so an event about it carries the
        // derived fee object rather than the payment.
        return payment.platformFee > 0 ? serializeApplicationFee(payment) : null;
      }

      // Only a payment created through Checkout has a session to report on.
      // Returning null drops just this entry from the fan-out.
      if (subject === 'session') {
        if (!payment.metadata.mode) return null;
        return serializeCheckoutSession(payment, {
          customer,
          baseUrl,
          basePath: this.#basePath,
        });
      }

      return subject === 'charge'
        ? serializeCharge(payment, { customer })
        : serializePaymentIntent(payment, {
            customer,
            baseUrl,
            basePath: this.#basePath,
          });
    }

    if (event.resourceType === 'refund') {
      const refund = await storage.refunds.byId(event.resourceId);
      if (!refund) return null;
      const payment = await storage.payments.byId(refund.paymentId);
      // `charge.refunded` carries the charge, not the refund.
      if (subject === 'charge') {
        if (!payment) return null;
        const customer = payment.customerId
          ? await storage.customers.byId(payment.customerId)
          : null;
        return serializeCharge(payment, { customer });
      }
      return serializeRefund(refund, payment);
    }

    if (event.resourceType === 'subscription') {
      const subscription = await storage.subscriptions.byId(event.resourceId);
      if (!subscription) return null;
      const plan = await storage.plans.byId(subscription.planId);
      const invoices = await storage.invoices.listBySubscription(subscription.id);
      const items = await storage.subscriptionItems.listBySubscription(subscription.id);

      const plans = new Map<string, NonNullable<typeof plan>>();
      const products = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof storage.products.byId>>>
      >();
      for (const planId of new Set(items.map((item) => item.planId))) {
        const found = await storage.plans.byId(planId);
        if (!found) continue;
        plans.set(found.id, found);
        if (found.productId && !products.has(found.productId)) {
          const product = await storage.products.byId(found.productId);
          if (product) products.set(product.id, product);
        }
      }

      return serializeSubscription(subscription, {
        plan,
        product: plan?.productId ? await storage.products.byId(plan.productId) : null,
        customer: await storage.customers.byId(subscription.customerId),
        latestInvoice: invoices.at(-1) ?? null,
        items,
        plans,
        products,
      });
    }

    if (event.resourceType === 'invoice') {
      const invoice = await storage.invoices.byId(event.resourceId);
      if (!invoice) return null;
      const subscription = invoice.subscriptionId
        ? await storage.subscriptions.byId(invoice.subscriptionId)
        : null;
      const lines = await storage.invoiceItems.listByInvoice(invoice.id);
      const plans = new Map<string, NonNullable<Awaited<ReturnType<typeof storage.plans.byId>>>>();
      for (const planId of new Set(lines.map((line) => line.planId).filter(Boolean))) {
        const plan = await storage.plans.byId(planId as string);
        if (plan) plans.set(plan.id, plan);
      }
      return serializeInvoice(invoice, {
        subscription,
        customer: await storage.customers.byId(invoice.customerId),
        payment: invoice.paymentId ? await storage.payments.byId(invoice.paymentId) : null,
        plan: subscription ? await storage.plans.byId(subscription.planId) : null,
        lines,
        plans,
      });
    }

    if (event.resourceType === 'setup') {
      const setup = await storage.instrumentSetups.byId(event.resourceId);
      if (!setup) return null;
      return serializeSetupIntent(setup, {
        customer: setup.customerId ? await storage.customers.byId(setup.customerId) : null,
        authorization: setup.authorizationId
          ? await storage.authorizations.byId(setup.authorizationId)
          : null,
        baseUrl,
        basePath: this.#basePath,
      });
    }

    if (event.resourceType === 'authorization') {
      const authorization = await storage.authorizations.byId(event.resourceId);
      if (!authorization) return null;
      // `payment_method.attached` is about the *attachment*. An instrument
      // minted with nobody attached is not one, so this entry is dropped
      // rather than reported as an attach that never happened.
      if (eventType === 'payment_method.attached' && !authorization.customerId) return null;
      const customer = authorization.customerId
        ? await storage.customers.byId(authorization.customerId)
        : null;
      return serializePaymentMethod(authorization, customer);
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      if (!transfer) return null;
      // One canonical resource, two Stripe objects. A movement between
      // balances is a Transfer; one that left for a bank is a Payout. Dropping
      // the entry that does not apply keeps an endpoint subscribed to only
      // `payout.paid` from receiving transfer events it never asked for.
      const isPayout = transfer.destinationSubaccountId === null;
      if (subject === 'payout') return isPayout ? serializePayout(transfer) : null;
      if (subject === 'transfer') return isPayout ? null : serializeTransfer(transfer);
      return null;
    }

    if (event.resourceType === 'subaccount') {
      const subaccount = await storage.subaccounts.byId(event.resourceId);
      return subaccount ? serializeAccount(subaccount) : null;
    }

    if (event.resourceType === 'customer') {
      const customer = await storage.customers.byId(event.resourceId);
      return customer ? serializeCustomer(customer) : null;
    }

    return null;
  }

  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    return stripeSignatureHeaders(rawBody, secret, context.timestamp);
  }
}

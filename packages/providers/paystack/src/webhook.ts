import type { PayboxEvent } from '@paybox/shared';
import type { FormattedWebhook, FormatterContext, WebhookFormatter } from '@paybox/webhooks';
import { paystackSignatureHeaders } from './signature.js';
import {
  serializeDedicatedAccount,
  serializeInvoice,
  serializeRefund,
  serializeSubscription,
  serializeTransaction,
  serializeTransfer,
} from './serializers.js';

/**
 * Canonical event -> Paystack webhook event.
 *
 * Only events Paystack actually sends are listed. In particular there is no
 * entry for `payment.failed`: Paystack's documented event list covers
 * charge.success, transfer.success/failed/reversed, refund.processed and the
 * subscription/invoice events -- it does not send a webhook for a failed
 * charge. Emitting one would teach developers to rely on a callback that will
 * never arrive in production, which is the opposite of what this tool is for.
 *
 * A failed *renewal* is different and does have a webhook:
 * `invoice.payment_failed`. That is the signal a dunning flow listens for, and
 * it is why the emulator raises invoices rather than only charging.
 *
 * Event names verified 2026-08-27 against the Paystack AsyncAPI mirror at
 * https://apis.io/asyncapis/paystack/paystack-webhooks-asyncapi/, since
 * paystack.com/docs refuses automated fetches. If Paystack adds events, add
 * them here after checking that source -- not from memory.
 */
const EVENT_MAP: Record<string, string> = {
  'payment.successful': 'charge.success',
  'refund.successful': 'refund.processed',
  'transfer.successful': 'transfer.success',
  'transfer.failed': 'transfer.failed',
  'transfer.reversed': 'transfer.reversed',
  'dedicated_account.assigned': 'dedicatedaccount.assign.success',
  'dedicated_account.assign_failed': 'dedicatedaccount.assign.failed',
  'subscription.created': 'subscription.create',
  'subscription.non_renewing': 'subscription.not_renew',
  'subscription.cancelled': 'subscription.disable',
  'subscription.completed': 'subscription.disable',
  'invoice.created': 'invoice.create',
  'invoice.success': 'invoice.update',
  'invoice.payment_failed': 'invoice.payment_failed',
};

export class PaystackWebhookFormatter implements WebhookFormatter {
  readonly provider = 'paystack' as const;

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | null> {
    const eventType = EVENT_MAP[event.type];
    if (!eventType) return null;

    const data = await this.#buildData(event, context);
    if (!data) return null;

    return { eventType, body: { event: eventType, data } };
  }

  async #buildData(event: PayboxEvent, context: FormatterContext): Promise<unknown> {
    const { storage } = context;

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment) return null;
      const customer = payment.customerId
        ? await storage.customers.byId(payment.customerId)
        : null;
      const events = await storage.events.listByResource(payment.id);
      return serializeTransaction(payment, { customer, events });
    }

    if (event.resourceType === 'refund') {
      const refund = await storage.refunds.byId(event.resourceId);
      if (!refund) return null;
      const payment = await storage.payments.byId(refund.paymentId);
      return serializeRefund(refund, payment);
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      if (!transfer) return null;
      return serializeTransfer(transfer);
    }

    if (event.resourceType === 'subscription') {
      const subscription = await storage.subscriptions.byId(event.resourceId);
      if (!subscription) return null;
      return serializeSubscription(subscription, {
        plan: await storage.plans.byId(subscription.planId),
        customer: await storage.customers.byId(subscription.customerId),
        authorization: await storage.authorizations.byId(subscription.authorizationId),
      });
    }

    if (event.resourceType === 'invoice') {
      const invoice = await storage.invoices.byId(event.resourceId);
      if (!invoice) return null;
      const payment = invoice.paymentId
        ? await storage.payments.byId(invoice.paymentId)
        : null;
      const subscription = await storage.subscriptions.byId(invoice.subscriptionId);
      return {
        ...serializeInvoice(invoice, payment),
        ...(subscription ? { subscription: serializeSubscription(subscription) } : {}),
      };
    }

    if (event.resourceType === 'dedicated_account') {
      const account = await storage.dedicatedAccounts.byId(event.resourceId);
      // A failed assignment has no row, so the event's own payload -- the
      // customer and the reason -- is all there is to send.
      if (!account) return event.data;
      const customer = await storage.customers.byId(account.customerId);
      return serializeDedicatedAccount(account, customer);
    }

    return null;
  }

  sign(rawBody: string, secret: string): Record<string, string> {
    return paystackSignatureHeaders(rawBody, secret);
  }
}

/**
 * Paystack's documented retry schedule, for use as this provider's default.
 *
 * Test mode retries hourly for 10 hours; live mode retries every 3 minutes for
 * the first 4 attempts and then hourly for up to 72 hours. We model test mode,
 * since that is what a local emulator corresponds to. Verified 2026-08-27.
 */
export function paystackRetrySchedule(attempt: number): number {
  return 3_600_000 * Math.max(1, attempt === 0 ? 1 : 1);
}

export const PAYSTACK_TEST_MODE_MAX_ATTEMPTS = 10;

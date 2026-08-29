import type { PayboxEvent } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { koraSignatureHeaders } from './signature.js';
import { serializeCharge, serializePayout, serializeRefund } from './serializers.js';

/**
 * Canonical event -> Kora webhook.
 *
 * Verified at developers.korapay.com/docs/webhooks (read 2026-08-29).
 *
 * Unlike Flutterwave, Kora **does** distinguish success from failure by event
 * name -- `charge.success` and `charge.failed` are separate events -- so an
 * integration can branch on the name here where it could not there. That
 * difference between two providers in the same market is exactly the kind of
 * thing an emulator should preserve rather than smooth over.
 */
const EVENT_MAP: Record<string, string> = {
  'payment.successful': 'charge.success',
  'payment.failed': 'charge.failed',
  'payment.expired': 'charge.expired',
  'refund.successful': 'refund.success',
  'refund.failed': 'refund.failed',
  'transfer.successful': 'transfer.success',
  'transfer.failed': 'transfer.failed',
  'transfer.reversed': 'transfer.reversed',
};

export class KoraWebhookFormatter implements WebhookFormatter {
  readonly provider = 'kora' as const;
  /**
   * The signature covers only the `data` object and carries no timestamp, so
   * it is identical on every attempt and a retry can replay the stored
   * headers.
   */
  readonly resignsPerAttempt = false;

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
      return serializeCharge(payment, {
        customer: payment.customerId ? await storage.customers.byId(payment.customerId) : null,
      });
    }

    if (event.resourceType === 'refund') {
      const refund = await storage.refunds.byId(event.resourceId);
      if (!refund) return null;
      return serializeRefund(refund, await storage.payments.byId(refund.paymentId));
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      return transfer ? serializePayout(transfer) : null;
    }

    return null;
  }

  /**
   * Kora signs **only the `data` object**, hex-encoded, with the secret key.
   *
   * See signature.ts: this leaves `event` outside the signature, which is a
   * real property of Kora's scheme and one the emulator reproduces rather than
   * quietly improving on.
   */
  sign(rawBody: string, secret: string, _context: SigningContext): Record<string, string> {
    return koraSignatureHeaders(rawBody, secret);
  }
}

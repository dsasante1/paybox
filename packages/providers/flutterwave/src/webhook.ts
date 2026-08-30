import type { PayboxEvent } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { v3SignatureHeaders, v4SignatureHeaders } from './signature.js';
import { formatV4Webhook, type V4Resource } from './v4/webhook.js';
import { isV4 } from './v4/version.js';
import {
  serializeDispute,
  serializeSubscription,
  serializeTransaction,
  serializeTransfer,
} from './serializers.js';
import { toFlutterwavePaymentType } from './status.js';

/** The API version an event is formatted for. */
export type FlutterwaveApiVersion = 'v3' | 'v4';

/**
 * Canonical event -> Flutterwave webhook.
 *
 * Verified against developer.flutterwave.com/v3.0.0/docs/webhooks (read
 * 2026-08-29).
 *
 * The thing to notice: **`charge.completed` is sent for a failure too.**
 * Flutterwave does not have a separate failure event -- the receiver has to
 * read `data.status` to find out whether the money moved. That is a real trap
 * for an integration that assumes an event name implies success, so the
 * emulator reproduces it exactly rather than helpfully inventing a
 * `charge.failed` that Flutterwave would never send.
 *
 * Nothing is emitted for the in-flight states. Flutterwave notifies on
 * completion, not on progress, and a developer waiting for a
 * `charge.processing` that never arrives would be debugging the emulator's
 * invention rather than their integration.
 */
const EVENT_MAP: Record<string, string> = {
  'payment.successful': 'charge.completed',
  'payment.failed': 'charge.completed',
  'transfer.successful': 'transfer.completed',
  'transfer.failed': 'transfer.completed',
  'transfer.reversed': 'transfer.completed',
  'subscription.cancelled': 'subscription.cancelled',
  'dispute.created': 'chargeback.created',
};

export interface FlutterwaveFormatterOptions {
  /**
   * The API version to assume for a resource that carries no version marker.
   * Defaults to v3. A resource the v4 API created is marked at creation
   * (`v4/version.ts`) and always gets v4's envelope and signature, whatever
   * this says: the version is a fact about the resource, not the formatter.
   */
  version?: FlutterwaveApiVersion;
}

export class FlutterwaveWebhookFormatter implements WebhookFormatter {
  readonly provider = 'flutterwave' as const;
  readonly #version: FlutterwaveApiVersion;

  /**
   * v3's `verif-hash` is the secret verbatim, so it is identical on every
   * attempt and can be replayed from storage. v4 signs the body, but the
   * signature still depends only on bytes that do not change between attempts
   * -- there is no timestamp in it, unlike Stripe's -- so neither version
   * needs re-signing.
   */
  readonly resignsPerAttempt = false;

  constructor(options: FlutterwaveFormatterOptions = {}) {
    this.#version = options.version ?? 'v3';
  }

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | null> {
    // One formatter serves both of Flutterwave's APIs. A resource the v4 API
    // created gets v4's envelope, event names and -- via `variant`, which the
    // dispatcher hands back to `sign()` -- v4's signature. Everything else
    // is v3, below.
    const v4 = await this.#v4Resource(event, context);
    if (v4) return formatV4Webhook(event, v4, context);

    const eventType = EVENT_MAP[event.type];
    if (!eventType) return null;

    const data = await this.#buildData(event, context);
    if (!data) return null;

    return {
      eventType,
      body: {
        event: eventType,
        // Flutterwave stamps the instrument kind alongside the event name.
        'event.type': this.#eventKind(event, eventType),
        data,
      },
    };
  }

  /**
   * The resource behind an event, when the v4 API created it.
   *
   * Only the resource types that have a v4 webhook are loaded; anything
   * else, and anything unmarked, is v3.
   */
  async #v4Resource(event: PayboxEvent, context: FormatterContext): Promise<V4Resource | null> {
    const { storage } = context;
    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      return payment && isV4(payment) ? { kind: 'payment', payment } : null;
    }
    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      return transfer && isV4(transfer) ? { kind: 'transfer', transfer } : null;
    }
    if (event.resourceType === 'refund') {
      const refund = await storage.refunds.byId(event.resourceId);
      if (!refund || !isV4(refund)) return null;
      return { kind: 'refund', refund, payment: await storage.payments.byId(refund.paymentId) };
    }
    return null;
  }

  /** Flutterwave's `event.type`: the rail, not the outcome. */
  #eventKind(event: PayboxEvent, eventType: string): string {
    if (eventType === 'transfer.completed') return 'Transfer';
    if (eventType === 'chargeback.created') return 'Chargeback';
    if (eventType === 'subscription.cancelled') return 'Subscription';
    const method = event.data.payment_method;
    return `${toFlutterwavePaymentType(
      typeof method === 'string' ? (method as never) : null,
    ).toUpperCase()}_TRANSACTION`;
  }

  async #buildData(event: PayboxEvent, context: FormatterContext): Promise<unknown> {
    const { storage } = context;

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment) return null;
      return serializeTransaction(payment, {
        customer: payment.customerId ? await storage.customers.byId(payment.customerId) : null,
      });
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      return transfer ? serializeTransfer(transfer) : null;
    }

    if (event.resourceType === 'subscription') {
      const subscription = await storage.subscriptions.byId(event.resourceId);
      if (!subscription) return null;
      return serializeSubscription(
        subscription,
        await storage.plans.byId(subscription.planId),
      );
    }

    if (event.resourceType === 'dispute') {
      const dispute = await storage.disputes.byId(event.resourceId);
      if (!dispute) return null;
      return serializeDispute(dispute, await storage.payments.byId(dispute.paymentId));
    }

    return null;
  }

  /**
   * v3 sends the secret verbatim in `verif-hash`; v4 sends a base64
   * HMAC-SHA256 of the body in `flutterwave-signature`. Both are reproduced
   * because a developer's verification code has to work here unchanged, and
   * half of them are still on v3. See signature.ts on why the v3 scheme is
   * weak and reproduced anyway.
   */
  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    // `format()` said which wire format it built; sign to match. A stored
    // delivery re-signed without a variant falls back to the default, which
    // is fine because neither version's signature changes between attempts.
    const version: FlutterwaveApiVersion =
      context.variant === 'v4' || context.variant === 'v3' ? context.variant : this.#version;
    return version === 'v4' ? v4SignatureHeaders(rawBody, secret) : v3SignatureHeaders(secret);
  }
}

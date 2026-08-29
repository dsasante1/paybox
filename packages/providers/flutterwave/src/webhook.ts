import type { PayboxEvent } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { v3SignatureHeaders, v4SignatureHeaders } from './signature.js';
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
  /** Which API version's shape and signature to produce. Defaults to v3. */
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
  sign(rawBody: string, secret: string, _context: SigningContext): Record<string, string> {
    return this.#version === 'v4'
      ? v4SignatureHeaders(rawBody, secret)
      : v3SignatureHeaders(secret);
  }
}

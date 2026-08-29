import { createHash } from 'node:crypto';
import type { PayboxEvent, Transfer } from '@paybox/shared';
import type {
  FormattedWebhook,
  FormatterContext,
  SigningContext,
  WebhookFormatter,
} from '@paybox/webhooks';
import { signWisePayload, WISE_DELIVERY_HEADER, WISE_SIGNATURE_HEADER } from './signature.js';
import { numericId } from './ids.js';
import { LOCAL_USER_ID, serializeTransfer } from './serializers.js';

/**
 * Canonical event -> Wise webhook.
 *
 * Verified against the Wise Platform API OpenAPI 3.1.0 document, version
 * `2026Q3`, and the event catalogue at
 * docs.wise.com/guides/developer/webhooks/event-handling (read 2026-08-29).
 *
 * Wise's event envelope is unlike the four before it. There is no top-level
 * `event` or `eventType` string naming what happened in the past tense.
 * Instead the subscription declares a `trigger_on` (`transfers#state-change`)
 * and every delivery carries `event_type`, a `schema_version`, and a `data`
 * block whose contents depend on the trigger. A consumer branches on
 * `data.current_state`, not on the event name — which is a genuinely
 * different integration shape and worth preserving.
 */
const TRANSFER_EVENTS = new Set([
  'transfer.processing',
  'transfer.successful',
  'transfer.failed',
  'transfer.reversed',
  'transfer.cancelled',
]);

export class WiseWebhookFormatter implements WebhookFormatter {
  readonly provider = 'wise' as const;

  /**
   * The signature covers the body alone — no timestamp, no delivery id — so
   * it is identical on every attempt and a retry can replay stored headers.
   *
   * That is true despite the signature being RSA rather than HMAC: what makes
   * a signature attempt-dependent is what it covers, not how it is computed.
   */
  readonly resignsPerAttempt = false;

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | FormattedWebhook[] | null> {
    if (event.resourceType !== 'transfer') return null;
    if (!TRANSFER_EVENTS.has(event.type)) return null;

    const transfer = await context.storage.transfers.byId(event.resourceId);
    if (!transfer || transfer.provider !== this.provider) return null;

    return {
      // Wise's trigger name, which is also the subscription's `trigger_on`.
      eventType: 'transfers#state-change',
      body: this.#stateChange(transfer, event),
    };
  }

  #stateChange(transfer: Transfer, event: PayboxEvent): Record<string, unknown> {
    const serialized = serializeTransfer(transfer);
    const profileId = (transfer.metadata.profile_id as number | undefined) ?? LOCAL_USER_ID;

    return {
      data: {
        resource: {
          type: 'transfer',
          id: numericId(transfer.id),
          profile_id: profileId,
          account_id: serialized.targetAccount,
        },
        // The field a consumer is meant to branch on. Wise sends no past-tense
        // event name, so this is the only thing that says what happened.
        current_state: serialized.status,
        previous_state: previousState(event),
        occurred_at: transfer.updatedAt,
      },
      subscription_id: (transfer.metadata.subscription_id as string | undefined) ?? null,
      event_type: 'transfers#state-change',
      // Wise versions its event payloads; 2.0.0 is the current transfer schema.
      schema_version: '2.0.0',
      sent_at: transfer.updatedAt,
    };
  }

  /**
   * Wise's RSA signature.
   *
   * `X-Signature-SHA256` is a base64 RSA-SHA256 signature over the raw body,
   * and `X-Delivery-Id` a unique delivery UUID. Both confirmed at
   * docs.wise.com/guides/developer/webhooks/event-handling.
   *
   * The `secret` argument is ignored, and that is the point: Wise holds a
   * private key rather than sharing one, so there is nothing for the
   * subscriber to keep. `signature.ts` explains why paybox's keypair is
   * published rather than generated.
   */
  sign(rawBody: string, _secret: string, context: SigningContext): Record<string, string> {
    return {
      [WISE_SIGNATURE_HEADER]: signWisePayload(rawBody),
      // Derived from the body and the attempt so a retry of the same message
      // is distinguishable from the original -- which is what Wise's own
      // "view retry events" tooling assumes.
      [WISE_DELIVERY_HEADER]: deliveryId(rawBody, context.attempt),
    };
  }
}

function previousState(event: PayboxEvent): string | null {
  const from = (event.data as { from?: unknown } | undefined)?.from;
  return typeof from === 'string' ? from : null;
}

function deliveryId(rawBody: string, attempt: number): string {
  // Reuses the UUID derivation so the value is a well-formed v4-shaped UUID
  // and stable for the same body and attempt.
  return derivedDeliveryUuid(`${rawBody}:${attempt}`);
}

function derivedDeliveryUuid(input: string): string {
  // Kept local rather than in ids.ts, which is about resource ids.
  const hex = createHash('sha256').update(input).digest('hex');
  const version = `4${hex.slice(13, 16)}`;
  const variant = `${'89ab'[parseInt(hex[16] as string, 16) % 4]}${hex.slice(17, 20)}`;
  return [hex.slice(0, 8), hex.slice(8, 12), version, variant, hex.slice(20, 32)].join('-');
}

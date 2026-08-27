import type { Metadata, PayboxEvent, ProviderId } from '@paybox/shared';
import type { Storage, WebhookDelivery } from '@paybox/core';

/** What a provider adapter produces for one canonical event. */
export interface FormattedWebhook {
  /** The provider's own event name, e.g. "charge.success". */
  eventType: string;
  /** The JSON body, pre-serialisation. */
  body: unknown;
  /** Extra provider headers beyond the signature. */
  headers?: Record<string, string>;
}

export interface FormatterContext {
  storage: Storage;
  /** Public base URL of the emulator, for any self-referential links. */
  baseUrl: string;
}

/**
 * A provider's webhook contract (spec §9, §30).
 *
 * Two responsibilities, deliberately kept together because they are the two
 * halves of one wire format: what the body looks like, and how it is signed.
 * Neither belongs anywhere near the engine.
 */
export interface WebhookFormatter {
  provider: ProviderId;
  /** Return null for canonical events this provider does not emit. */
  format(event: PayboxEvent, context: FormatterContext): Promise<FormattedWebhook | null>;
  /**
   * Signature headers for the exact bytes being sent. Takes the raw string,
   * never a re-serialised object -- providers sign bytes, and a whitespace
   * difference between what we sign and what we send is the classic bug this
   * emulator should help people find, not reproduce itself.
   */
  sign(rawBody: string, secret: string): Record<string, string>;
}

/** Outcome of one HTTP attempt. */
export interface TransportResult {
  status: number | null;
  body: string | null;
  durationMs: number;
  error: string | null;
}

export interface TransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** Swappable so tests can assert deliveries without binding a port. */
export interface DeliveryTransport {
  send(request: TransportRequest): Promise<TransportResult>;
}

/**
 * Webhook chaos (spec §10, §41).
 *
 * These force an outcome regardless of what the developer's endpoint actually
 * does, so a developer can exercise their retry handling without standing up a
 * deliberately broken server.
 */
export type ForcedOutcome =
  | 'http_500'
  | 'http_400'
  | 'http_429'
  | 'timeout'
  | 'connection_refused'
  | 'malformed_response';

export interface WebhookChaos {
  /** Force every delivery to this outcome. */
  forceOutcome?: ForcedOutcome | null;
  /** Fraction of deliveries that fail at random, 0..1. Seeded. */
  failureRate?: number;
  /** Artificial delay before the request, in virtual milliseconds. */
  latencyMs?: number;
  /** Send every webhook twice (spec §41 duplicate delivery). */
  duplicate?: boolean;
  /** Deliver a burst in reverse order (spec §41 out-of-order). */
  outOfOrder?: boolean;
}

export interface RetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  /** Delay before attempt N (0-indexed), in milliseconds. */
  backoff(attempt: number): number;
}

export interface DeliveryRecord extends WebhookDelivery {
  metadata?: Metadata;
}

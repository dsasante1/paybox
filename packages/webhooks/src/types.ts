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

/** What a signature may depend on besides the body and the secret. */
export interface SigningContext {
  /**
   * Virtual-time instant of *this delivery attempt*, in milliseconds.
   *
   * Passed in rather than read from a clock inside the formatter so signing
   * stays a pure function and cannot reach for `Date.now()`. Providers whose
   * signature covers a timestamp -- Stripe signs `${t}.${payload}` -- need it;
   * providers who sign the body alone ignore it.
   */
  timestamp: number;
  /** Which attempt this is, 0-indexed. */
  attempt: number;
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
   *
   * Called once per **attempt**, not once per delivery. Stripe generates a new
   * timestamp and signature for every retry, and replaying a stale one would
   * fail any correct verifier's tolerance window -- teaching developers to
   * work around a bug the emulator invented.
   */
  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string>;
  /**
   * True when the signature depends on more than the body, so it must be
   * recomputed per attempt rather than replayed from storage.
   *
   * Defaults to false: a body-only signature is identical on every attempt, and
   * replaying the stored headers keeps a retry byte-identical, which is what
   * makes the delivery log trustworthy.
   */
  readonly resignsPerAttempt?: boolean;
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

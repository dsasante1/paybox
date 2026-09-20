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
  /**
   * Which of a provider's wire formats this webhook is in, for a provider
   * that has more than one. Flutterwave's v3 and v4 differ in envelope *and*
   * signature scheme, and both are served under one provider id. The
   * dispatcher hands this back to `sign()` as `SigningContext.variant`, so
   * the formatter can pick the signature that matches the body it built
   * without the two halves agreeing through shared state. Omit it for a
   * provider with one format.
   */
  variant?: string;
  /**
   * Deliver only to this exact URL, for a provider that takes its callback
   * address **per request** rather than from a dashboard.
   *
   * Tingg does: `callback_url` travels on the checkout payload, so two
   * concurrent checkouts can legitimately name two different endpoints, and
   * fanning one payment's IPN out to the other's URL would be wrong. The
   * adapter registers an endpoint for the URL when it takes the request and
   * names it here; the dispatcher then narrows its fan-out to that one.
   *
   * Omit it for the normal case -- a provider whose subscribers are
   * registered once and receive everything they subscribed to.
   */
  deliverTo?: string;
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
  /**
   * The `variant` the formatter returned from `format()`, for a provider
   * with more than one wire format. Present when a fresh delivery is signed.
   * Absent when a stored delivery is re-signed per attempt
   * (`resignsPerAttempt`), which recomputes from the stored bytes alone: no
   * provider needs both today, and one that did would have to persist the
   * variant on the delivery row.
   */
  variant?: string;
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
  /**
   * Turn a canonical event into the provider's webhook(s).
   *
   * Return null for canonical events this provider does not emit. Return an
   * **array** where one canonical event is several provider events: Stripe
   * reports a settlement on both `payment_intent.succeeded` and
   * `charge.succeeded`, carrying a different object in each. Each one becomes
   * its own delivery, matched against endpoints by its own event type, so a
   * subscriber to only `charge.succeeded` receives only that.
   */
  format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | FormattedWebhook[] | null>;
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
  /**
   * Whether a 2xx actually means the subscriber accepted the webhook.
   *
   * Every provider here but one ends delivery on any 2xx, which is what the
   * dispatcher does when this is absent. Tingg does not: it reads a
   * `status_code` out of the **response body** -- 183 accepted, 180 rejected,
   * 188 acknowledged later -- and keeps retrying until it sees one, so a bare
   * `200 OK` is not an acknowledgement there.
   *
   * Consulted only after the HTTP layer already succeeded: a 500 or a timeout
   * is a retry whatever the body says, so a formatter cannot accidentally
   * mark a transport failure delivered.
   *
   * Returning 'retry' records the attempt as failed and schedules the next
   * one, exactly as an HTTP error would.
   */
  interpretResponse?(result: { status: number | null; body: string | null }):
    | 'delivered'
    | 'retry';
  /**
   * This provider's own retry ladder, overriding the dispatcher's.
   *
   * The default is one policy for the whole emulator, which is right while
   * every provider backs off exponentially. Tingg's published ladder is a
   * *fixed* 30-second interval bounded by elapsed time rather than by attempt
   * count, and averaging it into an exponential curve would produce a
   * schedule that is neither.
   *
   * The global switch still wins: turning retries off turns them off
   * everywhere, or `PAYBOX_WEBHOOK_RETRY=0` would silently exempt whichever
   * provider declared its own.
   */
  readonly retry?: RetryPolicy;
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

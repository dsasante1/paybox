import {
  PayboxError,
  type Clock,
  type IdFactory,
  type PayboxEvent,
  type ProviderId,
  type Random,
} from '@paybox/shared';
import type {
  EventBus,
  Job,
  JobResult,
  Storage,
  WebhookDelivery,
  WebhookEndpoint,
} from '@paybox/core';
import type {
  DeliveryTransport,
  ForcedOutcome,
  RetryPolicy,
  TransportResult,
  WebhookChaos,
  WebhookFormatter,
} from './types.js';
import { createRetryPolicy } from './retry.js';
import { UndiciTransport } from './transport.js';

export const WEBHOOK_DELIVERY_JOB = 'webhook.deliver';

export interface DispatcherOptions {
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  random: Random;
  baseUrl: string;
  transport?: DeliveryTransport;
  retry?: RetryPolicy;
  timeoutMs?: number;
  logger?: { debug(m: string, x?: unknown): void; warn(m: string, x?: unknown): void };
}

/**
 * The webhook engine (spec §9, §10, §41).
 *
 * Subscribes to the event bus, converts each canonical event into whatever the
 * provider's wire format is, persists one delivery row per matching endpoint,
 * and enqueues a job to actually send it. Nothing is sent inline: every send
 * is a scheduled job, so retries land on virtual time and `paybox time advance`
 * fires them instantly.
 */
export class WebhookDispatcher {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #random: Random;
  readonly #baseUrl: string;
  readonly #transport: DeliveryTransport;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #logger: NonNullable<DispatcherOptions['logger']>;
  readonly #formatters = new Map<ProviderId, WebhookFormatter>();
  #chaos: WebhookChaos = {};

  constructor(options: DispatcherOptions) {
    this.#storage = options.storage;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#random = options.random.fork('webhooks');
    this.#baseUrl = options.baseUrl;
    this.#transport = options.transport ?? new UndiciTransport();
    this.#retry =
      options.retry ?? createRetryPolicy({ jitter: () => this.#random.next() });
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#logger = options.logger ?? { debug: () => {}, warn: () => {} };
  }

  register(formatter: WebhookFormatter): void {
    this.#formatters.set(formatter.provider, formatter);
  }

  attachTo(bus: EventBus): void {
    bus.onAny(async (event) => {
      await this.onEvent(event);
    });
  }

  setChaos(chaos: WebhookChaos): WebhookChaos {
    this.#chaos = { ...this.#chaos, ...chaos };
    return this.#chaos;
  }

  getChaos(): WebhookChaos {
    return { ...this.#chaos };
  }

  /* ---------------------------------------------------------------- *
   * Fan-out
   * ---------------------------------------------------------------- */

  async onEvent(event: PayboxEvent): Promise<WebhookDelivery[]> {
    const formatter = this.#formatters.get(event.provider);
    if (!formatter) return [];

    const formatted = await formatter.format(event, {
      storage: this.#storage,
      baseUrl: this.#baseUrl,
    });
    // A null here is normal: not every canonical event maps to a provider
    // webhook. Paystack has no "payment.processing" webhook, for instance.
    if (!formatted) return [];

    const endpoints = await this.#storage.webhooks.endpointsFor(
      event.provider,
      formatted.eventType,
    );
    if (endpoints.length === 0) {
      this.#logger.debug('No webhook endpoint matched', {
        provider: event.provider,
        eventType: formatted.eventType,
      });
      return [];
    }

    // Serialise once. Everything downstream -- the signature, the stored
    // payload, the bytes on the wire, a later replay -- uses this exact string.
    const rawBody = JSON.stringify(formatted.body);

    const created: WebhookDelivery[] = [];
    for (const endpoint of endpoints) {
      const copies = this.#chaos.duplicate ? 2 : 1;
      for (let copy = 0; copy < copies; copy++) {
        created.push(
          await this.#createAndSchedule(endpoint, event, formatted.eventType, rawBody, {
            ...(formatted.headers ?? {}),
            ...formatter.sign(rawBody, endpoint.secret, {
              timestamp: this.#clock.now(),
              attempt: 0,
            }),
          }),
        );
      }
    }
    return created;
  }

  async #createAndSchedule(
    endpoint: WebhookEndpoint,
    event: PayboxEvent,
    eventType: string,
    rawBody: string,
    headers: Record<string, string>,
    replayOf: string | null = null,
  ): Promise<WebhookDelivery> {
    const now = this.#clock.nowISO();
    const delivery: WebhookDelivery = {
      id: this.#ids.next('whd'),
      endpointId: endpoint.id,
      eventId: event.id,
      provider: endpoint.provider,
      eventType,
      url: endpoint.url,
      payload: rawBody,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'paybox-emulator/0.1',
        ...headers,
      },
      status: 'pending',
      attempt: 0,
      maxAttempts: this.#retry.enabled ? this.#retry.maxAttempts : 1,
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      durationMs: null,
      nextRetryAt: null,
      replayOfDeliveryId: replayOf,
      createdAt: now,
      updatedAt: now,
    };
    await this.#storage.webhooks.createDelivery(delivery);
    await this.#enqueue(delivery.id, this.#initialDelayMs());
    return delivery;
  }

  /**
   * Delay before the first attempt.
   *
   * Ordinarily just the configured latency. With `outOfOrder` on, each delivery
   * gets an independent random delay inside a window, which is what actually
   * reproduces the symptom developers need to handle: webhooks for a single
   * payment arriving in a different order than the events that produced them.
   */
  #initialDelayMs(): number {
    const base = this.#chaos.latencyMs ?? 0;
    if (!this.#chaos.outOfOrder) return base;
    return base + this.#random.int(0, 5_000);
  }

  async #enqueue(deliveryId: string, delayMs: number): Promise<Job> {
    const now = this.#clock.now();
    return this.#storage.jobs.enqueue({
      id: this.#ids.next('job'),
      kind: WEBHOOK_DELIVERY_JOB,
      payload: { deliveryId },
      status: 'ready',
      runAt: new Date(now + Math.max(0, delayMs)).toISOString(),
      attempt: 0,
      // The dispatcher owns the retry loop, not the scheduler: it needs to
      // record the attempt on the delivery row so the dashboard can show it.
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `webhook:${deliveryId}`,
      createdAt: this.#clock.nowISO(),
      updatedAt: this.#clock.nowISO(),
    });
  }

  /* ---------------------------------------------------------------- *
   * Delivery
   * ---------------------------------------------------------------- */

  /** Scheduler handler for `webhook.deliver`. */
  handleJob = async (job: Job): Promise<JobResult> => {
    const deliveryId = String(job.payload.deliveryId ?? '');
    if (!deliveryId) return;
    await this.deliver(deliveryId);
  };

  async deliver(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.#storage.webhooks.deliveryById(deliveryId);
    if (!delivery) throw new PayboxError('not_found', `No webhook delivery ${deliveryId}.`);
    if (delivery.status === 'succeeded' || delivery.status === 'exhausted') return delivery;

    await this.#storage.webhooks.updateDelivery(deliveryId, {
      status: 'delivering',
      updatedAt: this.#clock.nowISO(),
    });

    const result = await this.#attempt(delivery);
    const attempt = delivery.attempt + 1;
    const ok = result.status !== null && result.status >= 200 && result.status < 300;

    if (ok) {
      return this.#storage.webhooks.updateDelivery(deliveryId, {
        status: 'succeeded',
        attempt,
        responseStatus: result.status,
        responseBody: result.body,
        errorMessage: null,
        durationMs: result.durationMs,
        nextRetryAt: null,
        updatedAt: this.#clock.nowISO(),
      });
    }

    const canRetry = this.#retry.enabled && attempt < delivery.maxAttempts;
    if (!canRetry) {
      return this.#storage.webhooks.updateDelivery(deliveryId, {
        status: 'exhausted',
        attempt,
        responseStatus: result.status,
        responseBody: result.body,
        errorMessage: result.error ?? `Endpoint responded ${result.status}.`,
        durationMs: result.durationMs,
        nextRetryAt: null,
        updatedAt: this.#clock.nowISO(),
      });
    }

    const delayMs = this.#retry.backoff(attempt - 1);
    const nextRetryAt = new Date(this.#clock.now() + delayMs).toISOString();
    const updated = await this.#storage.webhooks.updateDelivery(deliveryId, {
      status: 'pending',
      attempt,
      responseStatus: result.status,
      responseBody: result.body,
      errorMessage: result.error ?? `Endpoint responded ${result.status}.`,
      durationMs: result.durationMs,
      nextRetryAt,
      updatedAt: this.#clock.nowISO(),
    });
    await this.#enqueue(deliveryId, delayMs);
    return updated;
  }

  async #attempt(delivery: WebhookDelivery): Promise<TransportResult> {
    const forced = this.#pickForcedOutcome();
    if (forced) return simulateOutcome(forced);

    return this.#transport.send({
      url: delivery.url,
      body: delivery.payload,
      headers: await this.#headersFor(delivery),
      timeoutMs: this.#timeoutMs,
    });
  }

  /**
   * The headers for one attempt.
   *
   * Stored headers are replayed as-is by default, which is what keeps a retry
   * byte-identical and the delivery log trustworthy. A formatter whose
   * signature covers a timestamp has to re-sign instead: Stripe generates a
   * fresh signature per attempt, and replaying a stale one would fail the
   * receiver's tolerance window -- a failure the emulator would have invented.
   *
   * Only the signature headers are recomputed; the payload and everything else
   * are untouched, so what the developer's app receives still matches what the
   * dashboard shows it was sent.
   */
  async #headersFor(delivery: WebhookDelivery): Promise<Record<string, string>> {
    const formatter = this.#formatters.get(delivery.provider);
    if (!formatter?.resignsPerAttempt) return delivery.headers;

    const endpoint = await this.#storage.webhooks.endpointById(delivery.endpointId);
    // The endpoint can be deleted mid-flight; the stored headers are then the
    // best we have, and failing the attempt outright would be worse.
    if (!endpoint) return delivery.headers;

    return {
      ...delivery.headers,
      ...formatter.sign(delivery.payload, endpoint.secret, {
        timestamp: this.#clock.now(),
        attempt: delivery.attempt,
      }),
    };
  }

  #pickForcedOutcome(): ForcedOutcome | null {
    if (this.#chaos.forceOutcome) return this.#chaos.forceOutcome;
    const rate = this.#chaos.failureRate ?? 0;
    if (rate > 0 && this.#random.chance(rate)) return 'http_500';
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Manual control (spec §10)
   * ---------------------------------------------------------------- */

  /** Re-run an existing delivery in place: same row, one more attempt. */
  async retryNow(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.#storage.webhooks.deliveryById(deliveryId);
    if (!delivery) throw new PayboxError('not_found', `No webhook delivery ${deliveryId}.`);
    // A manual retry re-opens an exhausted delivery and grants one more
    // attempt, which is what a developer means by "try that again".
    await this.#storage.webhooks.updateDelivery(deliveryId, {
      status: 'pending',
      maxAttempts: Math.max(delivery.maxAttempts, delivery.attempt + 1),
      nextRetryAt: this.#clock.nowISO(),
      updatedAt: this.#clock.nowISO(),
    });
    return this.deliver(deliveryId);
  }

  /**
   * Replay: a brand-new delivery carrying the identical signed payload.
   *
   * Distinct from retry because the developer's app should see it as a fresh
   * POST -- same body, new delivery row -- which is exactly what a provider's
   * "resend event" button does, and the thing that exposes missing idempotency
   * handling on their side.
   *
   * The signature is reused too, unless the provider's covers a timestamp, in
   * which case it is regenerated at send time like any other attempt.
   */
  async replay(deliveryId: string): Promise<WebhookDelivery> {
    const original = await this.#storage.webhooks.deliveryById(deliveryId);
    if (!original) throw new PayboxError('not_found', `No webhook delivery ${deliveryId}.`);
    const endpoint = await this.#storage.webhooks.endpointById(original.endpointId);
    if (!endpoint) {
      throw new PayboxError(
        'not_found',
        `Webhook endpoint ${original.endpointId} no longer exists.`,
      );
    }

    const now = this.#clock.nowISO();
    const replayDelivery: WebhookDelivery = {
      ...original,
      id: this.#ids.next('whd'),
      status: 'pending',
      attempt: 0,
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      durationMs: null,
      nextRetryAt: null,
      replayOfDeliveryId: original.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.#storage.webhooks.createDelivery(replayDelivery);
    await this.#enqueue(replayDelivery.id, this.#chaos.latencyMs ?? 0);
    return replayDelivery;
  }

  /** Send the event again from scratch, re-formatting and re-signing it. */
  async replayEvent(eventId: string): Promise<WebhookDelivery[]> {
    const event = await this.#storage.events.byId(eventId);
    if (!event) throw new PayboxError('not_found', `No event ${eventId}.`);
    return this.onEvent(event);
  }
}

function simulateOutcome(outcome: ForcedOutcome): TransportResult {
  switch (outcome) {
    case 'http_500':
      return { status: 500, body: 'Internal Server Error', durationMs: 5, error: null };
    case 'http_400':
      return { status: 400, body: 'Bad Request', durationMs: 5, error: null };
    case 'http_429':
      return { status: 429, body: 'Too Many Requests', durationMs: 5, error: null };
    case 'timeout':
      return { status: null, body: null, durationMs: 10_000, error: 'Request timed out.' };
    case 'connection_refused':
      return { status: null, body: null, durationMs: 1, error: 'Connection refused.' };
    case 'malformed_response':
      return { status: 200, body: '<<not json>>', durationMs: 5, error: null };
  }
}

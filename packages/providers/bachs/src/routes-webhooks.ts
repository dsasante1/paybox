import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WebhookEndpoint } from '@paybox/core';
import { fail } from './errors.js';
import { newestFirst, notFound, readPage } from './http.js';
import { hexId, signingSecret } from './ids.js';
import { owns, ownerField, type Actor } from './actor.js';
import type { RouteContext } from './route-context.js';
import {
  CONNECT_ONLY_PREFIX,
  pagination,
  publicEventTypes,
  serializeEndpoint,
} from './serializers.js';
import type { StoredEndpoint } from './state.js';
import {
  attemptId,
  listAttempts,
  readEvent,
  type StoredAttempt,
  type StoredBachsEvent,
} from './webhook.js';

const PROVIDER = 'bachs' as const;

/**
 * The subscribable event types: `CreateWebhookEndpointRequest.event_types`,
 * exactly as enumerated (23 values). Four documented events are absent from
 * it -- `payment_method.saved`, `account.updated`, `capability.updated`,
 * `transfer.created` -- and so cannot be subscribed to through the API, which
 * docs/bachs.md records.
 */
export const BACHS_EVENT_TYPES = [
  'collection.succeeded',
  'collection.failed',
  'collection.underpaid',
  'checkout.completed',
  'checkout.expired',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'refund.created',
  'refund.paid',
  'refund.failed',
  'conversion.completed',
  'conversion.failed',
  'customer.created',
  'customer.updated',
  'dispute.created',
  'dispute.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  // Connect's events. Not in the spec's `event_types` enum, but the guides
  // subscribe endpoints to them, and without them a Connect webhook could
  // not be received at all (docs/bachs.md).
  'account.updated',
  'capability.updated',
  'transfer.created',
] as const;

/** Rotation keeps the old secret signing for this long (guides/webhooks/overview). */
const ROTATION_OVERLAP_MS = 24 * 3_600_000;

const eventTypes = z
  .array(z.string())
  .min(1, 'Send at least one event type; an empty list is rejected.')
  .transform((values) => values.map((value) => value.toLowerCase()))
  .refine(
    (values) => values.every((value) => (BACHS_EVENT_TYPES as readonly string[]).includes(value)),
    { message: `Each event type must be one of: ${BACHS_EVENT_TYPES.join(', ')}.` },
  );

const url = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  },
  { message: 'Must be an absolute http or https URL.' },
);

const createSchema = z.object({
  name: z.string(),
  url,
  event_types: eventTypes,
  event_source: z.enum(['account', 'connect', 'all']).optional(),
});

const updateSchema = z.object({
  name: z.string().nullable().optional(),
  url: url.nullable().optional(),
  event_types: eventTypes.nullable().optional(),
  event_source: z.enum(['account', 'connect', 'all']).optional(),
  enabled: z.boolean().nullable().optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
});

const metricsQuery = z.object({
  period: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

const replaySchema = z
  .object({
    event_id: z.string().optional(),
    charge_id: z.string().optional(),
    reference: z.string().optional(),
  })
  .optional();

export function registerWebhookRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { storage, state, clock, ids, dispatcher } = ctx;

  // Before Connect, a `connect` endpoint's types were stored under a prefix
  // no event matched, so it received nothing. Its routing is the formatter's
  // now (`event_source`), so the types are stored as given; an endpoint saved
  // the old way is put right once, here.
  fastify.addHook('onReady', async () => {
    for (const endpoint of await storage.webhooks.listEndpoints()) {
      if (endpoint.provider !== PROVIDER || !endpoint.eventTypes.some((type) => type.startsWith(CONNECT_ONLY_PREFIX))) continue;
      await storage.webhooks.updateEndpoint(endpoint.id, { eventTypes: publicEventTypes(endpoint.eventTypes) });
    }
  });

  /** An endpoint the actor owns: a connected account keeps its own (`event_source: account`). */
  async function loadEndpoint(
    actor: Actor,
    id: string,
  ): Promise<{ endpoint: WebhookEndpoint; stored: StoredEndpoint | null }> {
    const endpoint = await storage.webhooks.endpointById(id);
    const stored = endpoint ? await state.endpoints.get(id) : null;
    if (!endpoint || endpoint.provider !== PROVIDER || !owns(actor, stored?.account)) throw notFound('Webhook endpoint');
    return { endpoint, stored };
  }

  /** "newest first", by creation order. */
  async function allEndpoints(actor: Actor): Promise<WebhookEndpoint[]> {
    const mine = [];
    for (const row of await storage.webhooks.listEndpoints()) {
      if (row.provider === PROVIDER && owns(actor, (await state.endpoints.get(row.id))?.account)) mine.push(row);
    }
    const rows = mine;
    const keyed = await Promise.all(
      rows.map(async (endpoint) => ({ endpoint, seq: (await state.endpoints.get(endpoint.id))?.seq })),
    );
    return keyed
      .sort((a, b) =>
        newestFirst({ seq: a.seq, createdAt: a.endpoint.createdAt }, { seq: b.seq, createdAt: b.endpoint.createdAt }),
      )
      .map((row) => row.endpoint);
  }

  /* -------------------------------- endpoints -------------------------------- */

  fastify.post('/v1/webhooks/endpoints', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createSchema.parse(request.body);
    const now = clock.nowISO();
    const source = body.event_source ?? 'account';
    const endpoint = await storage.webhooks.createEndpoint({
      id: hexId(ids, 'whe'),
      provider: PROVIDER,
      url: body.url,
      secret: signingSecret(ids),
      enabled: true,
      eventTypes: body.event_types,
      description: body.name,
      previousSecrets: [],
      createdAt: now,
      updatedAt: now,
    });
    const stored: StoredEndpoint = {
      ...ownerField(actor),
      id: endpoint.id,
      seq: await state.nextSeq(),
      name: body.name,
      eventSource: source,
      disabledAt: null,
      disabledReason: null,
    };
    await state.endpoints.put(stored);
    // "The signing secret is returned once in the response."
    return reply.status(201).send({ ...serializeEndpoint(endpoint, stored), signing_secret: endpoint.secret });
  });

  fastify.get('/v1/webhooks/endpoints', async (request, reply) => {
    const actor = await ctx.actor(request);
    const { limit, offset } = readPage(listQuery.parse(request.query), 50);
    const rows = await allEndpoints(actor);
    const page = rows.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async (endpoint) => serializeEndpoint(endpoint, await state.endpoints.get(endpoint.id))),
    );
    return reply.send({ items, pagination: pagination(rows.length, limit, offset, items.length) });
  });

  fastify.get<{ Params: { endpoint_id: string } }>('/v1/webhooks/endpoints/:endpoint_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const { endpoint, stored } = await loadEndpoint(actor, request.params.endpoint_id);
    return reply.send(serializeEndpoint(endpoint, stored));
  });

  fastify.patch<{ Params: { endpoint_id: string } }>('/v1/webhooks/endpoints/:endpoint_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = updateSchema.parse(request.body ?? {});
    const { endpoint, stored } = await loadEndpoint(actor, request.params.endpoint_id);
    // One registered with paybox's control API has received everything, its
    // accounts' events included: `all`, so a rename does not change that.
    const current: StoredEndpoint = stored ?? {
      id: endpoint.id,
      name: endpoint.description,
      eventSource: 'all',
      disabledAt: null,
      disabledReason: null,
    };
    const source = body.event_source ?? current.eventSource;
    const types = body.event_types ?? publicEventTypes(endpoint.eventTypes);
    const next: StoredEndpoint = {
      ...current,
      ...(body.name !== undefined && body.name !== null ? { name: body.name } : {}),
      eventSource: source,
    };
    // Turning an endpoint back on "clears its failure history, disabled_at and
    // disabled_reason". Turning it off yourself leaves both null, "so you can
    // tell your choice from ours".
    if (body.enabled === true) {
      next.disabledAt = null;
      next.disabledReason = null;
      await storage.providerState.delete(PROVIDER, `endpoint-health:${endpoint.id}`);
    }
    const updated = await storage.webhooks.updateEndpoint(endpoint.id, {
      ...(body.url ? { url: body.url } : {}),
      ...(body.name ? { description: body.name } : {}),
      ...(body.enabled !== undefined && body.enabled !== null ? { enabled: body.enabled } : {}),
      eventTypes: types,
      updatedAt: clock.nowISO(),
    });
    await state.endpoints.put(next);
    return reply.send(serializeEndpoint(updated, next));
  });

  fastify.delete<{ Params: { endpoint_id: string } }>('/v1/webhooks/endpoints/:endpoint_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const { endpoint } = await loadEndpoint(actor, request.params.endpoint_id);
    await storage.webhooks.deleteEndpoint(endpoint.id);
    await state.endpoints.delete(endpoint.id);
    return reply.send({ status: 'deleted', endpoint_id: endpoint.id });
  });

  fastify.get<{ Params: { endpoint_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/secret',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint, stored } = await loadEndpoint(actor, request.params.endpoint_id);
      return reply.send({ ...serializeEndpoint(endpoint, stored), secret: endpoint.secret });
    },
  );

  /**
   * Rotate the signing secret.
   *
   * The guide: "Rotating adds a new secret and keeps the previous one valid
   * for 24 hours. During that window every delivery is signed with both." The
   * operation's own description says the old secret "stops working
   * immediately". The overlap is what the guide builds its whole rotation
   * procedure on and what `X-Bachs-Signature-V2` exists to carry, so it is
   * what paybox does; docs/bachs.md records the contradiction. As in Bachs'
   * example, the response does not include the new secret -- read it back
   * from `/secret`.
   */
  fastify.post<{ Params: { endpoint_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/rotate-secret',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint, stored } = await loadEndpoint(actor, request.params.endpoint_id);
      const now = clock.now();
      const stillValid = (endpoint.previousSecrets ?? []).filter((entry) => Date.parse(entry.expiresAt) > now);
      const updated = await storage.webhooks.updateEndpoint(endpoint.id, {
        secret: signingSecret(ids),
        previousSecrets: [
          { secret: endpoint.secret, expiresAt: new Date(now + ROTATION_OVERLAP_MS).toISOString() },
          ...stillValid,
        ],
        updatedAt: clock.nowISO(),
      });
      const { disabled_at: _disabledAt, disabled_reason: _disabledReason, ...rest } = serializeEndpoint(updated, stored);
      return reply.send(rest);
    },
  );

  /* --------------------------------- metrics --------------------------------- */

  /**
   * Delivery counts per bucket. "Buckets with no attempts are still returned
   * with zero counts", ascending; the default is a day series over the last
   * 30 days; "an unrecognised value falls back to `day`".
   */
  fastify.get<{ Params: { endpoint_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/metrics',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint } = await loadEndpoint(actor, request.params.endpoint_id);
      const query = metricsQuery.parse(request.query);
      const period = query.period === 'week' || query.period === 'month' ? query.period : 'day';
      const to = query.date_to ? Date.parse(query.date_to) : clock.now();
      const from = query.date_from ? Date.parse(query.date_from) : to - 29 * 86_400_000;
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'date_from and date_to must be ISO 8601 timestamps.');
      }

      const buckets = new Map<string, { success: number; failed: number }>();
      let cursor = bucketStart(from, period);
      while (cursor <= to) {
        buckets.set(isoDate(cursor), { success: 0, failed: 0 });
        cursor = nextBucket(cursor, period);
      }
      let total = 0;
      for (const attempt of await attempts()) {
        if (attempt.endpointId !== endpoint.id || attempt.status === 'pending') continue;
        const at = Date.parse(attempt.updatedAt);
        if (at < from || at > to) continue;
        const bucket = buckets.get(isoDate(bucketStart(at, period)));
        if (!bucket) continue;
        if (attempt.status === 'succeeded') bucket.success += 1;
        else bucket.failed += 1;
        total += 1;
      }
      return reply.send({
        total: String(total),
        period,
        data: [...buckets.entries()].map(([date, counts]) => ({ date, ...counts })),
      });
    },
  );

  /* ---------------------------------- events ---------------------------------- */

  /**
   * The attempt log, with each attempt still marked `pending` checked against
   * its delivery. A resend writes its attempt before the job runs; if the
   * endpoint is disabled or deleted in between, the delivery ends without a
   * request ever being made and nothing reports back, so the record would
   * read `pending` forever.
   */
  async function attempts(): Promise<StoredAttempt[]> {
    const rows = await listAttempts(storage);
    return Promise.all(
      rows.map(async (attempt) => {
        if (attempt.status !== 'pending') return attempt;
        const delivery = await storage.webhooks.deliveryById(attempt.deliveryId);
        if (delivery && (delivery.status === 'pending' || delivery.status === 'delivering')) return attempt;
        if (delivery?.status === 'succeeded') {
          return {
            ...attempt,
            status: 'succeeded' as const,
            httpStatus: delivery.responseStatus,
            responseSnippet: delivery.responseBody?.slice(0, 500) ?? null,
            updatedAt: delivery.updatedAt,
          };
        }
        return {
          ...attempt,
          status: 'failed' as const,
          httpStatus: delivery?.responseStatus ?? null,
          lastError: delivery?.errorMessage ?? 'The endpoint was deleted before this attempt was made.',
          updatedAt: delivery?.updatedAt ?? attempt.updatedAt,
        };
      }),
    );
  }

  /**
   * The events the actor may read: an account's own, and for the platform its
   * own and its accounts' -- the list item's `account` says whose
   * ("your own account for your own activity").
   */
  async function visible(actor: Actor, event: StoredBachsEvent): Promise<boolean> {
    if (owns(actor, event.origin)) return true;
    if (actor.account || !event.origin) return false;
    return (await state.accounts.get(event.origin))?.parent === ctx.organizationId;
  }

  async function allEvents(actor: Actor): Promise<StoredBachsEvent[]> {
    const rows = await storage.providerState.listByPrefix(PROVIDER, 'event:');
    const events: StoredBachsEvent[] = [];
    for (const row of rows) {
      const event = JSON.parse(row.value) as StoredBachsEvent;
      if (await visible(actor, event)) events.push(event);
    }
    return events.sort((a, b) => b.seq - a.seq);
  }

  function summarise(attempts: StoredAttempt[]) {
    const settled = attempts.filter((attempt) => attempt.status !== 'pending');
    const last = [...attempts].sort((a, b) =>
      a.updatedAt === b.updatedAt ? b.attemptNo - a.attemptNo : b.updatedAt.localeCompare(a.updatedAt),
    )[0];
    return {
      attempts: attempts.length,
      success: settled.filter((attempt) => attempt.status === 'succeeded').length,
      failed: settled.filter((attempt) => attempt.status === 'failed').length,
      last_attempt_status: last?.status ?? null,
      last_attempt_http_status: last?.httpStatus ?? null,
      last_attempt_error: last?.lastError ?? null,
      last_attempt_at: last?.updatedAt ?? null,
    };
  }

  function serializeAttempt(attempt: StoredAttempt) {
    return {
      attempt_id: attempt.id,
      attempt_no: attempt.attemptNo,
      status: attempt.status,
      callback_url: attempt.callbackUrl,
      http_status: attempt.httpStatus,
      response_snippet: attempt.responseSnippet,
      last_error: attempt.lastError,
      created_at: attempt.createdAt,
      updated_at: attempt.updatedAt,
    };
  }

  function detail(event: StoredBachsEvent, attempts: StoredAttempt[]) {
    return {
      event_id: event.id,
      event_type: event.type,
      entity_type: event.entityType,
      entity_id: event.entityId,
      created_at: event.createdAt,
      payload: event.payload,
      // "newest attempt number first"
      attempts: [...attempts].sort((a, b) => b.attemptNo - a.attemptNo).map(serializeAttempt),
    };
  }

  /**
   * An event the actor may read: its own, or -- through one of its endpoints
   * -- one that endpoint was sent (a platform's `connect` endpoint receives
   * its accounts' events).
   */
  async function loadEvent(actor: Actor, id: string, endpointId?: string): Promise<StoredBachsEvent> {
    const event = await readEvent(storage, id);
    const delivered =
      endpointId !== undefined &&
      (await attempts()).some((attempt) => attempt.eventId === id && attempt.endpointId === endpointId);
    if (!event || (!(await visible(actor, event)) && !delivered)) throw notFound('Webhook event');
    return event;
  }

  fastify.get('/v1/webhooks/events', async (request, reply) => {
    const actor = await ctx.actor(request);
    const { limit, offset } = readPage(listQuery.parse(request.query), 50);
    const events = await allEvents(actor);
    const log = await attempts();
    const page = events.slice(offset, offset + limit);
    return reply.send({
      items: page.map((event) => ({
        event_id: event.id,
        event_type: event.type,
        entity_type: event.entityType,
        entity_id: event.entityId,
        created_at: event.createdAt,
        account: event.origin ?? ctx.organizationId,
        ...summarise(log.filter((attempt) => attempt.eventId === event.id)),
      })),
      total: events.length,
      limit,
      offset,
    });
  });

  fastify.get<{ Params: { event_id: string } }>('/v1/webhooks/events/:event_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const event = await loadEvent(actor, request.params.event_id);
    const log = (await attempts()).filter((attempt) => attempt.eventId === event.id);
    return reply.send(detail(event, log));
  });

  fastify.get<{ Params: { endpoint_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/events',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint } = await loadEndpoint(actor, request.params.endpoint_id);
      const { limit, offset } = readPage(listQuery.parse(request.query), 50);
      const log = (await attempts()).filter((attempt) => attempt.endpointId === endpoint.id);
      const byEvent = new Map<string, StoredAttempt[]>();
      for (const attempt of log) {
        byEvent.set(attempt.eventId, [...(byEvent.get(attempt.eventId) ?? []), attempt]);
      }
      const rows: Array<{ event: StoredBachsEvent; summary: ReturnType<typeof summarise> }> = [];
      for (const [eventId, group] of byEvent) {
        const event = await readEvent(storage, eventId);
        if (event) rows.push({ event, summary: summarise(group) });
      }
      // "newest attempt first"
      rows.sort((a, b) => (b.summary.last_attempt_at ?? '').localeCompare(a.summary.last_attempt_at ?? '') || b.event.seq - a.event.seq);
      const page = rows.slice(offset, offset + limit);
      return reply.send({
        items: page.map(({ event, summary }) => ({
          event_id: event.id,
          event_type: event.type,
          entity_id: event.entityId,
          ...summary,
        })),
        total: rows.length,
        limit,
        offset,
      });
    },
  );

  fastify.get<{ Params: { endpoint_id: string; event_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/events/:event_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint } = await loadEndpoint(actor, request.params.endpoint_id);
      const event = await loadEvent(actor, request.params.event_id, endpoint.id);
      const log = (await attempts()).filter(
        (attempt) => attempt.eventId === event.id && attempt.endpointId === endpoint.id,
      );
      return reply.send(detail(event, log));
    },
  );

  /**
   * Send one stored event again, to the endpoints named, as a single try:
   * "A resend or a replay is a single try. We do not retry it." The body is
   * the stored one, so the event keeps its id.
   */
  async function resend(event: StoredBachsEvent, endpointIds?: string[]): Promise<StoredAttempt[]> {
    const deliveries = await dispatcher.replayEvent(event.canonicalEventId, {
      maxAttempts: 1,
      eventTypes: [event.type],
      ...(endpointIds ? { endpointIds } : {}),
    });
    const existing = await listAttempts(storage);
    const created: StoredAttempt[] = [];
    for (const delivery of deliveries) {
      const id = attemptId(delivery.id, 1);
      const prior = existing.find((attempt) => attempt.id === id);
      if (prior) {
        created.push(prior);
        continue;
      }
      const record: StoredAttempt = {
        id,
        eventId: event.id,
        endpointId: delivery.endpointId,
        deliveryId: delivery.id,
        attemptNo:
          existing.filter((attempt) => attempt.eventId === event.id && attempt.endpointId === delivery.endpointId)
            .length + 1,
        status: 'pending',
        callbackUrl: delivery.url,
        httpStatus: null,
        responseSnippet: null,
        lastError: null,
        createdAt: clock.nowISO(),
        updatedAt: clock.nowISO(),
      };
      // The attempt may have run while this was being assembled; never
      // replace a finished record with a pending one.
      if (await storage.providerState.get(PROVIDER, `attempt:${id}`)) {
        created.push(record);
        continue;
      }
      await storage.providerState.put(PROVIDER, `attempt:${id}`, JSON.stringify(record), clock.nowISO());
      existing.push(record);
      created.push(record);
    }
    return created;
  }

  fastify.post<{ Params: { endpoint_id: string; event_id: string } }>(
    '/v1/webhooks/endpoints/:endpoint_id/events/:event_id/resend',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const { endpoint } = await loadEndpoint(actor, request.params.endpoint_id);
      const event = await loadEvent(actor, request.params.event_id, endpoint.id);
      const [attempt] = await resend(event, [endpoint.id]);
      if (!attempt) {
        throw fail(
          'not_found',
          'NOT_FOUND',
          'This endpoint is disabled or not subscribed to this event type, so nothing was queued.',
        );
      }
      return reply.send({ status: 'queued', attempt_id: attempt.id });
    },
  );

  /**
   * `POST /v1/webhooks/replay`: by `event_id`, else the latest event for a
   * `charge_id`, else for a checkout `reference`, in that order.
   */
  fastify.post('/v1/webhooks/replay', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = replaySchema.parse(request.body) ?? {};
    if (!body.event_id && !body.charge_id && !body.reference) {
      throw fail(
        'invalid_request',
        'BAD_REQUEST',
        'Provide at least one of event_id, charge_id, or reference.',
      );
    }
    let event: StoredBachsEvent | null = null;
    if (body.event_id) {
      event = await readEvent(storage, body.event_id);
      if (event && !(await visible(actor, event))) event = null;
    } else {
      const events = await allEvents(actor);
      // "Checkout reference used to resolve charge and replay latest webhook
      // event": the reference names a checkout, never a refund.
      let chargeId = body.charge_id ?? null;
      let checkoutId: string | null = null;
      if (!chargeId && body.reference) {
        const checkout = await state.checkouts.byReference(body.reference, actor.account?.id ?? null);
        checkoutId = checkout?.id ?? null;
        const payment = checkout?.paymentId ? await storage.payments.byId(checkout.paymentId) : null;
        chargeId = payment?.providerTransactionId ?? null;
      }
      event =
        (chargeId ? events.find((entry) => chargeOf(entry) === chargeId) : undefined) ??
        (checkoutId ? events.find((entry) => entry.entityType === 'checkout' && entry.entityId === checkoutId) : undefined) ??
        null;
    }
    if (!event) {
      throw fail('not_found', 'NOT_FOUND', 'No matching webhook event could be resolved for your lookup values.');
    }
    const [attempt] = await resend(event);
    if (!attempt) {
      throw fail('not_found', 'NOT_FOUND', 'No enabled endpoint is subscribed to this event type.');
    }
    return reply.send({
      event_id: event.id,
      attempt_id: attempt.id,
      attempt_no: attempt.attemptNo,
      event_type: event.type,
    });
  });
}

function data(event: StoredBachsEvent): Record<string, unknown> {
  return (event.payload.data ?? {}) as Record<string, unknown>;
}

function chargeOf(event: StoredBachsEvent): string | null {
  const d = data(event);
  if (typeof d.charge_id === 'string') return d.charge_id;
  const charge = d.charge as Record<string, unknown> | null | undefined;
  return charge && typeof charge.id === 'string' ? charge.id : null;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bucketStart(ms: number, period: 'day' | 'week' | 'month'): number {
  const date = new Date(ms);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === 'day') return day;
  if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  // Weeks start on Monday.
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * 86_400_000;
}

function nextBucket(ms: number, period: 'day' | 'week' | 'month'): number {
  if (period === 'day') return ms + 86_400_000;
  if (period === 'week') return ms + 7 * 86_400_000;
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PayboxError, type Clock } from '@paybox/shared';
import { bachsErrorBody, fail } from './errors.js';
import type { BachsState } from './state.js';

/**
 * Cross-cutting HTTP behaviour every Bachs endpoint follows
 * (docs.bachs.io/api-reference/api-standards, read 2026-10-10).
 */

/* ------------------------------- idempotency ------------------------------- */

/**
 * `Idempotency-Key` as Bachs implements it (guides/idempotency):
 *
 *   applies to   public POST and PATCH under /v1/ -- not GET, not DELETE
 *   caches       successful (2xx) JSON responses only, for 24 hours from when
 *                the response was stored; "cache hits do not refresh it"
 *   scope        per API key (and acting account)
 *   fingerprint  method + path + body; a different body under the same key is
 *                `409 IDEMPOTENCY_CONFLICT`
 *   in flight    a retry while the original is still running is
 *                `409 IDEMPOTENCY_IN_PROGRESS`
 *
 * Kept in the adapter rather than paybox's shared idempotency plugin because
 * three of those differ from it -- methods covered, the 24-hour window, and
 * the in-flight state -- and the shared one serves eight other providers.
 * The window runs on virtual time, so `paybox time advance 25h` expires a key.
 */
const WINDOW_MS = 24 * 3_600_000;

interface IdempotentRequest {
  bachsIdempotency?: { scope: string; fingerprint: string };
}

export function registerIdempotency(
  fastify: FastifyInstance,
  options: { state: BachsState; clock: Clock },
): void {
  const inFlight = new Set<string>();

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' && request.method !== 'PATCH') return;
    if (!request.url.includes('/v1/')) return;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) return;

    const apiKey = String(request.headers.authorization ?? '');
    const account = String(request.headers['x-account-id'] ?? '');
    const scope = createHash('sha256').update(`${apiKey}\n${account}\n${key}`).digest('hex');
    const fingerprint = createHash('sha256')
      .update(`${request.method} ${request.url.split('?')[0]}\n${stableStringify(request.body)}`)
      .digest('hex');

    // Checked synchronously before any await, so two concurrent requests
    // with one key cannot both slip through to the handler.
    if (inFlight.has(scope)) {
      throw fail(
        'idempotency_conflict',
        'IDEMPOTENCY_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }
    inFlight.add(scope);
    (request as IdempotentRequest).bachsIdempotency = { scope, fingerprint };

    const existing = await options.state.idempotency.get(scope);
    const fresh =
      existing?.state === 'done' &&
      existing.storedAt !== null &&
      options.clock.now() - Date.parse(existing.storedAt) < WINDOW_MS;

    if (existing && fresh) {
      if (existing.fingerprint !== fingerprint) {
        throw fail(
          'idempotency_conflict',
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different request',
        );
      }
      // Replay: the cached status and body. "response headers can differ".
      delete (request as IdempotentRequest).bachsIdempotency;
      inFlight.delete(scope);
      reply.status(existing.status ?? 200).header('content-type', 'application/json; charset=utf-8');
      return reply.send(existing.body);
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    const pending = (request as IdempotentRequest).bachsIdempotency;
    if (!pending) return payload;
    // "A 4xx or 5xx response is not cached by this middleware."
    if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === 'string') {
      await options.state.idempotency.put(pending.scope, {
        fingerprint: pending.fingerprint,
        state: 'done',
        status: reply.statusCode,
        body: payload,
        storedAt: options.clock.nowISO(),
      });
    }
    // Released only once the response is stored, so a retry arriving in
    // between sees "in progress" rather than an empty cache.
    inFlight.delete(pending.scope);
    // And only once: onResponse must not release a marker a later request
    // with the same key has since taken.
    delete (request as IdempotentRequest).bachsIdempotency;
    return payload;
  });

  // A request that throws before onSend still reaches onSend through the
  // error handler, but one aborted by the client may not; never leave a key
  // marked in flight forever.
  fastify.addHook('onResponse', async (request) => {
    const pending = (request as IdempotentRequest).bachsIdempotency;
    if (pending) inFlight.delete(pending.scope);
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/* ------------------------------ response headers ----------------------------- */

/**
 * `x-request-id` on every response, and the rate-limit budget headers.
 *
 * Bachs' sandbox allows 100 requests a minute per key and reports the budget
 * on every response (api-standards, "Rate limits"). paybox reports it the same
 * way, counted per virtual minute, but does not refuse on its own: under a
 * frozen clock the minute never rolls over, and a test suite would be locked
 * out after its hundredth request for good. A real `429 TOO_MANY_REQUESTS`
 * comes from paybox's network simulation instead, in Bachs' envelope.
 * docs/bachs.md records this.
 */
export const SANDBOX_RATE_LIMIT = 100;

export function registerResponseHeaders(
  fastify: FastifyInstance,
  options: { clock: Clock; requestId: () => string },
): void {
  const windows = new Map<string, { window: number; used: number }>();

  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', options.requestId());
    const key = String(request.headers.authorization ?? '');
    if (!key) return;
    const window = Math.floor(options.clock.now() / 60_000);
    const current = windows.get(key);
    const entry = current && current.window === window ? current : { window, used: 0 };
    entry.used += 1;
    windows.set(key, entry);
    reply.header('X-RateLimit-Limit', String(SANDBOX_RATE_LIMIT));
    reply.header('X-RateLimit-Remaining', String(Math.max(0, SANDBOX_RATE_LIMIT - entry.used)));
    reply.header('X-RateLimit-Reset', String((window + 1) * 60));
  });
}

/* --------------------------------- paging --------------------------------- */

/**
 * `limit`, `cursor` and `offset` as the pagination guide defines them: limit
 * clamped (not rejected) at 100, a cursor that "takes precedence over
 * `offset`", and a malformed cursor refused with Bachs' exact message.
 */
export function readPage(
  query: { limit?: number; offset?: number; cursor?: string },
  defaultLimit: number,
): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, query.limit ?? defaultLimit));
  if (query.cursor !== undefined) {
    const match = /^cur_(\d+)$/.exec(query.cursor);
    if (!match) {
      throw fail('invalid_request', 'BAD_REQUEST', "Invalid cursor format. Expected 'cur_<offset>'.");
    }
    return { limit, offset: Number(match[1]) };
  }
  return { limit, offset: query.offset ?? 0 };
}

/* --------------------------------- helpers -------------------------------- */

/** `metadata` limits: 20 keys, each key and value at most 500 characters. */
export function assertMetadata(metadata: Record<string, unknown> | null | undefined, maxBytes?: number): void {
  if (!metadata) return;
  const keys = Object.keys(metadata);
  const tooLong = keys.some(
    (key) => key.length > 500 || (typeof metadata[key] === 'string' && (metadata[key] as string).length > 500),
  );
  if (keys.length > 20 || tooLong) {
    throw fail(
      'validation_failed',
      'METADATA_LIMIT_EXCEEDED',
      '`metadata` allows at most 20 keys, each key and value at most 500 characters.',
    );
  }
  if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(metadata)) > maxBytes) {
    throw fail('validation_failed', 'METADATA_LIMIT_EXCEEDED', '`metadata` must be at most 10 KB.');
  }
}

/**
 * "Newest first" by creation order, falling back to `created_at` for a record
 * paybox's own tooling wrote without a sequence number.
 */
export function newestFirst(
  a: { seq?: number | undefined; createdAt: string },
  b: { seq?: number | undefined; createdAt: string },
): number {
  if (a.seq !== undefined && b.seq !== undefined) return b.seq - a.seq;
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return (b.seq ?? 0) - (a.seq ?? 0);
}

export function notFound(what: string): PayboxError {
  return fail('not_found', 'NOT_FOUND', `${what} not found`);
}

export function sendError(reply: FastifyReply, status: number, body: ReturnType<typeof bachsErrorBody>) {
  return reply.status(status).send(body);
}

export type Authenticate = (request: FastifyRequest) => string;

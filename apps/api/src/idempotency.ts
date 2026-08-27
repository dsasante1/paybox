import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { PayboxError, type Clock, type ProviderId } from '@paybox/shared';
import type { Storage } from '@paybox/core';

export interface IdempotencyOptions {
  storage: Storage;
  clock: Clock;
  provider: ProviderId;
  /** Header to honour. Stripe uses Idempotency-Key; others vary. */
  header?: string;
}

/**
 * Idempotent replay of write requests (spec §16).
 *
 * Semantics deliberately match what real providers do rather than being merely
 * convenient:
 *
 *   same key + same request  -> the original response, byte for byte, and no
 *                               second transaction is created
 *   same key + different body -> 409. This is the important half. Silently
 *                               returning the first response would hide a real
 *                               bug in the caller, and silently processing the
 *                               new body would defeat the point of the key.
 *
 * Only non-GET requests are considered; reads are idempotent already.
 */
const plugin: FastifyPluginAsync<IdempotencyOptions> = async (fastify, options) => {
  const header = (options.header ?? 'idempotency-key').toLowerCase();

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const key = request.headers[header];
    if (typeof key !== 'string' || key.length === 0) return;

    const hash = hashRequest(request.method, request.url, request.body);
    const existing = await options.storage.idempotency.get(options.provider, key);
    if (!existing) {
      // Stash for the onSend hook, which records the response once it exists.
      (request as IdempotentRequest).payboxIdempotency = { key, hash };
      return;
    }

    if (existing.requestHash !== hash) {
      throw new PayboxError(
        'idempotency_conflict',
        `Idempotency key "${key}" was already used with a different request body.`,
        { details: { key } },
      );
    }

    reply
      .status(existing.responseStatus)
      .header('content-type', 'application/json')
      .header('x-paybox-idempotent-replay', 'true');
    return reply.send(existing.responseBody);
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    const pending = (request as IdempotentRequest).payboxIdempotency;
    if (!pending) return payload;
    // Only successful responses are memoised: a failed request should be
    // retryable with the same key, which is what callers expect.
    if (reply.statusCode >= 400) return payload;
    if (typeof payload !== 'string') return payload;

    await options.storage.idempotency.put({
      provider: options.provider,
      key: pending.key,
      requestHash: pending.hash,
      responseStatus: reply.statusCode,
      responseBody: payload,
      createdAt: options.clock.nowISO(),
    });
    return payload;
  });
};

/**
 * Wrapped with fastify-plugin so the hooks apply to the *enclosing* scope --
 * i.e. to the provider routes registered alongside it. Without this the hooks
 * would be encapsulated to this plugin's own (empty) context and silently do
 * nothing, which is Fastify's single sharpest edge.
 */
export const idempotencyPlugin = fp(plugin, {
  name: 'paybox-idempotency',
  fastify: '5.x',
});

interface IdempotentRequest {
  payboxIdempotency?: { key: string; hash: string };
}

function hashRequest(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${url}\n${stableStringify(body)}`)
    .digest('hex');
}

/** Key order must not change the hash, or a reordered JSON body false-conflicts. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

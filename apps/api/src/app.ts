import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import scalarApiReference from '@scalar/fastify-api-reference';
import { stripePlugin } from '@paybox/stripe';
import { flutterwavePlugin, flutterwaveV4Plugin } from '@paybox/flutterwave';
import { koraPlugin } from '@paybox/kora';
import { wewirePlugin } from '@paybox/wewire';
import { wisePlugin } from '@paybox/wise';
import { paystackPlugin, fail } from '@paybox/paystack';
import type { PayboxContext } from './context.js';
import { controlApiPlugin } from './control-api.js';
import { ssePlugin } from './sse.js';
import { idempotencyPlugin } from './idempotency.js';
import { networkPlugin } from './network.js';
import { buildOpenApiDocument } from './openapi.js';
import { renderDashboard } from './dashboard.js';

/**
 * Assembles the HTTP surface.
 *
 * Each provider is registered as an encapsulated Fastify plugin with its own
 * prefix, error handler, idempotency store and network-simulation hooks.
 * Encapsulation is the reason this is Fastify rather than Express: a provider
 * plugin's hooks and error serialiser apply to that provider's routes and
 * nothing else, which is spec §30's isolation requirement enforced by the
 * framework instead of by convention.
 */
export async function buildApp(context: PayboxContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Provider SDKs send bodies we must read byte-exactly for signatures, and
    // some send form-encoded checkout posts.
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cors, { origin: true });

  // Tolerate a bodyless POST that still declares JSON. curl users and several
  // provider SDKs do this, and Fastify's default parser rejects it outright.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = (body as string).trim();
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  /* ------------------------- control plane ------------------------- */

  await app.register(controlApiPlugin, { context, prefix: '/api' });
  await app.register(ssePlugin, { context, prefix: '/api' });

  /* --------------------------- providers --------------------------- */

  if (context.config.providers.paystack?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          errorBody: (status) =>
            fail(
              status === 429
                ? 'Too many requests'
                : 'The provider is temporarily unavailable (simulated by paybox).',
            ),
        });
        await scope.register(idempotencyPlugin, {
          storage: context.storage,
          clock: context.clock,
          provider: 'paystack',
        });
        await scope.register(paystackPlugin, {
          engine: context.engine,
          simulator: context.simulator,
          subscriptions: context.subscriptions,
          transferFee: context.config.balance.transferFee,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/paystack',
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/paystack' },
    );
  }

  if (context.config.providers.stripe?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          // Stripe's envelope, not Paystack's. Answering a Stripe client in
          // the wrong shape is exactly the confusion encapsulation prevents.
          errorBody: (status) => ({
            error: {
              type: status === 429 ? 'invalid_request_error' : 'api_error',
              message:
                status === 429
                  ? 'Too many requests'
                  : 'The provider is temporarily unavailable (simulated by paybox).',
              ...(status === 429 ? { code: 'rate_limit' } : {}),
            },
          }),
        });
        await scope.register(idempotencyPlugin, {
          storage: context.storage,
          clock: context.clock,
          provider: 'stripe',
        });
        await scope.register(stripePlugin, {
          engine: context.engine,
          simulator: context.simulator,
          subscriptions: context.subscriptions,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/stripe',
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/stripe' },
    );
  }

  if (context.config.providers.flutterwave?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          // Flutterwave's envelope, not another provider's. Answering a
          // Flutterwave client in the wrong shape is exactly the confusion
          // this encapsulation prevents.
          errorBody: (status) => ({
            status: 'error',
            message:
              status === 429
                ? 'Too many requests'
                : 'The provider is temporarily unavailable (simulated by paybox).',
            data: null,
          }),
        });
        await scope.register(idempotencyPlugin, {
          storage: context.storage,
          clock: context.clock,
          provider: 'flutterwave',
        });
        await scope.register(flutterwavePlugin, {
          engine: context.engine,
          simulator: context.simulator,
          subscriptions: context.subscriptions,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/flutterwave',
          encryptionKey: context.flutterwaveKeys.encryptionKey,
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/flutterwave' },
    );
  }

  if (context.config.providers.flutterwave?.enabled !== false) {
    // v4 is a second, genuinely different API from the same provider, so it
    // gets its own encapsulated scope: OAuth instead of API keys, a different
    // error envelope, and its own not-found handler.
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          errorBody: (status) => ({
            status: 'failed',
            error: {
              type: status === 429 ? 'TOO_MANY_REQUESTS' : 'SERVER_ERROR',
              code: status === 429 ? '10429' : '10500',
              message:
                status === 429
                  ? 'Too many requests'
                  : 'The provider is temporarily unavailable (simulated by paybox).',
            },
          }),
        });
        await scope.register(idempotencyPlugin, {
          storage: context.storage,
          clock: context.clock,
          provider: 'flutterwave',
        });
        await scope.register(flutterwaveV4Plugin, {
          engine: context.engine,
          simulator: context.simulator,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/flutterwave/v4',
          credentials: context.flutterwaveV4,
          allowAnyKey: context.config.security.allowAnyKey,
        });
      },
      { prefix: '/flutterwave/v4' },
    );
  }

  if (context.config.providers.kora?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          // Kora's envelope: a boolean status, unlike Flutterwave's string.
          errorBody: (status) => ({
            status: false,
            message:
              status === 429
                ? 'Too many requests'
                : 'The provider is temporarily unavailable (simulated by paybox).',
            data: null,
          }),
        });
        await scope.register(idempotencyPlugin, {
          storage: context.storage,
          clock: context.clock,
          provider: 'kora',
        });
        await scope.register(koraPlugin, {
          engine: context.engine,
          simulator: context.simulator,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/kora',
          secretKey: context.koraKeys.secretKey,
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/kora' },
    );
  }

  if (context.config.providers.wewire?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          // WeWire's structured envelope. `success: false` is the field its
          // own docs tell clients to branch on, so a simulated outage has to
          // carry it or the client would read the failure as a success.
          errorBody: (status) => ({
            success: false,
            error: {
              code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'INTEGRATION_UNAVAILABLE',
              message:
                status === 429
                  ? 'Too many requests'
                  : 'The provider is temporarily unavailable (simulated by paybox).',
              statusCode: status,
            },
          }),
        });
        // No `idempotencyPlugin` here on purpose: WeWire takes its
        // idempotency key as a **body field** on three endpoints rather than
        // as a header on all of them, so the adapter handles it itself. See
        // the note in providers/wewire/src/routes.ts.
        await scope.register(wewirePlugin, {
          engine: context.engine,
          simulator: context.simulator,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          random: context.random,
          baseUrl: context.baseUrl,
          basePath: '/wewire',
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/wewire' },
    );
  }

  if (context.config.providers.wise?.enabled !== false) {
    await app.register(
      async (scope) => {
        await scope.register(networkPlugin, {
          simulator: context.network,
          // Wise's envelope: a timestamp and an array of coded errors.
          errorBody: (status) => ({
            timestamp: context.clock.nowISO(),
            errors: [
              {
                code: status === 429 ? 'TOO_MANY_REQUESTS' : 'unexpected.error',
                message:
                  status === 429
                    ? 'Too many requests'
                    : 'The provider is temporarily unavailable (simulated by paybox).',
              },
            ],
          }),
        });
        // No `idempotencyPlugin`: Wise's idempotency key is
        // `customerTransactionId`, a body field on `POST /transfers` alone,
        // so the adapter handles it. Same reasoning as WeWire.
        await scope.register(wisePlugin, {
          engine: context.engine,
          storage: context.storage,
          clock: context.clock,
          ids: context.ids,
          baseUrl: context.baseUrl,
          basePath: '/wise',
          allowAnyKey: context.config.security.allowAnyKey,
          autoAdvance: context.config.simulation.autoAdvance,
          autoAdvanceDelayMs: context.config.simulation.autoAdvanceDelayMs,
        });
      },
      { prefix: '/wise' },
    );
  }

  /* --------------------------- docs & UI --------------------------- */

  app.get('/openapi.json', async () => buildOpenApiDocument(context));

  // The interactive reference (spec §44). The plugin ships Scalar's viewer
  // inside its own package and serves it from `/docs/js/scalar.js`, so
  // nothing loads from a CDN and the page works offline, like the dashboard.
  // It is handed the document above directly rather than a URL to fetch, so
  // it also renders under `app.inject()`, where nothing is listening.
  //
  // Declared as a dependency from the first commit and never registered:
  // until this, `/docs` served a pretty-printed JSON dump of the document.
  await app.register(scalarApiReference, {
    routePrefix: '/docs',
    configuration: {
      pageTitle: 'paybox API reference',
      content: () => buildOpenApiDocument(context),
    },
  });

  app.get('/dashboard', async (_request, reply) =>
    reply.type('text/html').send(renderDashboard(context)),
  );

  app.get('/', async (_request, reply) => reply.redirect('/dashboard'));

  return app;
}


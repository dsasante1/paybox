import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { stripePlugin } from '@paybox/stripe';
import { flutterwavePlugin } from '@paybox/flutterwave';
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

  /* --------------------------- docs & UI --------------------------- */

  app.get('/openapi.json', async () => buildOpenApiDocument(context));

  app.get('/docs', async (_request, reply) =>
    reply.type('text/html').send(scalarPage(context.baseUrl)),
  );

  app.get('/dashboard', async (_request, reply) =>
    reply.type('text/html').send(renderDashboard(context)),
  );

  app.get('/', async (_request, reply) => reply.redirect('/dashboard'));

  return app;
}

/** Scalar reads the OpenAPI document from our own origin; nothing external. */
function scalarPage(baseUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>paybox API reference</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><script id="api-reference" data-url="${baseUrl}/openapi.json"></script>
<script>
  // No CDN: render a readable fallback if the bundled viewer is unavailable.
  if (!window.Scalar) {
    fetch('/openapi.json').then(r => r.json()).then(doc => {
      document.body.innerHTML =
        '<h1 style="font:600 20px system-ui;padding:24px 24px 0">' + doc.info.title + '</h1>' +
        '<p style="font:14px system-ui;padding:0 24px;color:#555">' + doc.info.description + '</p>' +
        '<pre style="font:12px ui-monospace;padding:24px;white-space:pre-wrap">' +
        JSON.stringify(doc, null, 2) + '</pre>';
    });
  }
</script></body></html>`;
}

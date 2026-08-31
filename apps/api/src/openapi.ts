import { VERSION, type CoverageEntry, type CoverageManifest } from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { WEWIRE_COVERAGE } from '@paybox/wewire';
import { WISE_COVERAGE } from '@paybox/wise';
import type { PayboxContext } from './context.js';

/**
 * The OpenAPI document behind /docs (spec §44).
 *
 * Two sources, deliberately split. The **route list** is generated from the
 * coverage manifests — the same declarations `tests/coverage-drift.test.ts`
 * enforces against the router — so every route the emulator serves appears
 * here and the list cannot drift. The **shapes** are hand-curated: an entry
 * carries a request or response schema only where one has been transcribed
 * from the provider's contract, because a schema generated from our handlers
 * would describe the emulator instead of the API it emulates, and a guessed
 * one would be worse. A generated entry names the docs/<provider>.md file
 * that is authoritative instead of pretending.
 */
const MANIFESTS: readonly CoverageManifest[] = [
  PAYSTACK_COVERAGE,
  STRIPE_COVERAGE,
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  KORA_COVERAGE,
  WEWIRE_COVERAGE,
  WISE_COVERAGE,
];

/** `/paystack` + `/transaction/verify/:reference` → `/paystack/transaction/verify/{reference}`. */
function publicPath(manifest: CoverageManifest, entry: CoverageEntry): string {
  return `${manifest.basePath}${entry.path}`.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function manifestOperation(manifest: CoverageManifest, entry: CoverageEntry): Record<string, unknown> {
  const status =
    entry.status === 'compatible'
      ? `**Compatible** with ${manifest.label}'s documented behaviour, within what paybox models.`
      : entry.status === 'partial'
        ? '**Partial** — a documented limitation applies.'
        : `**Emulator-only** — no ${manifest.label} counterpart exists; never treat this as provider surface.`;
  const description = [
    status,
    entry.note,
    `Shapes are not transcribed for this entry: the contract in ${manifest.docs} is ` +
      `authoritative, and \`paybox coverage ${manifest.id}\` lists this adapter's routes.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const parameters = [...publicPath(manifest, entry).matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1]!,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  return {
    tags: [manifest.label],
    description,
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: { default: { description: `See ${manifest.docs}.` } },
  };
}

/**
 * The full path map: one generated entry per manifest route, with the
 * hand-curated entries overriding method-by-method wherever a shape has
 * actually been transcribed.
 */
function withManifestRoutes(
  curated: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const manifest of MANIFESTS) {
    for (const entry of manifest.entries) {
      (paths[publicPath(manifest, entry)] ??= {})[entry.method.toLowerCase()] =
        manifestOperation(manifest, entry);
    }
  }
  for (const [path, operations] of Object.entries(curated)) {
    paths[path] = { ...(paths[path] ?? {}), ...operations };
  }
  return paths;
}
export function buildOpenApiDocument(context: PayboxContext): Record<string, unknown> {
  const paystackEnvelope = {
    type: 'object',
    properties: {
      status: { type: 'boolean' },
      message: { type: 'string' },
      data: { type: 'object' },
    },
  };

  const bearer = [{ PaystackSecretKey: [] }];

  return {
    openapi: '3.1.0',
    info: {
      title: 'paybox — local payment infrastructure emulator',
      version: VERSION,
      description:
        'Provider-compatible payment APIs served from localhost. No real money moves. ' +
        'Provider routes mirror the upstream contract; /api/* is the emulator control plane. ' +
        'Every route the emulator serves is listed here, generated from the coverage ' +
        'manifests the test suite enforces against the router. Entries carry schemas only ' +
        "where a shape has been hand-transcribed; each adapter's contract in " +
        'docs/<provider>.md is the authoritative statement of behaviour.',
    },
    servers: [{ url: context.baseUrl }],
    components: {
      securitySchemes: {
        PaystackSecretKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'A local test key (sk_test_local_...). Live keys are refused.',
        },
      },
    },
    tags: [
      ...MANIFESTS.map((manifest) => ({
        name: manifest.label,
        description: `${manifest.label}-compatible endpoints — coverage contract: ${manifest.docs}`,
      })),
      { name: 'Payments', description: 'Emulator control plane' },
      { name: 'Webhooks', description: 'Delivery inspection, retry and replay' },
      { name: 'Simulation', description: 'Time, network and scenario control' },
    ],
    paths: withManifestRoutes({
      '/paystack/transaction/initialize': {
        post: {
          tags: ['Paystack'],
          summary: 'Initialize a transaction',
          security: bearer,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'amount'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    amount: {
                      oneOf: [{ type: 'integer' }, { type: 'string' }],
                      description: 'Minor units (kobo, pesewas).',
                    },
                    currency: { type: 'string', example: 'GHS' },
                    reference: { type: 'string' },
                    callback_url: { type: 'string', format: 'uri' },
                    metadata: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Authorization URL created',
              content: { 'application/json': { schema: paystackEnvelope } },
            },
            401: { description: 'Missing or non-test key' },
          },
        },
      },
      '/paystack/transaction/verify/{reference}': {
        get: {
          tags: ['Paystack'],
          summary: 'Verify a transaction',
          security: bearer,
          parameters: [
            { name: 'reference', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { content: { 'application/json': { schema: paystackEnvelope } }, description: 'OK' },
            404: { description: 'Unknown reference' },
          },
        },
      },
      '/paystack/charge': {
        post: {
          tags: ['Paystack'],
          summary: 'Charge a mobile money number, test card, or bank account',
          security: bearer,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'amount'],
                  properties: {
                    email: { type: 'string' },
                    amount: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
                    currency: { type: 'string' },
                    mobile_money: {
                      type: 'object',
                      properties: {
                        phone: { type: 'string', example: '0550000000' },
                        provider: { type: 'string', example: 'mtn' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Charge attempted' } },
        },
      },
      '/paystack/refund': {
        post: {
          tags: ['Paystack'],
          summary: 'Refund a transaction, fully or partially',
          security: bearer,
          responses: { 200: { description: 'Refund queued' } },
        },
      },
      '/api/payments': {
        get: { tags: ['Payments'], summary: 'List payments across all providers', responses: { 200: { description: 'OK' } } },
      },
      '/api/payments/{id}': {
        get: {
          tags: ['Payments'],
          summary: 'Payment with its full timeline, refunds and webhook deliveries',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/api/payments/{id}/simulate': {
        post: {
          tags: ['Payments'],
          summary: 'Drive a payment to an outcome through real state transitions',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    outcome: {
                      type: 'string',
                      enum: [
                        'success',
                        'declined',
                        'insufficient_funds',
                        'expired_card',
                        'authentication_required',
                        'authentication_failed',
                        'timeout',
                        'processing_error',
                        'customer_rejected',
                        'network_error',
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated payment' } },
        },
      },
      '/api/webhooks/deliveries': {
        get: { tags: ['Webhooks'], summary: 'Delivery history with attempts and responses', responses: { 200: { description: 'OK' } } },
      },
      '/api/webhooks/deliveries/{id}/replay': {
        post: {
          tags: ['Webhooks'],
          summary: 'Send the identical signed payload again as a new delivery',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'New delivery' } },
        },
      },
      '/api/webhooks/chaos': {
        post: {
          tags: ['Simulation'],
          summary: 'Force webhook delivery outcomes',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    forceOutcome: {
                      type: ['string', 'null'],
                      enum: ['http_500', 'http_400', 'http_429', 'timeout', 'connection_refused', 'malformed_response', null],
                    },
                    failureRate: { type: 'number', minimum: 0, maximum: 1 },
                    duplicate: { type: 'boolean' },
                    outOfOrder: { type: 'boolean' },
                    latencyMs: { type: 'integer' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Active chaos configuration' } },
        },
      },
      '/api/time': {
        get: { tags: ['Simulation'], summary: 'Current virtual clock state', responses: { 200: { description: 'OK' } } },
        post: {
          tags: ['Simulation'],
          summary: 'Freeze, unfreeze, advance or set virtual time',
          description:
            'Advancing runs every job that becomes due before returning, so webhook retries and ' +
            'payment expiries fire synchronously rather than after a wait.',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: { type: 'string', enum: ['freeze', 'unfreeze', 'advance', 'set'] },
                    value: {
                      oneOf: [{ type: 'string' }, { type: 'integer' }],
                      example: '30s',
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Clock state' } },
        },
      },
      '/api/network': {
        post: {
          tags: ['Simulation'],
          summary: 'Inject latency and failures into provider responses',
          responses: { 200: { description: 'Active network profile' } },
        },
      },
      '/api/scenarios/run': {
        post: { tags: ['Simulation'], summary: 'Run a named scenario against a payment', responses: { 200: { description: 'Scenario run' } } },
      },
    }),
  };
}

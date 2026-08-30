import { VERSION } from '@paybox/shared';
import type { PayboxContext } from './context.js';

/**
 * Hand-curated OpenAPI document (spec §44).
 *
 * Written by hand rather than generated, because the provider routes must
 * describe *Paystack's* contract — the shape a developer's SDK expects — not
 * whatever internal schema our handler happens to use. A generated document
 * would drift toward describing the emulator instead of the API it emulates.
 */
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
        'Provider routes mirror the upstream contract; /api/* is the emulator control plane.',
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
      { name: 'Paystack', description: 'Paystack-compatible endpoints' },
      { name: 'Payments', description: 'Emulator control plane' },
      { name: 'Webhooks', description: 'Delivery inspection, retry and replay' },
      { name: 'Simulation', description: 'Time, network and scenario control' },
    ],
    paths: {
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
    },
  };
}

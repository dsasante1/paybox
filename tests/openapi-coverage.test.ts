import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import type { CoverageEntry, CoverageManifest } from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { WEWIRE_COVERAGE } from '@paybox/wewire';
import { WISE_COVERAGE } from '@paybox/wise';

/**
 * The OpenAPI document lists the whole served surface (spec §44).
 *
 * The document's route list is generated from the coverage manifests -- the
 * same declarations `tests/coverage-drift.test.ts` holds against the router --
 * so the reference at /docs cannot claim a route the emulator does not serve,
 * or omit one it does. The hand-curated entries stay as overrides where a
 * shape has actually been transcribed.
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

const publicPath = (manifest: CoverageManifest, entry: CoverageEntry) =>
  `${manifest.basePath}${entry.path}`.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

interface Operation {
  tags?: string[];
  description?: string;
  requestBody?: unknown;
}
interface OpenApiDoc {
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
}

let app: FastifyInstance;
let context: PayboxContext;
let doc: OpenApiDoc;

beforeAll(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'openapi-coverage';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
  doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as OpenApiDoc;
});

afterAll(async () => {
  await app.close();
  await context.shutdown();
});

describe('GET /openapi.json', () => {
  it('lists every route from every coverage manifest', () => {
    for (const manifest of MANIFESTS) {
      for (const entry of manifest.entries) {
        const operation = doc.paths[publicPath(manifest, entry)]?.[entry.method.toLowerCase()];
        expect(operation, `${entry.method} ${manifest.basePath}${entry.path}`).toBeDefined();
        expect(operation!.tags).toContain(manifest.label);
      }
    }
  });

  it('has a tag per adapter, so the viewer groups by provider', () => {
    const names = doc.tags.map((tag) => tag.name);
    for (const manifest of MANIFESTS) expect(names).toContain(manifest.label);
  });

  it('keeps the hand-curated entries as overrides where shapes are transcribed', () => {
    expect(doc.paths['/paystack/transaction/initialize']!.post!.requestBody).toBeDefined();
    expect(doc.paths['/api/payments/{id}/simulate']!.post!.requestBody).toBeDefined();
  });

  it('labels emulator-only routes so they cannot read as provider surface', () => {
    expect(doc.paths['/paystack/dispute']!.post!.description).toContain('Emulator-only');
  });

  it('points generated entries at the authoritative contract instead of guessing a schema', () => {
    const stripe = doc.paths['/stripe/v1/payment_intents']?.post;
    expect(stripe).toBeDefined();
    expect(stripe!.description).toContain('docs/stripe.md');
    expect(stripe!.requestBody).toBeUndefined();
  });
});

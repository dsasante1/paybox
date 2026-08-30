import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * The API reference page (spec §44).
 *
 * `/docs` served a pretty-printed JSON dump of the OpenAPI document for its
 * whole life: the page was set up for Scalar's viewer and the plugin was a
 * declared dependency, but nothing ever registered it. These pin the two
 * things the page has to do -- render the viewer, and serve the viewer's
 * JavaScript from this origin, so nothing loads from a CDN and the page works
 * offline exactly as the dashboard does.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'docs-page';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

describe('GET /docs', () => {
  it('redirects to the trailing-slash form the viewer resolves its assets against', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe('/docs/');
  });

  it('renders the Scalar viewer, not a JSON dump', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('paybox API reference');
    expect(response.body).toContain('js/scalar.js');
    // The old page fetched the document and dumped it into a <pre>.
    expect(response.body).not.toContain('JSON.stringify(doc');
  });

  it('loads nothing from a CDN', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/' });
    expect(response.body).not.toMatch(/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/);
  });

  it('serves the viewer from this origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/js/scalar.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.body.length).toBeGreaterThan(100_000);
  });

  it('is handed the same document /openapi.json serves', async () => {
    const ours = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const theirs = (await app.inject({ method: 'GET', url: '/docs/openapi.json' })).json();
    expect(ours.openapi).toBe('3.1.0');
    expect(Object.keys(theirs.paths)).toEqual(Object.keys(ours.paths));
  });
});

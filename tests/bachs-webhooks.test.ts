import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport, type TransportRequest } from '@paybox/webhooks';

/**
 * Bachs webhooks through the HTTP surface a merchant uses: the endpoint API,
 * signing and rotation, the retry ladder and its stop rules, auto-disable,
 * the events API, resend/replay and metrics.
 *
 * Sources, all read 2026-10-10:
 *  - docs.bachs.io/guides/webhooks/overview ("How the signature works",
 *    "Rotating a signing secret", "Retries", "When an endpoint keeps
 *    failing", "Connect events");
 *  - the pinned OpenAPI document (docs.bachs.io/docs/openapi/openapi.json,
 *    sha256 9c2265585c2b…4810): createWebhookEndpoint … replayWebhookEvent.
 *
 * The signature is recomputed here with node:crypto from the documented
 * algorithm rather than with the adapter's own signer, so a signer and a
 * verifier that agree with each other but not with Bachs would fail.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';
const START_S = Date.parse(START) / 1000;
const RECEIVER = 'https://merchant.example.com/webhooks/bachs';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'bachs-webhooks';
  transport = new RecordingTransport();
  const { config } = loadConfig();
  context = await buildContext({ config, transport, logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

/* --------------------------------- harness --------------------------------- */

const auth = () => ({
  authorization: `Bearer ${context.bachsKeys.secretKey}`,
  'content-type': 'application/json',
});
const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url: `/bachs${url}`, headers: auth(), payload: (body ?? {}) as object });
const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: auth(), payload: body as object });
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
const del = (url: string) =>
  app.inject({ method: 'DELETE', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = async (value: string) => {
  const response = await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });
  expect(response.statusCode).toBe(200);
};
/** Run every job already due (deliveries are queued, never sent inline). */
const flush = () => context.scheduler.drain();

function respond(status: number | null, error: string | null = null, body: string | null = 'ok') {
  transport.respondWith(() => ({ status, body: status === null ? null : body, durationMs: 3, error }));
}

interface Endpoint {
  endpoint_id: string;
  signing_secret: string;
  name: string;
  url: string;
  enabled: boolean;
  disabled_at: string | null;
  disabled_reason: string | null;
  event_types: string[];
  event_source: string;
}

async function endpoint(
  overrides: Record<string, unknown> = {},
): Promise<Endpoint> {
  const response = await post('/v1/webhooks/endpoints', {
    name: 'Local receiver',
    url: RECEIVER,
    event_types: ['customer.created', 'customer.updated'],
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Endpoint;
}

let customerCount = 0;
async function customer(email = `buyer${++customerCount}@example.com`) {
  const response = await post('/v1/customers', { email, name: 'Ada Okafor' });
  expect(response.statusCode).toBe(201);
  return response.json() as { customer_id: string; email: string };
}

/** The documented algorithm: hex HMAC-SHA256(secret, `${t}.${raw}`). */
const hmac = (secret: string, t: number | string, raw: string) =>
  createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');

const header = (request: TransportRequest, name: string) => {
  const key = Object.keys(request.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? request.headers[key] : undefined;
};
const tsOf = (request: TransportRequest) => Number(header(request, 'X-Bachs-Timestamp'));
const bodyOf = (request: TransportRequest) =>
  JSON.parse(request.body) as { id: string; type: string; created_at: string; data: Record<string, unknown> };
const v1s = (request: TransportRequest) =>
  header(request, 'X-Bachs-Signature-V2')!
    .split(',')
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3));

async function deliveries() {
  const page = await context.storage.webhooks.listDeliveries({ limit: 200, offset: 0 });
  return page.items.filter((d) => d.provider === ('bachs' as typeof d.provider));
}

async function readEndpoint(id: string) {
  const response = await get(`/v1/webhooks/endpoints/${id}`);
  expect(response.statusCode).toBe(200);
  return response.json() as Endpoint;
}

/* ------------------------------- endpoint API ------------------------------- */

describe('webhook endpoint API', () => {
  it('creates an endpoint with a signing secret, lowercased event types and the account source', async () => {
    const response = await post('/v1/webhooks/endpoints', {
      name: 'Production events',
      url: RECEIVER,
      event_types: ['Checkout.Completed', 'COLLECTION.SUCCEEDED', 'refund.paid'],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.endpoint_id).toMatch(/^whe_[0-9a-f]{32}$/);
    expect(body.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(body).toMatchObject({
      name: 'Production events',
      url: RECEIVER,
      enabled: true,
      disabled_at: null,
      disabled_reason: null,
      // "Values are matched case-insensitively and stored lowercase."
      event_types: ['checkout.completed', 'collection.succeeded', 'refund.paid'],
      // "Defaults to `account` when you omit it."
      event_source: 'account',
      created_at: START,
      updated_at: START,
    });

    // The secret is shown once on creation; GET /secret returns the same one.
    const secret = await get(`/v1/webhooks/endpoints/${body.endpoint_id}/secret`);
    expect(secret.statusCode).toBe(200);
    expect(secret.json()).toMatchObject({ endpoint_id: body.endpoint_id, secret: body.signing_secret });
    expect((await readEndpoint(body.endpoint_id)) as unknown as Record<string, unknown>).not.toHaveProperty(
      'signing_secret',
    );
  });

  it('refuses an empty event_types list and an unknown event type with 400', async () => {
    const empty = await post('/v1/webhooks/endpoints', { name: 'x', url: RECEIVER, event_types: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error_code).toBe('VALIDATION_ERROR');

    const unknown = await post('/v1/webhooks/endpoints', {
      name: 'x',
      url: RECEIVER,
      event_types: ['collection.succeeded', 'charge.success'],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error_code).toBe('VALIDATION_ERROR');

    // Nothing was created by either refusal.
    expect((await get('/v1/webhooks/endpoints')).json().items).toEqual([]);
  });

  it('lists endpoints newest first with pagination', async () => {
    const first = await endpoint({ name: 'first' });
    await advance('1s');
    const second = await endpoint({ name: 'second' });
    await advance('1s');
    const third = await endpoint({ name: 'third' });

    const list = await get('/v1/webhooks/endpoints');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.items.map((e: Endpoint) => e.endpoint_id)).toEqual([
      third.endpoint_id,
      second.endpoint_id,
      first.endpoint_id,
    ]);
    expect(body.items[0]).not.toHaveProperty('signing_secret');
    expect(body.items[0]).not.toHaveProperty('secret');
    expect(body.pagination).toMatchObject({ total: 3, limit: 50, offset: 0, returned: 3, has_more: false });

    const paged = (await get('/v1/webhooks/endpoints?limit=2')).json();
    expect(paged.items.map((e: Endpoint) => e.name)).toEqual(['third', 'second']);
    expect(paged.pagination).toMatchObject({ has_more: true, next_cursor: 'cur_2', returned: 2, total: 3 });
  });

  it('lists endpoints newest first even when they share a timestamp (frozen clock)', async () => {
    // "The webhook endpoints registered on this account, newest first"
    // (WebhookEndpointListResponse.items). Under PAYBOX_FREEZE_CLOCK every
    // endpoint created in one test shares created_at to the millisecond, so
    // creation order has to come from something other than the timestamp.
    const created: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) created.push((await endpoint({ name })).endpoint_id);
    const listed = (await get('/v1/webhooks/endpoints')).json().items.map((e: Endpoint) => e.endpoint_id);
    expect(listed).toEqual([...created].reverse());
  });

  it('gets, patches and deletes an endpoint', async () => {
    const hook = await endpoint();
    expect(await readEndpoint(hook.endpoint_id)).toMatchObject({
      endpoint_id: hook.endpoint_id,
      name: 'Local receiver',
      event_types: ['customer.created', 'customer.updated'],
    });

    const renamed = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { name: 'Renamed' });
    expect(renamed.statusCode).toBe(200);
    // "Only the fields you send are changed."
    expect(renamed.json()).toMatchObject({
      name: 'Renamed',
      url: RECEIVER,
      enabled: true,
      event_types: ['customer.created', 'customer.updated'],
      event_source: 'account',
    });

    const moved = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, {
      url: 'https://merchant.example.com/webhooks/v2',
      event_types: ['Refund.Paid', 'checkout.completed'],
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      name: 'Renamed',
      url: 'https://merchant.example.com/webhooks/v2',
      // Replaced, not merged; lowercased like on create.
      event_types: ['refund.paid', 'checkout.completed'],
    });

    const off = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    // Turned off by the merchant: "disabled_at and disabled_reason stay null,
    // so you can tell your choice from ours."
    expect(off.json()).toMatchObject({ enabled: false, disabled_at: null, disabled_reason: null });

    const on = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { enabled: true });
    expect(on.json()).toMatchObject({ enabled: true, disabled_at: null, disabled_reason: null });

    const badType = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { event_types: ['nope'] });
    expect(badType.statusCode).toBe(400);

    const deleted = await del(`/v1/webhooks/endpoints/${hook.endpoint_id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ status: 'deleted', endpoint_id: hook.endpoint_id });

    const gone = await get(`/v1/webhooks/endpoints/${hook.endpoint_id}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error_code).toBe('NOT_FOUND');
    expect((await get('/v1/webhooks/endpoints')).json().items).toEqual([]);
  });

  it('answers 404 NOT_FOUND for an unknown endpoint on every endpoint route', async () => {
    const id = 'whe_00000000000000000000000000000000';
    const responses = [
      await get(`/v1/webhooks/endpoints/${id}`),
      await patch(`/v1/webhooks/endpoints/${id}`, { name: 'x' }),
      await del(`/v1/webhooks/endpoints/${id}`),
      await get(`/v1/webhooks/endpoints/${id}/secret`),
      await post(`/v1/webhooks/endpoints/${id}/rotate-secret`),
      await get(`/v1/webhooks/endpoints/${id}/metrics`),
      await get(`/v1/webhooks/endpoints/${id}/events`),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error_code).toBe('NOT_FOUND');
    }
  });

  it('needs a key', async () => {
    const response = await app.inject({ method: 'GET', url: '/bachs/v1/webhooks/endpoints' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error_code).toBe('UNAUTHORIZED');
  });
});

/* --------------------------------- routing --------------------------------- */

describe('which endpoints receive an event', () => {
  it('a connect-only endpoint receives none of the account\'s own events', async () => {
    await endpoint({ url: 'https://merchant.example.com/account' });
    const connect = await endpoint({ url: 'https://merchant.example.com/connect', event_source: 'connect' });
    expect(connect.event_source).toBe('connect');
    expect(connect.event_types).toEqual(['customer.created', 'customer.updated']);
    await endpoint({ url: 'https://merchant.example.com/all', event_source: 'all' });

    await customer();
    await flush();
    expect(transport.sent.map((r) => r.url).sort()).toEqual([
      'https://merchant.example.com/account',
      'https://merchant.example.com/all',
    ]);
  });

  it('only the subscribed event types are delivered', async () => {
    await endpoint({ url: 'https://merchant.example.com/refunds', event_types: ['refund.paid'] });
    await endpoint({ url: 'https://merchant.example.com/customers', event_types: ['customer.updated'] });

    const created = await customer('ada@example.com');
    await flush();
    expect(transport.sent).toHaveLength(0);

    // Upserting by email "emits customer.updated rather than customer.created".
    await post('/v1/customers', { email: created.email, name: 'Ada O.' });
    await flush();
    expect(transport.sent.map((r) => [r.url, bodyOf(r).type])).toEqual([
      ['https://merchant.example.com/customers', 'customer.updated'],
    ]);
  });
});

/* -------------------------------- signatures -------------------------------- */

describe('signatures', () => {
  it('signs `${t}.${raw_body}` with the secret, in all three headers', async () => {
    const hook = await endpoint();
    await customer();
    await flush();
    const [request] = transport.sent;
    expect(request).toBeDefined();
    const t = header(request!, 'X-Bachs-Timestamp');
    // Unix seconds, not milliseconds.
    expect(t).toBe(String(START_S));
    const expected = hmac(hook.signing_secret, t!, request!.body);
    expect(header(request!, 'X-Bachs-Signature')).toBe(expected);
    expect(header(request!, 'X-Bachs-Signature-V2')).toBe(`t=${t},v1=${expected}`);
  });

  it('re-signs every retry at its own instant', async () => {
    const hook = await endpoint();
    respond(503);
    await customer();
    await flush();
    await advance('3h');
    expect(transport.sent).toHaveLength(5);
    for (const request of transport.sent) {
      const t = tsOf(request);
      expect(header(request, 'X-Bachs-Signature')).toBe(hmac(hook.signing_secret, t, request.body));
      expect(header(request, 'X-Bachs-Signature-V2')).toBe(`t=${t},v1=${hmac(hook.signing_secret, t, request.body)}`);
    }
    // Same bytes every time; only the timestamp and signature move.
    expect(new Set(transport.sent.map((r) => r.body)).size).toBe(1);
  });
});

describe('secret rotation', () => {
  it('signs with new and old secrets for 24 hours, then with the new one only', async () => {
    const hook = await endpoint();
    const rotated = await post(`/v1/webhooks/endpoints/${hook.endpoint_id}/rotate-secret`);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().endpoint_id).toBe(hook.endpoint_id);
    // As in Bachs' example: the rotate response carries no secret.
    expect(rotated.json()).not.toHaveProperty('secret');
    expect(rotated.json()).not.toHaveProperty('signing_secret');

    const current = (await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/secret`)).json().secret as string;
    expect(current).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(current).not.toBe(hook.signing_secret);

    await customer();
    await flush();
    const during = transport.sent[0]!;
    const t = tsOf(during);
    // "Repeats v1= once per currently valid secret" -- current first.
    expect(v1s(during)).toEqual([hmac(current, t, during.body), hmac(hook.signing_secret, t, during.body)]);
    expect(header(during, 'X-Bachs-Signature')).toBe(hmac(current, t, during.body));

    // Still inside the window at 23h59m.
    await advance('23h');
    await advance('59m');
    await customer();
    await flush();
    expect(v1s(transport.sent[1]!)).toHaveLength(2);

    await advance('2m');
    await customer();
    await flush();
    const after = transport.sent[2]!;
    expect(v1s(after)).toEqual([hmac(current, tsOf(after), after.body)]);
    expect(header(after, 'X-Bachs-Signature')).toBe(hmac(current, tsOf(after), after.body));
  });

  it('a retry that crosses the end of the overlap drops the old signature', async () => {
    const hook = await endpoint();
    await post(`/v1/webhooks/endpoints/${hook.endpoint_id}/rotate-secret`);
    await advance('23h');
    await advance('30m');
    respond(503);
    await customer();
    await flush();
    await advance('2h');
    // Tries at 23:30, 23:31, 23:36, 23:51 carry two; 24:51 carries one.
    expect(transport.sent.map((r) => v1s(r).length)).toEqual([2, 2, 2, 2, 1]);
  });
});

/* ---------------------------------- retries ---------------------------------- */

describe('retries', () => {
  it('a 503 gets five tries, 1m, 5m, 15m and 1h apart, then stops as exhausted', async () => {
    await endpoint();
    respond(503);
    await customer();
    await flush();
    expect(transport.sent).toHaveLength(1);
    await advance('1m');
    expect(transport.sent).toHaveLength(2);
    await advance('5m');
    expect(transport.sent).toHaveLength(3);
    await advance('15m');
    expect(transport.sent).toHaveLength(4);
    await advance('1h');
    expect(transport.sent).toHaveLength(5);
    await advance('6h');
    expect(transport.sent).toHaveLength(5);

    const stamps = transport.sent.map((r) => tsOf(r) - START_S);
    // "The last try comes about 80 minutes after the first."
    expect(stamps).toEqual([0, 60, 360, 1_260, 4_860]);
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ status: 'exhausted', attempt: 5, responseStatus: 503 });
  });

  it.each([
    ['408', 408, null],
    ['429', 429, null],
    ['500', 500, null],
    ['a timeout', null, 'Request timed out.'],
    ['an unreachable endpoint', null, 'Connection refused. Is your webhook endpoint running?'],
  ])('retries %s on the same ladder, even across one long advance', async (_label, status, error) => {
    await endpoint();
    respond(status, error);
    await customer();
    await flush();
    await advance('3h');
    expect(transport.sent.map((r) => tsOf(r) - START_S)).toEqual([0, 60, 360, 1_260, 4_860]);
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ status: 'exhausted', attempt: 5 });
  });

  it.each([400, 401, 404, 410, 422, 301, 302, 307])('stops on %i after exactly one try', async (status) => {
    await endpoint();
    respond(status);
    const created = await customer();
    await flush();
    await advance('6h');
    expect(transport.sent).toHaveLength(1);
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ status: 'failed', attempt: 1, nextRetryAt: null, responseStatus: status });

    const events = (await get('/v1/webhooks/events')).json();
    const item = events.items.find((e: { entity_id: string }) => e.entity_id === created.customer_id);
    expect(item).toMatchObject({
      attempts: 1,
      success: 0,
      failed: 1,
      last_attempt_status: 'failed',
      last_attempt_http_status: status,
    });
  });

  it('a retry that later gets a 400 stops there', async () => {
    await endpoint();
    respond(503);
    await customer();
    await flush();
    respond(401);
    await advance('1m');
    await advance('3h');
    expect(transport.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempt: 2 });
  });

  it('a retry that succeeds ends the ladder', async () => {
    await endpoint();
    respond(503);
    await customer();
    await flush();
    respond(200);
    await advance('3h');
    expect(transport.sent).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'succeeded', attempt: 2 });
  });

  it('turning an endpoint off stops a retry that was already queued', async () => {
    const hook = await endpoint();
    respond(503);
    await customer();
    await flush();
    expect(transport.sent).toHaveLength(1);
    await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { enabled: false });
    await advance('3h');
    // "Retries that were already waiting stop."
    expect(transport.sent).toHaveLength(1);
    expect((await deliveries())[0]?.status).toBe('failed');

    // "Events that happen while it is off are not sent later, even after you
    // turn it back on."
    await customer();
    await flush();
    await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { enabled: true });
    respond(200);
    await advance('3h');
    expect(transport.sent).toHaveLength(1);
  });

  it('deleting an endpoint stops a retry that was already queued', async () => {
    const hook = await endpoint();
    respond(503);
    await customer();
    await flush();
    await del(`/v1/webhooks/endpoints/${hook.endpoint_id}`);
    await advance('3h');
    // "It stops receiving events immediately."
    expect(transport.sent).toHaveLength(1);
  });

  it('a retry queued for the old URL goes to the new one', async () => {
    const hook = await endpoint();
    respond(503);
    await customer();
    await flush();
    const moved = 'https://merchant.example.com/webhooks/moved';
    await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { url: moved });
    respond(200);
    await advance('1m');
    expect(transport.sent.map((r) => r.url)).toEqual([RECEIVER, moved]);
    const retry = transport.sent[1]!;
    expect(header(retry, 'X-Bachs-Signature')).toBe(hmac(hook.signing_secret, tsOf(retry), retry.body));

    const [event] = (await get('/v1/webhooks/events')).json().items;
    const detail = (await get(`/v1/webhooks/events/${event.event_id}`)).json();
    expect(detail.attempts.map((a: { callback_url: string }) => a.callback_url)).toEqual([moved, RECEIVER]);
  });
});

/* ------------------------------- auto-disable ------------------------------- */

describe('an endpoint that keeps failing', () => {
  it('is turned off after 72 hours of failures, 48 hours after the warning', async () => {
    const hook = await endpoint();
    respond(500);
    await customer(); // fails from T+0
    await flush();
    await advance('24h');
    await customer(); // T+24h: the warning
    await flush();
    await advance('24h');
    await customer(); // T+48h
    await flush();
    expect((await readEndpoint(hook.endpoint_id)).enabled).toBe(true);

    await advance('24h');
    const sentBefore = transport.sent.length;
    await customer(); // T+72h: 72h failing, 48h since the warning
    await flush();
    expect(transport.sent.length).toBe(sentBefore + 1);

    const off = await readEndpoint(hook.endpoint_id);
    expect(off).toMatchObject({
      enabled: false,
      disabled_at: '2026-06-17T12:00:00.000Z',
      disabled_reason: 'consecutive_failures',
    });

    // The retry of that last event was waiting; it stops too.
    await advance('3h');
    expect(transport.sent.length).toBe(sentBefore + 1);

    // "Turning an endpoint on clears its failure history, disabled_at and
    // disabled_reason."
    const on = await patch(`/v1/webhooks/endpoints/${hook.endpoint_id}`, { enabled: true });
    expect(on.json()).toMatchObject({ enabled: true, disabled_at: null, disabled_reason: null });
    expect(await readEndpoint(hook.endpoint_id)).toMatchObject({
      enabled: true,
      disabled_at: null,
      disabled_reason: null,
    });

    // "If it still fails after you turn it on, the 24-hour count starts again
    // from the next failure": a failure right away does not turn it off.
    await customer();
    await flush();
    expect((await readEndpoint(hook.endpoint_id)).enabled).toBe(true);
  });

  it('one success resets the count', async () => {
    const hook = await endpoint();
    respond(500);
    await customer();
    await flush();
    await advance('24h');
    respond(200);
    await customer(); // succeeds at T+24h
    await flush();
    respond(500);
    await advance('24h');
    await customer(); // T+48h
    await flush();
    await advance('24h');
    await customer(); // T+72h: only 24h failing since the success
    await flush();
    expect(await readEndpoint(hook.endpoint_id)).toMatchObject({
      enabled: true,
      disabled_at: null,
      disabled_reason: null,
    });
  });

  it('always gets the full 48 hours after the warning', async () => {
    const hook = await endpoint();
    respond(500);
    await customer(); // T+0
    await flush();
    await advance('72h');
    await customer(); // T+72h: failing 72h, but this is the warning
    await flush();
    expect((await readEndpoint(hook.endpoint_id)).enabled).toBe(true);
    await advance('24h');
    await customer(); // T+96h: 24h after the warning
    await flush();
    expect((await readEndpoint(hook.endpoint_id)).enabled).toBe(true);
    await advance('24h');
    await customer(); // T+120h: 48h after the warning
    await flush();
    expect(await readEndpoint(hook.endpoint_id)).toMatchObject({
      enabled: false,
      disabled_at: '2026-06-19T12:00:00.000Z',
      disabled_reason: 'consecutive_failures',
    });
  });

  it('refusals count too ("including the ones we do not retry, such as a 401")', async () => {
    const hook = await endpoint();
    respond(401);
    for (let i = 0; i < 4; i++) {
      await customer();
      await flush();
      if (i < 3) await advance('24h');
    }
    expect(await readEndpoint(hook.endpoint_id)).toMatchObject({
      enabled: false,
      disabled_reason: 'consecutive_failures',
    });
  });
});

/* -------------------------------- events API -------------------------------- */

describe('webhook events API', () => {
  it('lists events newest first with their delivery summary', async () => {
    const hook = await endpoint();
    respond(503);
    const first = await customer();
    await flush();
    respond(200);
    await advance('1m');
    const second = await customer();
    await flush();

    const list = await get('/v1/webhooks/events');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'offset', 'total']);
    expect(body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(body.items.map((e: { entity_id: string }) => e.entity_id)).toEqual([
      second.customer_id,
      first.customer_id,
    ]);

    const [newer, older] = body.items;
    const deliveredIds = transport.sent.map((r) => bodyOf(r).id);
    expect(older.event_id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(older.event_id).toBe(deliveredIds[0]);
    expect(newer.event_id).toBe(deliveredIds[2]);
    expect(older).toMatchObject({
      event_type: 'customer.created',
      entity_type: 'customer',
      entity_id: first.customer_id,
      created_at: START,
      account: context.bachsKeys.organizationId,
      attempts: 2,
      success: 1,
      failed: 1,
      last_attempt_status: 'succeeded',
      last_attempt_http_status: 200,
      last_attempt_error: null,
      last_attempt_at: '2026-06-14T12:01:00.000Z',
    });

    const paged = (await get('/v1/webhooks/events?limit=1&offset=1')).json();
    expect(paged).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(paged.items.map((e: { event_id: string }) => e.event_id)).toEqual([older.event_id]);

    // Per endpoint.
    const perEndpoint = (await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/events`)).json();
    expect(perEndpoint.total).toBe(2);
    expect(perEndpoint.items.map((e: { event_id: string }) => e.event_id).sort()).toEqual(
      [older.event_id, newer.event_id].sort(),
    );
  });

  it('records an event even when no endpoint received it', async () => {
    const created = await customer();
    await flush();
    const [item] = (await get('/v1/webhooks/events')).json().items;
    expect(item).toMatchObject({
      event_type: 'customer.created',
      entity_id: created.customer_id,
      attempts: 0,
      success: 0,
      failed: 0,
      last_attempt_status: null,
      last_attempt_http_status: null,
      last_attempt_error: null,
      last_attempt_at: null,
    });
    const detail = (await get(`/v1/webhooks/events/${item.event_id}`)).json();
    expect(detail.attempts).toEqual([]);
    expect(detail.payload.id).toBe(item.event_id);
  });

  it('returns the exact payload that was delivered and every attempt, newest first', async () => {
    const hook = await endpoint();
    respond(503, null, 'upstream unavailable');
    const created = await customer();
    await flush();
    respond(200, null, '{"received":true}');
    await advance('1m');

    const sentBody = transport.sent[0]!.body;
    const delivered = JSON.parse(sentBody);
    const detail = await get(`/v1/webhooks/events/${delivered.id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({
      event_id: delivered.id,
      event_type: 'customer.created',
      entity_type: 'customer',
      entity_id: created.customer_id,
      created_at: START,
    });
    expect(body.payload).toEqual(delivered);
    // Byte for byte, too: the same key order serialises to the same bytes.
    expect(JSON.stringify(body.payload)).toBe(sentBody);

    expect(body.attempts).toHaveLength(2);
    const [second, first] = body.attempts;
    expect(second).toMatchObject({
      attempt_no: 2,
      status: 'succeeded',
      callback_url: RECEIVER,
      http_status: 200,
      response_snippet: '{"received":true}',
      last_error: null,
      updated_at: '2026-06-14T12:01:00.000Z',
    });
    expect(first).toMatchObject({
      attempt_no: 1,
      status: 'failed',
      callback_url: RECEIVER,
      http_status: 503,
      response_snippet: 'upstream unavailable',
      updated_at: START,
    });
    expect(first.last_error).toEqual(expect.any(String));
    for (const attempt of body.attempts) expect(attempt.attempt_id).toMatch(/^wha_[0-9a-f]{32}$/);
    expect(second.attempt_id).not.toBe(first.attempt_id);

    // Per-endpoint detail is the same event, narrowed to that endpoint.
    const scoped = (await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/events/${delivered.id}`)).json();
    expect(scoped.payload).toEqual(delivered);
    expect(scoped.attempts.map((a: { attempt_no: number }) => a.attempt_no)).toEqual([2, 1]);
  });

  it('per-endpoint views show only that endpoint\'s attempts', async () => {
    const a = await endpoint({ url: 'https://merchant.example.com/a' });
    const b = await endpoint({ url: 'https://merchant.example.com/b', event_types: ['refund.paid'] });
    await customer();
    await flush();
    const eventId = bodyOf(transport.sent[0]!).id;

    const listA = (await get(`/v1/webhooks/endpoints/${a.endpoint_id}/events`)).json();
    expect(listA.items.map((e: { event_id: string }) => e.event_id)).toEqual([eventId]);
    expect(listA.items[0]).toMatchObject({ event_type: 'customer.created', attempts: 1, success: 1, failed: 0 });
    const listB = (await get(`/v1/webhooks/endpoints/${b.endpoint_id}/events`)).json();
    expect(listB).toMatchObject({ items: [], total: 0 });

    const scopedB = (await get(`/v1/webhooks/endpoints/${b.endpoint_id}/events/${eventId}`)).json();
    expect(scopedB.attempts).toEqual([]);
  });

  it('answers 404 for an unknown event', async () => {
    const hook = await endpoint();
    const missing = 'evt_00000000000000000000000000000000';
    for (const response of [
      await get(`/v1/webhooks/events/${missing}`),
      await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/events/${missing}`),
      await post(`/v1/webhooks/endpoints/${hook.endpoint_id}/events/${missing}/resend`),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error_code).toBe('NOT_FOUND');
    }
  });
});

/* ------------------------------ resend / replay ------------------------------ */

describe('resend', () => {
  it('queues a single try of the same event, and never retries it', async () => {
    const hook = await endpoint();
    await customer();
    await flush();
    const original = transport.sent[0]!;
    const eventId = bodyOf(original).id;

    respond(503);
    const resent = await post(`/v1/webhooks/endpoints/${hook.endpoint_id}/events/${eventId}/resend`);
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toEqual({ status: 'queued', attempt_id: expect.stringMatching(/^wha_[0-9a-f]{32}$/) });

    await flush();
    expect(transport.sent).toHaveLength(2);
    // "Use the id field to deduplicate deliveries": a resend keeps it.
    expect(transport.sent[1]!.body).toBe(original.body);
    expect(bodyOf(transport.sent[1]!).id).toBe(eventId);

    // "A resend or a replay is a single try. We do not retry it."
    await advance('2h');
    expect(transport.sent).toHaveLength(2);

    const detail = (await get(`/v1/webhooks/events/${eventId}`)).json();
    expect(detail.attempts.map((a: { attempt_no: number; status: string; http_status: number }) => [a.attempt_no, a.status, a.http_status])).toEqual([
      [2, 'failed', 503],
      [1, 'succeeded', 200],
    ]);
    expect(detail.attempts[0].attempt_id).toBe(resent.json().attempt_id);
  });

  it('is signed afresh at the instant it is sent', async () => {
    const hook = await endpoint();
    await customer();
    await flush();
    const eventId = bodyOf(transport.sent[0]!).id;
    await advance('3h');
    await post(`/v1/webhooks/endpoints/${hook.endpoint_id}/events/${eventId}/resend`);
    await flush();
    const resent = transport.sent[1]!;
    expect(tsOf(resent)).toBe(START_S + 3 * 3600);
    expect(header(resent, 'X-Bachs-Signature')).toBe(hmac(hook.signing_secret, tsOf(resent), resent.body));
  });
});

describe('replay', () => {
  async function paidCheckout(reference: string) {
    const product = await post('/v1/products', { name: 'Pro plan', price: { currency: 'USD', amount: '29.00' } });
    expect(product.statusCode).toBe(201);
    const session = await post('/v1/checkout-sessions', {
      product_cart: [{ product_id: product.json().id, quantity: 1 }],
      customer: { email: 'jane@example.com', name: 'Jane Doe' },
      reference,
    });
    expect(session.statusCode).toBe(201);
    const path = new URL(session.json().checkout_url).pathname;
    const paid = await pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(paid.statusCode).toBe(200);
    await advance('1s');
    const read = (await get(`/v1/checkout-sessions/${session.json().checkout_id}`)).json();
    return { checkoutId: read.checkout_id as string, chargeId: read.charge.payment_id as string };
  }

  it('replays by event_id, keeping the event id, as a single try', async () => {
    await endpoint();
    await customer();
    await flush();
    const eventId = bodyOf(transport.sent[0]!).id;

    respond(500);
    const replay = await post('/v1/webhooks/replay', { event_id: eventId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      event_id: eventId,
      attempt_id: expect.stringMatching(/^wha_[0-9a-f]{32}$/),
      // "Which attempt this is for the event, counting every earlier automatic retry."
      attempt_no: 2,
      event_type: 'customer.created',
    });
    await flush();
    await advance('2h');
    expect(transport.sent).toHaveLength(2);
    expect(bodyOf(transport.sent[1]!).id).toBe(eventId);
  });

  it('replays the latest event for a charge_id, and for a checkout reference', async () => {
    await endpoint({
      event_types: ['collection.succeeded', 'checkout.completed'],
    });
    const { chargeId } = await paidCheckout('order_7');
    await flush();
    const sentIds = transport.sent.map((r) => bodyOf(r));
    expect(sentIds.map((b) => b.type).sort()).toEqual(['checkout.completed', 'collection.succeeded']);
    const known = new Map(sentIds.map((b) => [b.id, b.type]));
    const before = transport.sent.length;

    const byCharge = await post('/v1/webhooks/replay', { charge_id: chargeId });
    expect(byCharge.statusCode).toBe(200);
    expect(known.get(byCharge.json().event_id)).toBe(byCharge.json().event_type);
    expect(byCharge.json().attempt_no).toBe(2);

    const byReference = await post('/v1/webhooks/replay', { reference: 'order_7' });
    expect(byReference.statusCode).toBe(200);
    expect(known.get(byReference.json().event_id)).toBe(byReference.json().event_type);

    await flush();
    expect(transport.sent.length).toBe(before + 2);
    expect(bodyOf(transport.sent[before]!).id).toBe(byCharge.json().event_id);
    expect(bodyOf(transport.sent[before + 1]!).id).toBe(byReference.json().event_id);
  });

  it('needs a lookup field, and 404s when nothing matches', async () => {
    await endpoint();
    const none = await post('/v1/webhooks/replay', {});
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({
      error_code: 'BAD_REQUEST',
      detail: 'Provide at least one of event_id, charge_id, or reference.',
    });

    for (const body of [
      { event_id: 'evt_00000000000000000000000000000000' },
      { charge_id: 'ch_00000000000000000000000000000000' },
      { reference: 'no-such-order' },
    ]) {
      const response = await post('/v1/webhooks/replay', body);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error_code: 'NOT_FOUND',
        detail: 'No matching webhook event could be resolved for your lookup values.',
      });
    }
  });
});

/* ---------------------------------- metrics ---------------------------------- */

describe('metrics', () => {
  it('counts successes and failures per day over the last 30 days, zero-filled and ascending', async () => {
    const hook = await endpoint();
    respond(200);
    await customer();
    await flush();
    respond(400);
    await customer();
    await flush();
    respond(503);
    await customer();
    await flush();
    await advance('1m'); // the 503's retry, also a failed try

    const response = await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/metrics`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe('4');
    expect(body.period).toBe('day');
    expect(body.data).toHaveLength(30);
    expect(body.data[0].date).toBe('2026-05-16');
    expect(body.data[29]).toEqual({ date: '2026-06-14', success: 1, failed: 3 });
    const dates = body.data.map((d: { date: string }) => d.date);
    expect(dates).toEqual([...dates].sort());
    for (const bucket of body.data.slice(0, 29)) expect(bucket).toMatchObject({ success: 0, failed: 0 });
  });

  it('groups by week on request and falls back to day for an unknown period', async () => {
    const hook = await endpoint();
    await customer();
    await flush();
    const week = (await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/metrics?period=week`)).json();
    expect(week.period).toBe('week');
    expect(week.total).toBe('1');
    expect(week.data.reduce((sum: number, d: { success: number }) => sum + d.success, 0)).toBe(1);
    const dates = week.data.map((d: { date: string }) => d.date);
    expect(dates).toEqual([...dates].sort());

    // "An unrecognised value falls back to day."
    const odd = (await get(`/v1/webhooks/endpoints/${hook.endpoint_id}/metrics?period=fortnight`)).json();
    expect(odd.period).toBe('day');
    expect(odd.data).toHaveLength(30);
  });

  it('counts only this endpoint', async () => {
    const a = await endpoint({ url: 'https://merchant.example.com/a' });
    await endpoint({ url: 'https://merchant.example.com/b' });
    await customer();
    await flush();
    const metrics = (await get(`/v1/webhooks/endpoints/${a.endpoint_id}/metrics`)).json();
    expect(metrics.total).toBe('1');
  });
});


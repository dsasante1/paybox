import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Bachs: the merchant API's cross-cutting contract -- authentication, response
 * headers, idempotency, request validation, lists and balances.
 *
 * Sources, read 2026-10-10: docs.bachs.io/api-reference/api-standards
 * (x-request-id, X-RateLimit-*, sandbox 100/min), /authentication (sk_sandbox_
 * vs sk_live_), /guides/idempotency (POST+PATCH only, 2xx cached 24h,
 * IDEMPOTENCY_CONFLICT), /guides/pagination (cursor format, clamp at 100),
 * /api-reference/error-reference (codes and HTTP statuses),
 * /guides/checkout/checkout-sessions (public success_url, unique reference),
 * and the pinned OpenAPI document (sha256 9c2265585c2b…4810).
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';
const DOC_GENERAL = 'https://docs.bachs.io/api-reference/error-reference#general';
const DOC_CHECKOUT = 'https://docs.bachs.io/api-reference/error-reference#checkout-sessions';
const DOC_PRODUCTS = 'https://docs.bachs.io/api-reference/error-reference#products-&-prices';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'bachs';
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

const auth = () => ({
  authorization: `Bearer ${context.bachsKeys.secretKey}`,
  'content-type': 'application/json',
});
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/bachs${url}`, headers: { ...auth(), ...headers }, payload: (body ?? {}) as object });
const patch = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: { ...auth(), ...headers }, payload: body as object });
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization, ...headers } });
const del = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'DELETE', url: `/bachs${url}`, headers: { authorization: auth().authorization, ...headers } });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function product(price: Record<string, unknown> = { currency: 'USD', amount: '29.00' }, extra: Record<string, unknown> = {}) {
  const response = await post('/v1/products', { name: 'Pro plan', price, ...extra });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string };
}

const pathOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

/** All stored checkout sessions, read beneath the API (there is no list endpoint). */
async function storedSessions() {
  return context.storage.providerState.listByPrefix('bachs', 'checkout:');
}

const JANE = { email: 'jane@example.com', name: 'Jane Doe' };

/** A checkout paid with `card` on the hosted page, settled. */
async function paidCheckout(card = '4242424242424242', price?: Record<string, unknown>) {
  const { id } = await product(price);
  const created = await post('/v1/checkout-sessions', { product_cart: [{ product_id: id }], customer: JANE });
  expect(created.statusCode, created.body).toBe(201);
  const session = created.json();
  const corridor = price?.currency === 'NGN' ? 'NGN_CARD' : 'USD_CARD';
  await pagePost(`${pathOf(session.checkout_url)}/pay`, { corridor, card_number: card });
  await advance('1s');
  return (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json();
}

/* ------------------------------ authentication ------------------------------ */

describe('authentication', () => {
  it('refuses a request with no key', async () => {
    const response = await app.inject({ method: 'GET', url: '/bachs/v1/payments' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: 'Missing API key', error_code: 'UNAUTHORIZED', doc_url: DOC_GENERAL });
  });

  it('refuses a live key', async () => {
    const response = await app.inject({ method: 'GET', url: '/bachs/v1/payments', headers: { authorization: 'Bearer sk_live_x' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'UNAUTHORIZED', doc_url: DOC_GENERAL });
  });

  it('refuses a key without the sandbox prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/bachs/v1/payments', headers: { authorization: 'Bearer pk_x' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: 'Invalid API key', error_code: 'UNAUTHORIZED', doc_url: DOC_GENERAL });
  });

  it('accepts the generated sandbox key', async () => {
    expect(context.bachsKeys.secretKey).toMatch(/^sk_sandbox_/);
    expect((await get('/v1/payments')).statusCode).toBe(200);
  });
});

/* ------------------------------ response headers ----------------------------- */

describe('response headers', () => {
  it('puts a UUID x-request-id on every response, success or error, and a fresh one each time', async () => {
    const responses = [
      await get('/v1/payments'),
      await app.inject({ method: 'GET', url: '/bachs/v1/payments' }),
      await get('/v1/checkout-sessions/chk_missing'),
      await post('/v1/products', {}),
    ];
    const ids = responses.map((response) => response.headers['x-request-id']);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports the sandbox budget: 100 a minute, counting down, resetting at the next minute', async () => {
    const reset = String(Date.parse(START) / 1000 + 60);
    const first = await get('/v1/payments');
    const second = await get('/v1/balances');
    const third = await post('/v1/products', {});
    expect(first.headers['x-ratelimit-limit']).toBe('100');
    expect(first.headers['x-ratelimit-remaining']).toBe('99');
    expect(second.headers['x-ratelimit-remaining']).toBe('98');
    expect(third.headers['x-ratelimit-remaining']).toBe('97');
    for (const response of [first, second, third]) expect(response.headers['x-ratelimit-reset']).toBe(reset);

    // A new window on the virtual clock.
    await advance('1m');
    const later = await get('/v1/payments');
    expect(later.headers['x-ratelimit-remaining']).toBe('99');
    expect(later.headers['x-ratelimit-reset']).toBe(String(Date.parse(START) / 1000 + 120));
  });
});

/* -------------------------------- idempotency -------------------------------- */

describe('Idempotency-Key', () => {
  async function body() {
    const { id } = await product();
    return { product_cart: [{ product_id: id }], customer: JANE };
  }

  it('replays the same status and body for the same key and request, creating one session', async () => {
    const request = await body();
    const first = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    const second = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(await storedSessions()).toHaveLength(1);

    // A different key is a different operation.
    const third = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-2' });
    expect(third.json().checkout_id).not.toBe(first.json().checkout_id);
    expect(await storedSessions()).toHaveLength(2);
  });

  it('refuses the same key with a different body: 409 IDEMPOTENCY_CONFLICT', async () => {
    const request = await body();
    await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    const conflict = await post('/v1/checkout-sessions', { ...request, metadata: { changed: 'yes' } }, { 'idempotency-key': 'key-1' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      detail: 'Idempotency-Key was already used with a different request',
      error_code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await storedSessions()).toHaveLength(1);
  });

  it('forgets a key 24 hours after storing it', async () => {
    const request = await body();
    const first = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    await advance('25h');
    const again = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    expect(again.statusCode).toBe(201);
    expect(again.json().checkout_id).not.toBe(first.json().checkout_id);
    expect(again.json().created_at).toBe('2026-06-15T13:00:00.000Z');
    expect(await storedSessions()).toHaveLength(2);
  });

  it('does not cache an error: the same key succeeds once the request is fixed', async () => {
    const request = await body();
    const refused = await post(
      '/v1/checkout-sessions',
      { ...request, success_url: 'http://localhost:3000/thanks' },
      { 'idempotency-key': 'key-1' },
    );
    expect(refused.statusCode).toBe(400);
    const fixed = await post(
      '/v1/checkout-sessions',
      { ...request, success_url: 'https://shop.example.com/thanks' },
      { 'idempotency-key': 'key-1' },
    );
    expect(fixed.statusCode).toBe(201);
    // And a retry of the same failing request is evaluated again, not replayed.
    const retried = await post('/v1/checkout-sessions', { ...request, success_url: 'https://shop.example.com/thanks' }, { 'idempotency-key': 'key-1' });
    expect(retried.body).toBe(fixed.body);
    expect(await storedSessions()).toHaveLength(1);
  });

  it('scopes a key to the API key that used it', async () => {
    const request = await body();
    const first = await post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' });
    const other = await post('/v1/checkout-sessions', request, {
      'idempotency-key': 'key-1',
      authorization: 'Bearer sk_sandbox_another_key',
    });
    expect(other.statusCode).toBe(201);
    expect(other.json().checkout_id).not.toBe(first.json().checkout_id);
  });

  it('two concurrent requests with one key create one session', async () => {
    // "If the original request is still running, a retry can return 409
    // IDEMPOTENCY_IN_PROGRESS" -- can, not must: a retry that lands after the
    // original finished is a replay. Either way, one operation happens.
    const request = await body();
    const [one, two] = await Promise.all([
      post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' }),
      post('/v1/checkout-sessions', request, { 'idempotency-key': 'key-1' }),
    ]);
    expect(await storedSessions()).toHaveLength(1);
    const original = one.statusCode === 201 ? one : two;
    const retry = original === one ? two : one;
    expect(original.statusCode).toBe(201);
    if (retry.statusCode === 409) {
      expect(retry.json().error_code).toBe('IDEMPOTENCY_IN_PROGRESS');
    } else {
      expect(retry.statusCode).toBe(201);
      expect(retry.body).toBe(original.body);
    }
  });

  it('covers PATCH', async () => {
    const { id } = await product();
    const first = await patch(`/v1/products/${id}`, { name: 'Renamed' }, { 'idempotency-key': 'patch-1' });
    expect(first.statusCode).toBe(200);
    // Something else changes the product in between; the replay still answers with the original body.
    await patch(`/v1/products/${id}`, { name: 'Changed again' });
    const replay = await patch(`/v1/products/${id}`, { name: 'Renamed' }, { 'idempotency-key': 'patch-1' });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect((await get(`/v1/products/${id}`)).json().name).toBe('Changed again');

    const conflict = await patch(`/v1/products/${id}`, { name: 'Other' }, { 'idempotency-key': 'patch-1' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error_code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('ignores the header on GET and DELETE', async () => {
    const { id } = await product();
    const firstGet = await get(`/v1/products/${id}`, { 'idempotency-key': 'k' });
    await patch(`/v1/products/${id}`, { name: 'Renamed' });
    const secondGet = await get(`/v1/products/${id}`, { 'idempotency-key': 'k' });
    expect(firstGet.json().name).toBe('Pro plan');
    expect(secondGet.json().name).toBe('Renamed');

    const endpoints = [];
    for (const name of ['One', 'Two']) {
      const created = await post('/v1/webhooks/endpoints', {
        name,
        url: 'https://merchant.example.com/webhooks/bachs',
        event_types: ['collection.succeeded'],
      });
      expect(created.statusCode).toBe(201);
      endpoints.push(created.json().endpoint_id as string);
    }
    const one = await del(`/v1/webhooks/endpoints/${endpoints[0]}`, { 'idempotency-key': 'k' });
    const two = await del(`/v1/webhooks/endpoints/${endpoints[1]}`, { 'idempotency-key': 'k' });
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(200);
    expect(one.json().endpoint_id).toBe(endpoints[0]);
    expect(two.json().endpoint_id).toBe(endpoints[1]);
  });
});

/* -------------------------- checkout session validation ------------------------- */

describe('checkout session validation', () => {
  async function expectError(body: Record<string, unknown>, status: number, code: string, docUrl: string | null = DOC_GENERAL) {
    const response = await post('/v1/checkout-sessions', body);
    expect(response.statusCode, response.body).toBe(status);
    const json = response.json();
    expect(json.error_code).toBe(code);
    if (docUrl) expect(json.doc_url).toBe(docUrl);
    expect(typeof json.detail).toBe('string');
    return json;
  }

  it('needs exactly one of product_cart and pricing', async () => {
    const { id } = await product();
    await expectError(
      { product_cart: [{ product_id: id }], pricing: { currency: 'USD', amount: '29.00' } },
      400,
      'VALIDATION_ERROR',
    );
    await expectError({ customer: JANE }, 400, 'VALIDATION_ERROR');
  });

  it.each([
    'http://localhost/thanks',
    'http://127.0.0.1:3000/thanks',
    'http://10.0.0.5/thanks',
    'http://192.168.1.2/thanks',
    'http://172.16.0.1/thanks',
    'http://[::1]:8080/thanks',
  ])('refuses a private success_url %s', async (url) => {
    await expectError({ pricing: { currency: 'USD', amount: '29.00' }, success_url: url }, 400, 'VALIDATION_ERROR');
  });

  it('accepts a public https success_url', async () => {
    const response = await post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', amount: '29.00' },
      success_url: 'https://shop.example.com/thanks',
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses a reference already used, even after that session expired', async () => {
    const first = await post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', amount: '29.00' },
      reference: 'order_1',
      expires_in_minutes: 1,
    });
    expect(first.statusCode).toBe(201);
    await expectError({ pricing: { currency: 'USD', amount: '29.00' }, reference: 'order_1' }, 409, 'CONFLICT');
    await advance('1m');
    expect((await get(`/v1/checkout-sessions/${first.json().checkout_id}`)).json().status).toBe('expired');
    await expectError({ pricing: { currency: 'USD', amount: '29.00' }, reference: 'order_1' }, 409, 'CONFLICT');
  });

  it('refuses an unknown product with PRODUCT_NOT_FOUND (400, not 404)', async () => {
    await expectError({ product_cart: [{ product_id: 'prod_missing' }] }, 400, 'PRODUCT_NOT_FOUND', DOC_PRODUCTS);
  });

  it('refuses an archived product with PRODUCT_ARCHIVED', async () => {
    const { id } = await product();
    expect((await post(`/v1/products/${id}/archive`)).statusCode).toBe(200);
    await expectError({ product_cart: [{ product_id: id }] }, 400, 'PRODUCT_ARCHIVED', DOC_PRODUCTS);
  });

  it('refuses a cart in two currencies with CART_CURRENCY_MISMATCH', async () => {
    const usd = await product();
    const ngn = await product({ currency: 'NGN', amount: '5000.00' });
    await expectError(
      { product_cart: [{ product_id: usd.id }, { product_id: ngn.id }] },
      400,
      'CART_CURRENCY_MISMATCH',
      DOC_CHECKOUT,
    );
  });

  it('refuses an NGN amount below the ₦100 minimum', async () => {
    await expectError({ pricing: { currency: 'NGN', amount: '50.00' } }, 400, 'VALIDATION_ERROR');
  });

  it('requires a customer on a recurring product, and a card on a checkout that saves one', async () => {
    // Both were 501 before subscriptions and saved cards existed.
    const { id } = await product({ currency: 'USD', amount: '29.00' }, { billing_cycle: { interval: 'month', frequency: 1 } });
    await expectError({ product_cart: [{ product_id: id }] }, 400, 'VALIDATION_ERROR');
    await expectError(
      { pricing: { currency: 'USD', amount: '29.00' }, save_payment_method: true, payment_method_types: ['NGN_BANK_TRANSFER'] },
      400,
      'CHECKOUT_CANNOT_SAVE_PAYMENT_METHOD',
      'https://docs.bachs.io/api-reference/error-reference#payments',
    );
  });

  it('refuses payment_method_types that leave nothing to pay with', async () => {
    await expectError(
      { pricing: { currency: 'USD', amount: '29.00' }, payment_method_types: ['MOMO_KES'] },
      400,
      'CHECKOUT_RESTRICTION_LEAVES_NO_PAYMENT_METHOD',
      DOC_CHECKOUT,
    );
  });

  it('refuses an unknown corridor', async () => {
    await expectError(
      { pricing: { currency: 'USD', amount: '29.00' }, payment_method_types: ['PAYPAL'] },
      400,
      'VALIDATION_ERROR',
    );
  });

  it('refuses a billing_currency nothing is priced in', async () => {
    await expectError(
      { pricing: { currency: 'USD', amount: '29.00' }, billing_currency: 'NGN' },
      400,
      'BILLING_CURRENCY_NOT_AVAILABLE',
      DOC_CHECKOUT,
    );
  });

  it('refuses an amount on a fixed-price line', async () => {
    const { id } = await product();
    await expectError(
      { product_cart: [{ product_id: id, amount: '10.00' }] },
      400,
      'FIXED_AMOUNT_OVERRIDE_NOT_ALLOWED',
      DOC_CHECKOUT,
    );
  });

  it('names every missing field in errors[] the way Bachs does', async () => {
    const response = await post('/v1/products', {});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      detail: 'Missing required field(s): name, price',
      error_code: 'VALIDATION_ERROR',
      doc_url: DOC_GENERAL,
      errors: [
        { field: 'name', message: 'Field required', type: 'missing' },
        { field: 'price', message: 'Field required', type: 'missing' },
      ],
    });

    const cart = await expectError({ product_cart: [{ quantity: 1 }] }, 400, 'VALIDATION_ERROR');
    expect(cart.errors).toEqual([{ field: 'product_cart.0.product_id', message: 'Field required', type: 'missing' }]);
    expect(cart.detail).toBe('Missing required field(s): product_cart.0.product_id');
  });

  it('refuses excess precision and a JSON number for an amount', async () => {
    await expectError({ pricing: { currency: 'USD', amount: '29.001' } }, 400, 'VALIDATION_ERROR');
    const number = await expectError({ pricing: { currency: 'USD', amount: 29 } }, 400, 'VALIDATION_ERROR');
    expect(number.errors[0].field).toBe('pricing.amount');
  });
});

/* ---------------------------------- not found ---------------------------------- */

describe('not found', () => {
  it('an unknown checkout session is a Bachs 404', async () => {
    const response = await get('/v1/checkout-sessions/chk_00000000000000000000000000000000');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: 'Checkout session not found', error_code: 'NOT_FOUND', doc_url: DOC_GENERAL });
  });

  it('an unknown route under /bachs is a Bachs 404', async () => {
    const response = await get('/v1/does-not-exist');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error_code: 'NOT_FOUND', doc_url: DOC_GENERAL });
    expect(response.json().detail).toContain('/bachs/v1/does-not-exist');
    expect(response.headers['x-request-id']).toMatch(UUID);
  });
});

/* ---------------------------------- payments ---------------------------------- */

describe('payments list', () => {
  async function three() {
    const a = await paidCheckout();
    const b = await paidCheckout('4000000000000002');
    const c = await paidCheckout();
    return [a.charge.payment_id as string, b.charge.payment_id as string, c.charge.payment_id as string];
  }

  it('pages with the documented envelope, newest first, default limit 50', async () => {
    const [a, b, c] = await three();
    const response = await get('/v1/payments');
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(Object.keys(json)).toEqual(['items', 'pagination']);
    expect(json.pagination).toEqual({
      next_cursor: null,
      prev_cursor: null,
      has_more: false,
      limit: 50,
      offset: 0,
      returned: 3,
      total: 3,
    });
    expect(json.items.map((item: { id: string }) => item.id)).toEqual([c, b, a]);
  });

  it('clamps limit at 100 rather than refusing it', async () => {
    await three();
    const json = (await get('/v1/payments?limit=500')).json();
    expect(json.pagination.limit).toBe(100);
    expect(json.items).toHaveLength(3);
  });

  it('walks pages by cursor and refuses a malformed one', async () => {
    const [, b] = await three();
    const json = (await get('/v1/payments?limit=1&cursor=cur_1')).json();
    expect(json.items.map((item: { id: string }) => item.id)).toEqual([b]);
    expect(json.pagination).toEqual({
      next_cursor: 'cur_2',
      prev_cursor: 'cur_0',
      has_more: true,
      limit: 1,
      offset: 1,
      returned: 1,
      total: 3,
    });

    const bad = await get('/v1/payments?cursor=page2');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({
      detail: "Invalid cursor format. Expected 'cur_<offset>'.",
      error_code: 'BAD_REQUEST',
      doc_url: DOC_GENERAL,
    });
  });

  it('filters by status_filter', async () => {
    const [a, b, c] = await three();
    const failed = (await get('/v1/payments?status_filter=failed')).json();
    expect(failed.items.map((item: { id: string }) => item.id)).toEqual([b]);
    expect(failed.pagination.total).toBe(1);
    const succeeded = (await get('/v1/payments?status_filter=succeeded')).json();
    expect(succeeded.items.map((item: { id: string }) => item.id)).toEqual([c, a]);
  });

  it('list items are the third shape: id, lowercase method object, settlement figures', async () => {
    const done = await paidCheckout();
    const [item] = (await get('/v1/payments')).json().items;
    expect(item).toMatchObject({
      id: done.charge.payment_id,
      status: 'succeeded',
      amount: '29.00',
      amount_paid: '29.00',
      amount_remaining: '0.00',
      settlement_amount: '27.15',
      settlement_currency: 'USD',
      fee: '1.85',
      currency: 'USD',
      customer_name: 'Jane Doe',
      customer_email: 'jane@example.com',
      payment_method: { type: 'usd_card', brand: 'visa', last4: '4242' },
      source: { type: 'CHECKOUT_SESSION', checkout_id: done.checkout_id },
      fee_paid_by: 'merchant',
    });
    expect(item).not.toHaveProperty('payment_id');
  });

  it('charge status has charge_id, organization_id, settlement_amount and status_history', async () => {
    const done = await paidCheckout();
    const response = await get(`/v1/payments/charges/${done.charge.payment_id}`);
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toMatchObject({
      charge_id: done.charge.payment_id,
      organization_id: context.bachsKeys.organizationId,
      amount: '29.00',
      currency: 'USD',
      settlement_currency: 'USD',
      settlement_amount: '27.15',
      status: 'succeeded',
    });
    expect(json.organization_id).toMatch(/^acct_[0-9A-Za-z]{16}$/);
    expect(json.customer_id).toMatch(/^cust_/);
    expect(json).not.toHaveProperty('payment_id');
    expect(json.status_history.map((entry: { status: string }) => entry.status)).toEqual(['created', 'processing', 'succeeded']);
    expect(json.status_history.at(-1).occurred_at).toBe('2026-06-14T12:00:01.000Z');

    const missing = await get('/v1/payments/charges/ch_00000000000000000000000000000000');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error_code).toBe('NOT_FOUND');
  });
});

/* ---------------------------------- balances ---------------------------------- */

describe('balances', () => {
  it('always has USD, with no pending money and no pending settlements', async () => {
    const response = await get('/v1/balances');
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.account_id).toBe(context.bachsKeys.organizationId);
    expect(json.account_id).toMatch(/^acct_/);
    expect(json.balances.map((entry: { currency: string }) => entry.currency)).toEqual(['USD']);
    expect(json.balances[0].pending_balance).toBe('0.00');
    expect(json.balances[0].available_balance).toMatch(/^\d+\.\d{2}$/);
    expect(json.total_balance_usd).toBe(json.balances[0].available_balance);
    expect(json.pending_settlements_by_day).toEqual([]);
  });

  it('adds every currency the account has collected in', async () => {
    const before = (await get('/v1/balances')).json();
    await paidCheckout('4242424242424242', { currency: 'NGN', amount: '5000.00' });
    const json = (await get('/v1/balances')).json();
    expect(json.balances.map((entry: { currency: string }) => entry.currency)).toEqual(['NGN', 'USD']);
    for (const entry of json.balances) expect(entry.pending_balance).toBe('0.00');
    const ngn = json.balances.find((entry: { currency: string }) => entry.currency === 'NGN');
    expect(Number(ngn.available_balance)).toBeGreaterThan(0);
    expect(json.balances.find((entry: { currency: string }) => entry.currency === 'USD').available_balance).toBe(
      before.balances[0].available_balance,
    );
    expect(json.pending_settlements_by_day).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Bachs: products and customers through the HTTP surface a client uses.
 *
 * REST shapes from the pinned OpenAPI document (docs.bachs.io/docs/openapi/
 * openapi.json, sha256 9c2265585c2b…4810: createProduct, updateProduct,
 * listProducts, archiveProduct, createCustomer, updateCustomer,
 * listCustomers); rules from guides/products/overview, guides/customers and
 * api-reference/error-reference; webhook payloads from
 * guides/webhooks/events/customer-created and customer-updated. All read
 * 2026-10-10.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';

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
const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: auth(), payload: body as object });
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function endpoint(types: string[] = ['customer.created', 'customer.updated']) {
  const response = await post('/v1/webhooks/endpoints', {
    name: 'Local receiver',
    url: 'https://merchant.example.com/webhooks/bachs',
    event_types: types,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { endpoint_id: string; signing_secret: string };
}

async function product(body: Record<string, unknown> = {}) {
  const response = await post('/v1/products', {
    name: 'Pro plan',
    price: { currency: 'USD', amount: '29.00' },
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function customer(body: Record<string, unknown> = {}) {
  const response = await post('/v1/customers', { email: 'jane@example.com', ...body });
  expect(response.statusCode).toBe(201);
  return response.json();
}

const pathOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

function sent(type: string) {
  return transport.sent
    .map((request) => ({ request, body: JSON.parse(request.body) as Record<string, unknown> & { type: string; data: Record<string, unknown> } }))
    .filter(({ body }) => body.type === type);
}

const ADDRESS = {
  line1: '40 Yaba Road',
  line2: null,
  city: 'Lagos',
  state: 'Lagos',
  postal_code: '101245',
  country: 'NG',
};

/* -------------------------------------------------------------------------- */
/*                                   products                                 */
/* -------------------------------------------------------------------------- */

describe('products: create', () => {
  it('returns a ProductResponse in the key order of the spec example', async () => {
    const response = await post('/v1/products', {
      name: 'Pro Plan',
      description: 'Full access, billed monthly.',
      price: { currency: 'USD', price_type: 'fixed', amount: '29.00' },
      billing_cycle: { interval: 'month', frequency: 1 },
      metadata: { tier: 'pro' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body)).toEqual([
      'id',
      'organization_id',
      'name',
      'description',
      'price',
      'prices',
      'billing_cycle',
      'trial_period',
      'status',
      'metadata',
      'media',
      'actor_id',
      'total_payments',
      'total_amount',
      'created_at',
      'updated_at',
      'archived_at',
    ]);
    expect(body.id).toMatch(/^prod_[0-9a-f]+$/);
    expect(body.organization_id).toMatch(/^acct_[0-9A-Za-z]{16}$/);
    expect(typeof body.actor_id).toBe('string');
    expect(body).toMatchObject({
      name: 'Pro Plan',
      description: 'Full access, billed monthly.',
      price: {
        currency: 'USD',
        price_type: 'fixed',
        amount: '29.00',
        preset_amount: null,
        minimum_amount: null,
        maximum_amount: null,
        currency_options: [],
      },
      prices: [{ currency: 'USD', amount: '29.00', minimum_amount: null, maximum_amount: null, is_default: true }],
      billing_cycle: { interval: 'month', frequency: 1 },
      trial_period: null,
      status: 'active',
      metadata: { tier: 'pro' },
      media: [],
      total_payments: 0,
      total_amount: '0.00',
      created_at: START,
      updated_at: START,
      archived_at: null,
    });
    expect(Object.keys(body.price)).toEqual([
      'currency',
      'price_type',
      'amount',
      'preset_amount',
      'minimum_amount',
      'maximum_amount',
      'currency_options',
    ]);

    // Retrievable as created.
    const fetched = await get(`/v1/products/${body.id}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(body);
  });

  it('lists currency options as extra prices that are not the default', async () => {
    const body = await product({
      price: { currency: 'USD', amount: '29.00', currency_options: [{ currency: 'NGN', amount: '45000.00' }] },
    });
    expect(body.prices).toEqual([
      { currency: 'USD', amount: '29.00', minimum_amount: null, maximum_amount: null, is_default: true },
      { currency: 'NGN', amount: '45000.00', minimum_amount: null, maximum_amount: null, is_default: false },
    ]);
  });
});

describe('products: price rules', () => {
  const create = (price: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    post('/v1/products', { name: 'P', price, ...extra });

  it('refuses a fixed price without an amount with the documented message', async () => {
    const response = await create({ currency: 'USD', price_type: 'fixed' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'VALIDATION_ERROR',
      detail: 'price: amount is required for a fixed price.',
    });
  });

  it('refuses a free price that carries an amount', async () => {
    const response = await create({ currency: 'USD', price_type: 'free', amount: '5.00' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('refuses a custom price that carries a fixed amount', async () => {
    const response = await create({ currency: 'USD', price_type: 'custom', amount: '5.00' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('refuses a custom price whose minimum exceeds its maximum', async () => {
    const response = await create({
      currency: 'USD',
      price_type: 'custom',
      minimum_amount: '50.00',
      maximum_amount: '10.00',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('accepts a valid custom price with bounds', async () => {
    const response = await create({
      currency: 'USD',
      price_type: 'custom',
      preset_amount: '20.00',
      minimum_amount: '5.00',
      maximum_amount: '100.00',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().price).toMatchObject({
      price_type: 'custom',
      amount: null,
      preset_amount: '20.00',
      minimum_amount: '5.00',
      maximum_amount: '100.00',
    });
  });

  it('refuses currency_options that repeat the primary currency', async () => {
    const response = await create({
      currency: 'USD',
      amount: '29.00',
      currency_options: [{ currency: 'USD', amount: '30.00' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('DUPLICATE_CURRENCY');
  });

  it('refuses a currency outside the supported set', async () => {
    const response = await create({ currency: 'GBP', amount: '29.00' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('UNSUPPORTED_CURRENCY');
  });

  it('refuses a trial on a one-time product', async () => {
    const response = await create(
      { currency: 'USD', amount: '29.00' },
      { trial_period: { interval: 'day', frequency: 7 } },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'TRIAL_REQUIRES_RECURRING',
      detail: 'A trial is only valid on a recurring product. Remove the trial or make it recurring.',
    });
  });

  it('refuses metadata with more than 20 keys', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    const response = await create({ currency: 'USD', amount: '29.00' }, { metadata });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('METADATA_LIMIT_EXCEEDED');

    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v']));
    expect((await create({ currency: 'USD', amount: '29.00' }, { metadata: twenty })).statusCode).toBe(201);
  });
});

describe('products: update', () => {
  it('replaces name, description and metadata', async () => {
    const created = await product({ description: 'old', metadata: { a: '1', b: '2' } });
    await advance('1s');
    const response = await patch(`/v1/products/${created.id}`, {
      name: 'Pro plan v2',
      description: 'new',
      metadata: { c: '3' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      name: 'Pro plan v2',
      description: 'new',
      metadata: { c: '3' },
      created_at: START,
      updated_at: '2026-06-14T12:00:01.000Z',
    });
    // Replace, not merge.
    expect(response.json().metadata).toEqual({ c: '3' });
  });

  it('leaves fields that were not sent untouched', async () => {
    const created = await product({ description: 'keep me', metadata: { a: '1' } });
    const response = await patch(`/v1/products/${created.id}`, { name: 'Renamed' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Renamed', description: 'keep me', metadata: { a: '1' } });
  });

  it('changes the amount of a fixed price', async () => {
    const created = await product();
    const response = await patch(`/v1/products/${created.id}`, { price: { amount: '39.00' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().price.amount).toBe('39.00');
    expect(response.json().prices[0].amount).toBe('39.00');
    expect((await get(`/v1/products/${created.id}`)).json().price.amount).toBe('39.00');
  });

  it('refuses an amount on a custom price', async () => {
    const created = await product({ price: { currency: 'USD', price_type: 'custom', minimum_amount: '1.00' } });
    const response = await patch(`/v1/products/${created.id}`, { price: { amount: '10.00' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('refuses to change a billing cycle once set', async () => {
    const created = await product({ billing_cycle: { interval: 'month', frequency: 1 } });
    const response = await patch(`/v1/products/${created.id}`, {
      billing_cycle: { interval: 'year', frequency: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('RECURRING_INTERVAL_IMMUTABLE');
    expect((await get(`/v1/products/${created.id}`)).json().billing_cycle).toEqual({ interval: 'month', frequency: 1 });
  });

  it('allows adding a billing cycle to a one-time product', async () => {
    const created = await product();
    expect(created.billing_cycle).toBeNull();
    const response = await patch(`/v1/products/${created.id}`, {
      billing_cycle: { interval: 'week', frequency: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().billing_cycle).toEqual({ interval: 'week', frequency: 2 });
  });

  it('answers 404 NOT_FOUND for an unknown product', async () => {
    const response = await patch('/v1/products/prod_00000000000000000000', { name: 'x' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error_code).toBe('NOT_FOUND');
    expect((await get('/v1/products/prod_00000000000000000000')).statusCode).toBe(404);
  });
});

describe('products: archive, list and totals', () => {
  it('archives and unarchives idempotently', async () => {
    const created = await product();
    await advance('1s');
    const archived = await post(`/v1/products/${created.id}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: 'archived', archived_at: '2026-06-14T12:00:01.000Z' });

    await advance('1s');
    const again = await post(`/v1/products/${created.id}/archive`);
    expect(again.statusCode).toBe(200);
    // Still the first archive instant.
    expect(again.json()).toMatchObject({ status: 'archived', archived_at: '2026-06-14T12:00:01.000Z' });

    const restored = await post(`/v1/products/${created.id}/unarchive`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ status: 'active', archived_at: null });
    const restoredAgain = await post(`/v1/products/${created.id}/unarchive`);
    expect(restoredAgain.statusCode).toBe(200);
    expect(restoredAgain.json()).toMatchObject({ status: 'active', archived_at: null });

    expect((await post('/v1/products/prod_00000000000000000000/archive')).statusCode).toBe(404);
  });

  it('lists newest first, hides archived ones unless asked, and pages by cursor', async () => {
    const a = await product({ name: 'A' });
    await advance('1s');
    const b = await product({ name: 'B' });
    await advance('1s');
    const c = await product({ name: 'C' });
    await post(`/v1/products/${b.id}/archive`);

    const listed = await get('/v1/products');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([c.id, a.id]);
    expect(listed.json().pagination).toMatchObject({ total: 2, returned: 2, has_more: false, next_cursor: null });

    const all = await get('/v1/products?include_archived=true');
    expect(all.json().items.map((item: { id: string }) => item.id)).toEqual([c.id, b.id, a.id]);

    const first = (await get('/v1/products?include_archived=true&limit=2')).json();
    expect(first.items.map((item: { id: string }) => item.id)).toEqual([c.id, b.id]);
    expect(first.pagination).toMatchObject({ has_more: true, next_cursor: 'cur_2', limit: 2, total: 3 });
    const second = (await get(`/v1/products?include_archived=true&limit=2&cursor=${first.pagination.next_cursor}`)).json();
    expect(second.items.map((item: { id: string }) => item.id)).toEqual([a.id]);
    expect(second.pagination).toMatchObject({ has_more: false, next_cursor: null, prev_cursor: 'cur_0' });
  });

  it('counts a paid checkout into total_payments and total_amount', async () => {
    const created = await product();
    const session = (
      await post('/v1/checkout-sessions', {
        product_cart: [{ product_id: created.id, quantity: 2 }],
        customer: { email: 'jane@example.com' },
      })
    ).json();
    expect(session.checkout_id).toBeDefined();

    // Not yet paid: nothing counted.
    await pagePost(`${pathOf(session.checkout_url)}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect((await get(`/v1/products/${created.id}`)).json()).toMatchObject({ total_payments: 0, total_amount: '0.00' });

    await advance('1s');
    expect((await get(`/v1/checkout-sessions/${session.checkout_id}`)).json().status).toBe('completed');
    expect((await get(`/v1/products/${created.id}`)).json()).toMatchObject({ total_payments: 1, total_amount: '58.00' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  customers                                 */
/* -------------------------------------------------------------------------- */

describe('customers: create', () => {
  it('returns a CustomerDetailResponse and fires customer.created', async () => {
    await endpoint();
    const response = await post('/v1/customers', {
      email: 'jane@example.com',
      name: 'Jane Doe',
      phone_number: '+2348012345678',
      metadata: { tier: 'vip' },
      billing_address: ADDRESS,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body)).toEqual([
      'customer_id',
      'email',
      'name',
      'phone_number',
      'metadata',
      'billing_address',
      'created_at',
      'updated_at',
    ]);
    expect(body.customer_id).toMatch(/^cust_[0-9a-f]{32}$/);
    expect(body).toEqual({
      customer_id: body.customer_id,
      email: 'jane@example.com',
      name: 'Jane Doe',
      phone_number: '+2348012345678',
      metadata: { tier: 'vip' },
      billing_address: ADDRESS,
      created_at: START,
      updated_at: START,
    });
    expect((await get(`/v1/customers/${body.customer_id}`)).json()).toEqual(body);

    await advance('0s');
    const events = sent('customer.created');
    expect(events).toHaveLength(1);
    const event = events[0]!.body;
    expect(Object.keys(event)).toEqual(['id', 'type', 'created_at', 'organization_id', 'data']);
    expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(event.organization_id).toMatch(/^acct_[0-9A-Za-z]{16}$/);
    expect(event.created_at).toBe('2026-06-14T12:00:00.000000+00:00');
    expect(event.data).toEqual({
      customer_id: body.customer_id,
      email: 'jane@example.com',
      name: 'Jane Doe',
      phone_number: '+2348012345678',
      metadata: { tier: 'vip' },
      billing_address: ADDRESS,
      created_at: '2026-06-14T12:00:00Z',
      updated_at: '2026-06-14T12:00:00Z',
    });
    expect(Object.keys(event.data)).toEqual([
      'customer_id',
      'email',
      'name',
      'phone_number',
      'metadata',
      'billing_address',
      'created_at',
      'updated_at',
    ]);
    expect(sent('customer.updated')).toHaveLength(0);
  });

  it('defaults optional fields to null and empty metadata', async () => {
    const body = await customer();
    expect(body).toMatchObject({
      email: 'jane@example.com',
      name: null,
      phone_number: null,
      metadata: {},
      billing_address: null,
    });
  });

  it('matches an existing email: same customer, changes applied, customer.updated not customer.created', async () => {
    await endpoint();
    const first = await customer({ name: 'Jane Doe', phone_number: '+2348012345678' });
    await advance('1s');
    transport.sent.length = 0;

    const second = await post('/v1/customers', { email: 'jane@example.com', name: 'Jane Smith' });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({
      customer_id: first.customer_id,
      name: 'Jane Smith',
      // Not sent, so kept.
      phone_number: '+2348012345678',
      created_at: START,
      updated_at: '2026-06-14T12:00:01.000Z',
    });
    await advance('0s');
    expect(sent('customer.created')).toHaveLength(0);
    const updated = sent('customer.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body.data).toMatchObject({
      customer_id: first.customer_id,
      name: 'Jane Smith',
      updated_at: '2026-06-14T12:00:01Z',
    });

    const list = (await get('/v1/customers')).json();
    expect(list.items).toHaveLength(1);
  });

  it('refuses an all-empty address and an address without line1 or country', async () => {
    const empty = await post('/v1/customers', { email: 'a@example.com', billing_address: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error_code).toBe('VALIDATION_ERROR');

    const nulls = await post('/v1/customers', {
      email: 'a@example.com',
      billing_address: { line1: null, city: null, country: null },
    });
    expect(nulls.statusCode).toBe(400);

    const noLine1 = await post('/v1/customers', { email: 'a@example.com', billing_address: { city: 'Lagos', country: 'NG' } });
    expect(noLine1.statusCode).toBe(400);
    expect(noLine1.json().error_code).toBe('VALIDATION_ERROR');

    const noCountry = await post('/v1/customers', { email: 'a@example.com', billing_address: { line1: '40 Yaba Road' } });
    expect(noCountry.statusCode).toBe(400);
    expect(noCountry.json().error_code).toBe('VALIDATION_ERROR');

    expect((await get('/v1/customers')).json().items).toHaveLength(0);
  });
});

describe('customers: update', () => {
  it('changes only the fields sent and fires customer.updated', async () => {
    await endpoint();
    const created = await customer({ name: 'Jane Doe', phone_number: '+2348012345678', metadata: { a: '1' }, billing_address: ADDRESS });
    await advance('1s');
    transport.sent.length = 0;

    const response = await patch(`/v1/customers/${created.customer_id}`, { phone_number: '+2348099999999' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...created,
      phone_number: '+2348099999999',
      updated_at: '2026-06-14T12:00:01.000Z',
    });
    await advance('0s');
    const updated = sent('customer.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body.data).toEqual({
      customer_id: created.customer_id,
      email: 'jane@example.com',
      name: 'Jane Doe',
      phone_number: '+2348099999999',
      metadata: { a: '1' },
      billing_address: ADDRESS,
      created_at: '2026-06-14T12:00:00Z',
      updated_at: '2026-06-14T12:00:01Z',
    });
    expect(updated[0]!.body.created_at).toBe('2026-06-14T12:00:01.000000+00:00');
  });

  it('replaces the billing address rather than merging it', async () => {
    const created = await customer({ billing_address: ADDRESS });
    const response = await patch(`/v1/customers/${created.customer_id}`, {
      billing_address: { line1: '1 Marina', country: 'NG' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().billing_address).toEqual({
      line1: '1 Marina',
      line2: null,
      city: null,
      state: null,
      postal_code: null,
      country: 'NG',
    });
  });

  it('leaves the address alone when omitted and clears it on null', async () => {
    const created = await customer({ billing_address: ADDRESS });
    const untouched = await patch(`/v1/customers/${created.customer_id}`, { name: 'Jane' });
    expect(untouched.json().billing_address).toEqual(ADDRESS);
    const cleared = await patch(`/v1/customers/${created.customer_id}`, { billing_address: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().billing_address).toBeNull();
    expect((await get(`/v1/customers/${created.customer_id}`)).json().billing_address).toBeNull();
  });

  it('refuses an all-empty or incomplete address on update', async () => {
    const created = await customer({ billing_address: ADDRESS });
    expect((await patch(`/v1/customers/${created.customer_id}`, { billing_address: {} })).statusCode).toBe(400);
    expect(
      (await patch(`/v1/customers/${created.customer_id}`, { billing_address: { line1: '1 Marina' } })).statusCode,
    ).toBe(400);
    expect(
      (await patch(`/v1/customers/${created.customer_id}`, { billing_address: { country: 'NG' } })).statusCode,
    ).toBe(400);
    expect((await get(`/v1/customers/${created.customer_id}`)).json().billing_address).toEqual(ADDRESS);
  });

  it("refuses another customer's email with 409 CONFLICT", async () => {
    await customer({ email: 'ada@example.com' });
    const jane = await customer({ email: 'jane@example.com' });
    const response = await patch(`/v1/customers/${jane.customer_id}`, { email: 'ada@example.com' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('CONFLICT');
    expect((await get(`/v1/customers/${jane.customer_id}`)).json().email).toBe('jane@example.com');

    // Its own email is not a conflict.
    expect((await patch(`/v1/customers/${jane.customer_id}`, { email: 'jane@example.com' })).statusCode).toBe(200);
  });

  it('answers 404 for an unknown customer', async () => {
    const id = 'cust_00000000000000000000000000000000';
    const fetched = await get(`/v1/customers/${id}`);
    expect(fetched.statusCode).toBe(404);
    expect(fetched.json().error_code).toBe('NOT_FOUND');
    expect((await patch(`/v1/customers/${id}`, { name: 'x' })).statusCode).toBe(404);
  });
});

describe('customers: list', () => {
  it('pages 50 by default with CustomerListItem shapes, newest first', async () => {
    const ada = await customer({ email: 'ada@example.com', name: 'Ada Lovelace', phone_number: '+2348012345678', metadata: { tier: 'vip' }, billing_address: ADDRESS });
    await advance('1s');
    const jane = await customer({ email: 'jane@example.com', name: 'Jane Doe' });

    const response = await get('/v1/customers');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['items', 'pagination']);
    expect(body.pagination).toMatchObject({ limit: 50, offset: 0, returned: 2, total: 2, has_more: false });
    expect(body.items.map((item: { customer_id: string }) => item.customer_id)).toEqual([jane.customer_id, ada.customer_id]);
    expect(body.items[1]).toEqual({
      customer_id: ada.customer_id,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      metadata: { tier: 'vip' },
      created_at: START,
    });
  });

  it('searches by email and by name', async () => {
    const ada = await customer({ email: 'ada@example.com', name: 'Ada Lovelace' });
    const jane = await customer({ email: 'jane@example.com', name: 'Jane Doe' });

    const ids = async (search: string) =>
      (await get(`/v1/customers?search=${encodeURIComponent(search)}`))
        .json()
        .items.map((item: { customer_id: string }) => item.customer_id);

    expect(await ids('ada@example.com')).toEqual([ada.customer_id]);
    expect(await ids('jane@')).toEqual([jane.customer_id]);
    expect(await ids('Lovelace')).toEqual([ada.customer_id]);
    expect(await ids('jane')).toEqual([jane.customer_id]);
    // "Search by customer email or name": the full name is a name.
    expect(await ids('Jane Doe')).toEqual([jane.customer_id]);
    expect(await ids('nobody')).toEqual([]);
  });
});

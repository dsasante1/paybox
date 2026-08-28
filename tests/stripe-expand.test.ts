import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * `expand[]` (docs.stripe.com/api/expanding_objects, read 2026-08-28).
 *
 * The parameter is only useful if it works everywhere, so these assert the
 * mechanism -- object, list, nesting, depth ceiling -- rather than one route.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-03-01T10:00:00.000Z';
  process.env.PAYBOX_SEED = 'expand';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  return params.toString();
}

const post = (url: string, fields: Record<string, string | number> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });

const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

async function intentWithCustomer() {
  const customer = (await post('/stripe/v1/customers', { email: 'ada@example.com' })).json();
  const intent = (
    await post('/stripe/v1/payment_intents', {
      amount: 5_000,
      currency: 'usd',
      customer: customer.id,
    })
  ).json();
  return { customer, intent };
}

describe('expand[] on a single object', () => {
  it('replaces an id string with the object it names', async () => {
    const { customer, intent } = await intentWithCustomer();
    expect(intent.customer).toBe(customer.id);

    const expanded = (await get(`/stripe/v1/payment_intents/${intent.id}?expand[]=customer`)).json();

    expect(expanded.customer).toMatchObject({
      id: customer.id,
      object: 'customer',
      email: 'ada@example.com',
    });
  });

  it('leaves every other field untouched', async () => {
    const { intent } = await intentWithCustomer();
    const plain = (await get(`/stripe/v1/payment_intents/${intent.id}`)).json();
    const expanded = (await get(`/stripe/v1/payment_intents/${intent.id}?expand[]=customer`)).json();

    expect({ ...expanded, customer: null }).toEqual({ ...plain, customer: null });
  });

  it('honours expand sent in a POST body, not only the query string', async () => {
    const customer = (await post('/stripe/v1/customers', { email: 'grace@example.com' })).json();
    const created = await post('/stripe/v1/payment_intents', {
      amount: 2_500,
      currency: 'usd',
      customer: customer.id,
      'expand[]': 'customer',
    });

    expect(created.json().customer).toMatchObject({ id: customer.id, object: 'customer' });
  });

  it('accepts the indexed form expand[0] as well as expand[]', async () => {
    const { customer, intent } = await intentWithCustomer();
    const expanded = (await get(`/stripe/v1/payment_intents/${intent.id}?expand[0]=customer`)).json();
    expect(expanded.customer).toMatchObject({ id: customer.id });
  });

  it('is a no-op when the field is null', async () => {
    const intent = (
      await post('/stripe/v1/payment_intents', { amount: 900, currency: 'usd' })
    ).json();
    const expanded = (await get(`/stripe/v1/payment_intents/${intent.id}?expand[]=customer`)).json();
    expect(expanded.customer).toBeNull();
  });

  it('leaves the id in place when it names nothing', async () => {
    const { intent } = await intentWithCustomer();
    await context.storage.customers.update(intent.customer.replace('cus_', 'cus_'), {});
    // A field paybox does not model at all is simply skipped rather than 400.
    const expanded = (
      await get(`/stripe/v1/payment_intents/${intent.id}?expand[]=application`)
    ).json();
    expect(expanded.id).toBe(intent.id);
  });
});

describe('expand[] on a list', () => {
  it('expands data.customer for every row', async () => {
    await intentWithCustomer();
    await intentWithCustomer();

    const listed = (await get('/stripe/v1/payment_intents?expand[]=data.customer')).json();

    expect(listed.data.length).toBeGreaterThanOrEqual(2);
    for (const row of listed.data) {
      expect(row.customer).toMatchObject({ object: 'customer', email: 'ada@example.com' });
    }
  });

  it('leaves the list envelope alone', async () => {
    await intentWithCustomer();
    const listed = (await get('/stripe/v1/payment_intents?expand[]=data.customer')).json();
    expect(listed.object).toBe('list');
    expect(listed.url).toBe('/v1/payment_intents');
    expect(listed.has_more).toBe(false);
  });
});

describe('expand[] nesting', () => {
  it('expands two levels down', async () => {
    const customer = (await post('/stripe/v1/customers', { email: 'ada@example.com' })).json();
    // `latest_charge` is only populated once an instrument is attached, which
    // is what makes this a genuine two-level walk rather than a null no-op.
    const intent = (
      await post('/stripe/v1/payment_intents', {
        amount: 5_000,
        currency: 'usd',
        customer: customer.id,
        'payment_method_data[type]': 'card',
        'payment_method_data[card][number]': '4242424242424242',
      })
    ).json();
    // charge.customer, reached through the intent's latest_charge.
    const expanded = (
      await get(`/stripe/v1/payment_intents/${intent.id}?expand[]=latest_charge.customer`)
    ).json();

    expect(expanded.latest_charge).toMatchObject({ object: 'charge' });
    expect(expanded.latest_charge.customer).toMatchObject({ id: customer.id });
  });

  it('refuses more than four levels, as Stripe does', async () => {
    const { intent } = await intentWithCustomer();
    const response = await get(
      `/stripe/v1/payment_intents/${intent.id}?expand[]=a.b.c.d.e`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe('invalid_request_error');
    expect(response.json().error.message).toContain('4 levels');
  });
});

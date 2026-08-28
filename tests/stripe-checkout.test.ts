import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { EMULATOR_BANNER } from '@paybox/shared';

/**
 * Stripe Checkout Sessions and the hosted page.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json`, read
 * 2026-08-28: `status` is open|complete|expired and `payment_status` is
 * unpaid|paid|no_payment_required.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'checkout';
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

const auth = { authorization: 'Bearer sk_test_local_suite' };

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  return params.toString();
}

async function post(url: string, fields: Record<string, string | number>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

const SESSION = {
  mode: 'payment',
  success_url: 'https://shop.example/done',
  cancel_url: 'https://shop.example/cart',
  'line_items[0][price_data][currency]': 'usd',
  'line_items[0][price_data][unit_amount]': '2000',
  'line_items[0][price_data][product_data][name]': 'A very nice hat',
  'line_items[0][quantity]': '2',
};

async function createSession(extra: Record<string, string> = {}) {
  return post('/stripe/v1/checkout/sessions', { ...SESSION, ...extra });
}

describe('creating a session', () => {
  it('totals the line items and opens the session', async () => {
    const res = await createSession();

    expect(res.statusCode).toBe(200);
    const cs = res.json();
    expect(cs.object).toBe('checkout.session');
    expect(cs.id).toMatch(/^cs_/);
    expect(cs.status).toBe('open');
    expect(cs.payment_status).toBe('unpaid');
    // 2000 x 2
    expect(cs.amount_total).toBe(4000);
    expect(cs.currency).toBe('usd');
    expect(cs.success_url).toBe('https://shop.example/done');
    expect(cs.url).toContain(cs.id);
    expect(cs.payment_intent).toMatch(/^pi_/);
    expect(typeof cs.expires_at).toBe('number');
  });

  it('lists its line items', async () => {
    const cs = (await createSession()).json();
    const items = (await get(`/stripe/v1/checkout/sessions/${cs.id}/line_items`)).json();

    expect(items.object).toBe('list');
    expect(items.data).toHaveLength(1);
    expect(items.data[0].description).toBe('A very nice hat');
    expect(items.data[0].quantity).toBe(2);
    expect(items.data[0].amount_total).toBe(4000);
  });

  it('refuses setup mode, which needs SetupIntents', async () => {
    const res = await createSession({ mode: 'setup' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mode=setup/);
  });

  it('refuses a line item with neither price nor price_data', async () => {
    const res = await post('/stripe/v1/checkout/sessions', {
      mode: 'payment',
      success_url: 'https://shop.example/done',
      'line_items[0][quantity]': '1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a real price id', async () => {
    const price = (
      await post('/stripe/v1/prices', {
        currency: 'usd',
        unit_amount: 1500,
        'recurring[interval]': 'month',
        'product_data[name]': 'Pro plan',
      })
    ).json();

    const res = await post('/stripe/v1/checkout/sessions', {
      mode: 'payment',
      success_url: 'https://shop.example/done',
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': '2',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount_total).toBe(3000);
  });

  it('refuses a subscription session with no recurring price', async () => {
    const res = await createSession({ mode: 'subscription' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/recurring `price`/);
  });

  it('refuses line items in mixed currencies', async () => {
    const res = await post('/stripe/v1/checkout/sessions', {
      mode: 'payment',
      success_url: 'https://shop.example/done',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '1000',
      'line_items[1][price_data][currency]': 'ngn',
      'line_items[1][price_data][unit_amount]': '1000',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/one currency/);
  });
});

describe('the hosted page', () => {
  it('serves a page carrying the safety banner', async () => {
    const cs = (await createSession()).json();
    const page = await app.inject({ method: 'GET', url: new URL(cs.url).pathname });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    // §29: every hosted page must say it is an emulator.
    expect(page.body).toContain(EMULATOR_BANNER);
    expect(page.body).toContain('A very nice hat');
    expect(page.body).toContain('4242 4242 4242 4242');
  });

  it('needs no API key, because the payer visits it', async () => {
    const cs = (await createSession()).json();
    const page = await app.inject({ method: 'GET', url: new URL(cs.url).pathname });
    expect(page.statusCode).toBe(200);
  });

  it('pays through the form and completes the session', async () => {
    const cs = (await createSession()).json();
    const path = new URL(cs.url).pathname;

    const paid = await app.inject({
      method: 'POST',
      url: `${path}/pay`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ card_number: '4242 4242 4242 4242', exp_month: '12', exp_year: '2034' }),
    });
    expect(paid.statusCode).toBe(200);
    // The result page sends the payer on to success_url.
    expect(paid.body).toContain('https://shop.example/done');

    await advance('30s');
    const settled = (await get(`/stripe/v1/checkout/sessions/${cs.id}`)).json();
    expect(settled.status).toBe('complete');
    expect(settled.payment_status).toBe('paid');
    // A finished session has no page left to visit.
    expect(settled.url).toBeNull();
  });

  it('declines through the form too', async () => {
    const cs = (await createSession()).json();
    const path = new URL(cs.url).pathname;

    await app.inject({
      method: 'POST',
      url: `${path}/pay`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ card_number: '4000 0000 0000 0002' }),
    });
    await advance('30s');

    const cs2 = (await get(`/stripe/v1/checkout/sessions/${cs.id}`)).json();
    // The session stays open: Stripe lets the payer try another card.
    expect(cs2.status).toBe('open');
    expect(cs2.payment_status).toBe('unpaid');
  });

  it('404s for an unknown session', async () => {
    const page = await app.inject({ method: 'GET', url: '/stripe/checkout/cs_nope' });
    expect(page.statusCode).toBe(404);
  });
});

describe('expiry', () => {
  it('expires on demand and closes the page', async () => {
    const cs = (await createSession()).json();
    const res = await post(`/stripe/v1/checkout/sessions/${cs.id}/expire`, {});

    expect(res.json().status).toBe('expired');
    expect(res.json().url).toBeNull();

    const page = await app.inject({ method: 'GET', url: `/stripe/checkout/${cs.id}` });
    expect(page.statusCode).toBe(410);
  });

  it('expires on its own when virtual time passes the window', async () => {
    const cs = (await createSession()).json();
    expect((await get(`/stripe/v1/checkout/sessions/${cs.id}`)).json().status).toBe('open');

    // Stripe expires an unpaid session after 24 hours.
    await advance('25h');

    expect((await get(`/stripe/v1/checkout/sessions/${cs.id}`)).json().status).toBe('expired');
  });

  it('refuses to expire a session that has been paid', async () => {
    const cs = (await createSession()).json();
    await app.inject({
      method: 'POST',
      url: `${new URL(cs.url).pathname}/pay`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ card_number: '4242424242424242' }),
    });
    await advance('30s');

    const res = await post(`/stripe/v1/checkout/sessions/${cs.id}/expire`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/already been paid/);
  });
});

describe('webhooks', () => {
  async function withEndpoint(eventTypes: string[] = []) {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: {
        url: 'http://localhost:9999/hook',
        provider: 'stripe',
        secret: 'whsec_x',
        eventTypes,
      },
    });
  }

  function events() {
    return transport.sent.map((r) => JSON.parse(r.body) as { type: string; data: { object: Record<string, unknown> } });
  }

  it('sends checkout.session.completed alongside the intent and charge', async () => {
    await withEndpoint();
    const cs = (await createSession()).json();
    await app.inject({
      method: 'POST',
      url: `${new URL(cs.url).pathname}/pay`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ card_number: '4242424242424242' }),
    });
    await advance('30s');

    const types = events().map((e) => e.type);
    expect(types).toContain('checkout.session.completed');
    expect(types).toContain('payment_intent.succeeded');

    const completed = events().find((e) => e.type === 'checkout.session.completed')!;
    expect(completed.data.object.object).toBe('checkout.session');
    expect(completed.data.object.payment_status).toBe('paid');
  });

  it('does not send a session event for a payment that had no session', async () => {
    await withEndpoint();
    // A plain PaymentIntent, created outside Checkout.
    await post('/stripe/v1/payment_intents', {
      amount: 2000,
      currency: 'usd',
      confirm: 'true',
      'payment_method_data[card][number]': '4242424242424242',
    });
    await advance('30s');

    const types = events().map((e) => e.type);
    expect(types).toContain('payment_intent.succeeded');
    expect(types).not.toContain('checkout.session.completed');
  });

  it('sends checkout.session.expired when the window passes', async () => {
    await withEndpoint();
    await createSession();
    await advance('25h');

    expect(events().map((e) => e.type)).toContain('checkout.session.expired');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { addInterval } from '@paybox/core';

/**
 * Stripe billing: Products, Prices, Subscriptions, Invoices.
 *
 * The real question this answers is whether the recurring machinery built for
 * Paystack is provider-neutral. Shapes verified against `stripe/openapi`
 * `openapi/spec3.json`, read 2026-08-28.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-01-15T09:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'billing';
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

async function post(url: string, fields: Record<string, string | number> = {}) {
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

/** A customer with a reusable card attached, ready to subscribe. */
async function customerWithCard() {
  const customer = (await post('/stripe/v1/customers', { email: 'ada@example.com' })).json();
  const pm = (
    await post('/stripe/v1/payment_methods', {
      type: 'card',
      'card[number]': '4242424242424242',
      'card[exp_month]': '12',
      'card[exp_year]': '2034',
    })
  ).json();
  await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
  return { customerId: customer.id as string, paymentMethodId: pm.id as string };
}

async function monthlyPrice(unitAmount = 1500, intervalCount = 1) {
  const res = await post('/stripe/v1/prices', {
    currency: 'usd',
    unit_amount: unitAmount,
    'recurring[interval]': 'month',
    'recurring[interval_count]': intervalCount,
    'product_data[name]': 'Pro plan',
  });
  return res;
}

describe('products and prices', () => {
  it('creates a product', async () => {
    const res = await post('/stripe/v1/products', { name: 'Pro plan', description: 'Nice' });
    expect(res.json().object).toBe('product');
    expect(res.json().id).toMatch(/^prod_/);
    expect(res.json().name).toBe('Pro plan');
  });

  it('creates a recurring price with inline product data', async () => {
    const res = await monthlyPrice();
    expect(res.json().object).toBe('price');
    expect(res.json().id).toMatch(/^price_/);
    expect(res.json().unit_amount).toBe(1500);
    expect(res.json().currency).toBe('usd');
    expect(res.json().type).toBe('recurring');
    expect(res.json().recurring.interval).toBe('month');
    expect(res.json().recurring.interval_count).toBe(1);
    expect(res.json().product).toMatch(/^prod_/);
  });

  it('carries interval_count through, which Paystack cannot express', async () => {
    const res = await monthlyPrice(1500, 3);
    expect(res.json().recurring.interval_count).toBe(3);
  });

  it('refuses a one-off price rather than modelling it as a plan', async () => {
    const res = await post('/stripe/v1/prices', {
      currency: 'usd',
      unit_amount: 1500,
      'product_data[name]': 'One-off',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/recurring prices only/);
  });
});

describe('subscribing', () => {
  it('needs a payment method', async () => {
    const customer = (await post('/stripe/v1/customers', { email: 'nocard@example.com' })).json();
    const price = (await monthlyPrice()).json();

    const res = await post('/stripe/v1/subscriptions', {
      customer: customer.id,
      'items[0][price]': price.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/No default payment method/);
  });

  it('creates an active subscription and bills the first period', async () => {
    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice()).json();

    const res = await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': price.id,
    });
    expect(res.statusCode).toBe(200);
    const sub = res.json();
    expect(sub.object).toBe('subscription');
    expect(sub.id).toMatch(/^sub_/);
    expect(sub.status).toBe('active');
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.items.data[0].price.id).toBe(price.id);

    await advance('1m');
    const invoices = (await get('/stripe/v1/invoices')).json();
    expect(invoices.data).toHaveLength(1);
    expect(invoices.data[0].status).toBe('paid');
    expect(invoices.data[0].amount_paid).toBe(1500);
  });

  it('refuses a multi-item subscription rather than silently billing one', async () => {
    const { customerId } = await customerWithCard();
    const a = (await monthlyPrice(1000)).json();
    const b = (await monthlyPrice(2000)).json();

    const res = await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': a.id,
      'items[1][price]': b.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/one price per subscription/);
  });
});

describe('renewals over virtual time', () => {
  it('bills twelve monthly periods in a single advance', async () => {
    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice()).json();
    const sub = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': price.id,
      })
    ).json();

    await advance('360d');

    const invoices = (await get('/stripe/v1/invoices?limit=100')).json().data as Array<{
      status: string;
      period_start: number;
      amount_paid: number;
    }>;
    expect(invoices).toHaveLength(12);
    expect(invoices.every((i) => i.status === 'paid')).toBe(true);

    // Each period starts one calendar month after the last -- the same
    // property the Paystack suite pins, now proven provider-neutral.
    const starts = invoices.map((i) => i.period_start).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      const expected = Math.floor(
        Date.parse(addInterval(new Date(starts[i - 1]! * 1000).toISOString(), 'monthly')) / 1000,
      );
      expect(starts[i]).toBe(expected);
    }

    const fresh = (await get(`/stripe/v1/subscriptions/${sub.id}`)).json();
    expect(fresh.status).toBe('active');
  });

  it('honours interval_count: quarterly bills four times a year', async () => {
    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice(4500, 3)).json();
    await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': price.id,
    });

    await advance('360d');

    const invoices = (await get('/stripe/v1/invoices?limit=100')).json().data;
    // Jan, Apr, Jul, Oct -- four, not twelve.
    expect(invoices).toHaveLength(4);
  });
});

describe('cancelling', () => {
  async function activeSubscription() {
    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice()).json();
    const sub = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': price.id,
      })
    ).json();
    return sub.id as string;
  }

  it('cancel_at_period_end is a flag on an active subscription, not a status', async () => {
    const id = await activeSubscription();
    const res = await post(`/stripe/v1/subscriptions/${id}`, { cancel_at_period_end: 'true' });

    // Stripe keeps the status active and sets the flag.
    expect(res.json().status).toBe('active');
    expect(res.json().cancel_at_period_end).toBe(true);
  });

  it('stops renewing once the flag is set', async () => {
    const id = await activeSubscription();
    await advance('1m');
    const before = (await get('/stripe/v1/invoices?limit=100')).json().data.length;

    await post(`/stripe/v1/subscriptions/${id}`, { cancel_at_period_end: 'true' });
    await advance('365d');

    expect((await get('/stripe/v1/invoices?limit=100')).json().data).toHaveLength(before);
  });

  it('DELETE cancels immediately', async () => {
    const id = await activeSubscription();
    const res = await app.inject({ method: 'DELETE', url: `/stripe/v1/subscriptions/${id}`, headers: auth });

    expect(res.json().status).toBe('canceled');
    expect(typeof res.json().canceled_at).toBe('number');
  });
});

describe('failed renewals', () => {
  it('moves the subscription to past_due and leaves the invoice open', async () => {
    // A PaymentMethod can be created without ever succeeding at a charge, so
    // a declining card can back a subscription. A stored method retains only
    // its last four, so the outcome comes from the suffix convention rather
    // than the provider's full-number table -- `0002` declines.
    const customer = (await post('/stripe/v1/customers', { email: 'dunning@example.com' })).json();
    const pm = (
      await post('/stripe/v1/payment_methods', {
        type: 'card',
        'card[number]': '4000000000000002',
      })
    ).json();
    await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
    const price = (await monthlyPrice()).json();

    const sub = (
      await post('/stripe/v1/subscriptions', {
        customer: customer.id,
        'items[0][price]': price.id,
        default_payment_method: pm.id,
      })
    ).json();

    await advance('1m');

    const fresh = (await get(`/stripe/v1/subscriptions/${sub.id}`)).json();
    expect(fresh.status).toBe('past_due');

    const invoices = (await get('/stripe/v1/invoices')).json().data;
    // Stripe keeps a failed invoice open, because it keeps retrying.
    expect(invoices[0].status).toBe('open');
    expect(invoices[0].paid).toBe(false);
  });
});

describe('webhooks', () => {
  it('sends the subscription and invoice events Stripe sends', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/hook', provider: 'stripe', secret: 'whsec_x' },
    });

    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice()).json();
    await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': price.id,
    });
    await advance('1m');

    const types = transport.sent.map((r) => (JSON.parse(r.body) as { type: string }).type);
    expect(types).toContain('customer.subscription.created');
    expect(types).toContain('invoice.created');
    expect(types).toContain('invoice.paid');
  });

  it('carries the subscription object on its event', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/hook', provider: 'stripe', secret: 'whsec_x' },
    });
    const { customerId } = await customerWithCard();
    const price = (await monthlyPrice()).json();
    await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': price.id,
    });
    await advance('1s');

    const event = transport.sent
      .map((r) => JSON.parse(r.body) as { type: string; data: { object: Record<string, unknown> } })
      .find((e) => e.type === 'customer.subscription.created')!;
    expect(event.data.object.object).toBe('subscription');
    expect(event.data.object.status).toBe('active');
  });
});

describe('subscription mode on Checkout', () => {
  it('starts a renewing subscription once the session is paid', async () => {
    const price = (await monthlyPrice(1500)).json();
    const customer = (await post('/stripe/v1/customers', { email: 'cs@example.com' })).json();

    const cs = (
      await post('/stripe/v1/checkout/sessions', {
        mode: 'subscription',
        success_url: 'https://shop.example/done',
        customer: customer.id,
        'line_items[0][price]': price.id,
        'line_items[0][quantity]': '1',
      })
    ).json();
    expect(cs.mode).toBe('subscription');
    expect(cs.amount_total).toBe(1500);

    await app.inject({
      method: 'POST',
      url: `${new URL(cs.url).pathname}/pay`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ card_number: '4242424242424242' }),
    });
    await advance('30s');

    const subs = (await get('/stripe/v1/subscriptions')).json().data;
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('active');

    // The session's own payment covered the first period, so the subscription
    // is anchored a month out rather than billing the payer twice.
    const invoicesNow = (await get('/stripe/v1/invoices?limit=100')).json().data;
    expect(invoicesNow).toHaveLength(0);

    await advance('35d');
    expect((await get('/stripe/v1/invoices?limit=100')).json().data.length).toBeGreaterThan(0);
  });
});

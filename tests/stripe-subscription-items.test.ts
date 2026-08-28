import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Multi-item subscriptions, trials and proration.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28); event names against the same spec's
 * webhook list.
 *
 * The proration assertions are exact rather than approximate, which is only
 * possible because the clock is frozen: half a month left really is half.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

/** The 1st, so a month is a clean 31 days and half of it is unambiguous. */
const START = '2026-01-01T00:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'subitems';
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

const post = (url: string, fields: Record<string, string | number> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });

const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

const del = (url: string, fields: Record<string, string | number> = {}) =>
  app.inject({
    method: 'DELETE',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function customerWithCard() {
  const customer = (await post('/stripe/v1/customers', { email: 'ada@example.com' })).json();
  const pm = (
    await post('/stripe/v1/payment_methods', {
      type: 'card',
      'card[number]': '4242424242424242',
    })
  ).json();
  await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
  return customer.id as string;
}

async function price(amount: number, name: string, interval = 'month', count = 1) {
  return (
    await post('/stripe/v1/prices', {
      currency: 'usd',
      unit_amount: amount,
      'product_data[name]': name,
      'recurring[interval]': interval,
      'recurring[interval_count]': count,
    })
  ).json();
}

async function endpoint() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: {
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_x',
      eventTypes: [],
    },
  });
}

const deliveredTypes = () =>
  transport.sent.map((request) => JSON.parse(request.body).type as string);

describe('multi-item subscriptions', () => {
  it('bills the sum of every price', async () => {
    const customerId = await customerWithCard();
    const base = await price(1_000, 'Base');
    const seats = await price(500, 'Seats');

    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': base.id,
        'items[1][price]': seats.id,
        'items[1][quantity]': 3,
      })
    ).json();

    expect(subscription.items.data).toHaveLength(2);
    expect(subscription.items.data[0].price.unit_amount).toBe(1_000);
    expect(subscription.items.data[1].quantity).toBe(3);

    // The first cycle is due immediately, so any advance drains it. (`m` is
    // minutes in paybox's duration parser -- a month is `31d`.)
    await advance('1m');
    const invoice = (await get('/stripe/v1/invoices')).json().data[0];
    // 1000 + 500 x 3
    expect(invoice.amount_due).toBe(2_500);
    expect(invoice.lines.data).toHaveLength(2);
    expect(invoice.lines.data.map((l: { description: string }) => l.description)).toEqual([
      'Base',
      'Seats',
    ]);
  });

  it('refuses prices that disagree about the billing cycle', async () => {
    const customerId = await customerWithCard();
    const monthly = await price(1_000, 'Monthly', 'month');
    const yearly = await price(9_000, 'Yearly', 'year');

    const response = await post('/stripe/v1/subscriptions', {
      customer: customerId,
      'items[0][price]': monthly.id,
      'items[1][price]': yearly.id,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('share a billing interval');
  });

  it('lists the items on their own route', async () => {
    const customerId = await customerWithCard();
    const base = await price(1_000, 'Base');
    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': base.id,
      })
    ).json();

    const items = (await get(`/stripe/v1/subscription_items?subscription=${subscription.id}`)).json();
    expect(items.object).toBe('list');
    expect(items.data).toHaveLength(1);
    expect(items.data[0].id).toMatch(/^si_/);
  });
});

describe('adding and removing prices', () => {
  async function subscribed() {
    const customerId = await customerWithCard();
    const base = await price(1_000, 'Base');
    const addon = await price(600, 'Add-on');
    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': base.id,
      })
    ).json();
    return { customerId, base, addon, subscription };
  }

  it('adds a price through /v1/subscription_items', async () => {
    const { addon, subscription } = await subscribed();
    const item = (
      await post('/stripe/v1/subscription_items', {
        subscription: subscription.id,
        price: addon.id,
        quantity: 2,
      })
    ).json();

    expect(item).toMatchObject({ object: 'subscription_item', quantity: 2 });
    const read = (await get(`/stripe/v1/subscriptions/${subscription.id}`)).json();
    expect(read.items.data).toHaveLength(2);
  });

  it('removes one', async () => {
    const { addon, subscription } = await subscribed();
    const item = (
      await post('/stripe/v1/subscription_items', {
        subscription: subscription.id,
        price: addon.id,
      })
    ).json();

    const deleted = (await del(`/stripe/v1/subscription_items/${item.id}`)).json();
    expect(deleted).toMatchObject({ deleted: true });

    const read = (await get(`/stripe/v1/subscriptions/${subscription.id}`)).json();
    expect(read.items.data).toHaveLength(1);
  });

  it('refuses to remove the last one', async () => {
    const { subscription } = await subscribed();
    const items = (await get(`/stripe/v1/subscription_items?subscription=${subscription.id}`)).json();

    const response = await del(`/stripe/v1/subscription_items/${items.data[0].id}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Cancel the subscription instead');
  });

  it('changes the billed total when quantity changes', async () => {
    const { subscription } = await subscribed();
    // Bill the first cycle at the original quantity first, so the assertion is
    // about the *next* cycle rather than about ordering.
    await advance('1m');
    expect((await get('/stripe/v1/invoices')).json().data[0].amount_due).toBe(1_000);

    const items = (await get(`/stripe/v1/subscription_items?subscription=${subscription.id}`)).json();
    await post(`/stripe/v1/subscription_items/${items.data[0].id}`, {
      quantity: 4,
      proration_behavior: 'none',
    });

    await advance('31d');
    const invoice = (await get('/stripe/v1/invoices')).json().data[0];
    expect(invoice.amount_due).toBe(4_000);
  });
});

describe('proration', () => {
  async function halfwayThroughAMonth() {
    const customerId = await customerWithCard();
    const cheap = await price(1_000, 'Basic');
    const dear = await price(3_000, 'Pro');
    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': cheap.id,
      })
    ).json();

    // The first period runs 1 Jan to 1 Feb (31 days). Move to the 16th, so
    // 16 of 31 days remain -- an exact fraction, because the clock is frozen.
    await advance('15d');
    const items = (await get(`/stripe/v1/subscription_items?subscription=${subscription.id}`)).json();
    return { customerId, cheap, dear, subscription, itemId: items.data[0].id as string };
  }

  it('credits the unused time and charges the remainder', async () => {
    const { dear, itemId, customerId } = await halfwayThroughAMonth();

    await post(`/stripe/v1/subscription_items/${itemId}`, { price: dear.id });

    const pending = (await get(`/stripe/v1/invoiceitems?customer=${customerId}&pending=true`)).json();
    const lines = pending.data as { amount: number; description: string; proration: boolean }[];

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.proration)).toBe(true);

    // 16 of 31 days remain: 1000 x 16/31 = 516, 3000 x 16/31 = 1548.
    const credit = lines.find((line) => line.amount < 0);
    const charge = lines.find((line) => line.amount > 0);
    expect(credit?.amount).toBe(-516);
    expect(credit?.description).toBe('Unused time on Basic');
    expect(charge?.amount).toBe(1_548);
    expect(charge?.description).toBe('Remaining time on Pro');
  });

  it('lands the prorations on the next invoice', async () => {
    const { dear, itemId } = await halfwayThroughAMonth();
    await post(`/stripe/v1/subscription_items/${itemId}`, { price: dear.id });

    await advance('20d');

    const invoice = (await get('/stripe/v1/invoices')).json().data[0];
    // A full month of Pro, plus the net proration: 3000 + 1548 - 516.
    expect(invoice.amount_due).toBe(4_032);
    expect(invoice.lines.data).toHaveLength(3);
    expect(invoice.lines.data.filter((l: { proration: boolean }) => l.proration)).toHaveLength(2);
  });

  it('charges nothing extra under proration_behavior=none', async () => {
    const { dear, itemId, customerId } = await halfwayThroughAMonth();

    await post(`/stripe/v1/subscription_items/${itemId}`, {
      price: dear.id,
      proration_behavior: 'none',
    });

    const pending = (await get(`/stripe/v1/invoiceitems?customer=${customerId}&pending=true`)).json();
    expect(pending.data).toHaveLength(0);

    // The change still took effect; only the part-period difference is waived.
    const subscription = (await get('/stripe/v1/subscriptions')).json().data[0];
    expect(subscription.items.data[0].price.unit_amount).toBe(3_000);
  });

  it('bills immediately under proration_behavior=always_invoice', async () => {
    const { dear, itemId } = await halfwayThroughAMonth();

    await post(`/stripe/v1/subscription_items/${itemId}`, {
      price: dear.id,
      proration_behavior: 'always_invoice',
    });

    const invoices = (await get('/stripe/v1/invoices')).json().data as {
      billing_reason: string;
      status: string;
      amount_due: number;
    }[];
    const immediate = invoices.find((i) => i.billing_reason === 'subscription_update');

    expect(immediate).toBeDefined();
    expect(immediate?.status).toBe('paid');
    // 1548 - 516
    expect(immediate?.amount_due).toBe(1_032);
  });

  it('voids rather than charging when a downgrade nets to a credit', async () => {
    const { cheap, dear, customerId } = await halfwayThroughAMonth();
    // Start from the expensive plan so the change is a downgrade.
    const sub = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': dear.id,
      })
    ).json();
    const items = (await get(`/stripe/v1/subscription_items?subscription=${sub.id}`)).json();

    await advance('10d');
    await post(`/stripe/v1/subscription_items/${items.data[0].id}`, {
      price: cheap.id,
      proration_behavior: 'always_invoice',
    });

    const invoices = (await get('/stripe/v1/invoices')).json().data as {
      billing_reason: string;
      status: string;
    }[];
    const immediate = invoices.find((i) => i.billing_reason === 'subscription_update');
    // Nothing is owed now, so charging zero would be a lie; it is voided.
    expect(immediate?.status).toBe('void');
  });

  it('prorates almost nothing at the very end of a period', async () => {
    const { dear, itemId, customerId } = await halfwayThroughAMonth();
    // 15 days in already; go to within an hour of the renewal.
    await advance('15d');
    await advance('23h');

    await post(`/stripe/v1/subscription_items/${itemId}`, { price: dear.id });

    const pending = (await get(`/stripe/v1/invoiceitems?customer=${customerId}&pending=true`)).json();
    const total = (pending.data as { amount: number }[]).reduce((a, b) => a + b.amount, 0);
    // Under an hour left of a 31-day month: a rounding-error's worth.
    expect(Math.abs(total)).toBeLessThan(120);
  });
});

describe('trials', () => {
  async function trialing(days = 14) {
    const customerId = await customerWithCard();
    const monthly = await price(2_000, 'Monthly');
    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': monthly.id,
        trial_period_days: days,
      })
    ).json();
    return { customerId, subscription };
  }

  it('starts trialing and bills nothing', async () => {
    const { subscription } = await trialing();

    expect(subscription.status).toBe('trialing');
    expect(subscription.trial_start).toBe(Math.floor(Date.parse(START) / 1000));
    expect(subscription.trial_end).toBe(
      Math.floor((Date.parse(START) + 14 * 24 * 60 * 60_000) / 1000),
    );
    // Billing begins when the trial ends.
    expect(subscription.current_period_end).toBe(subscription.trial_end);

    await advance('13d');
    expect((await get('/stripe/v1/invoices')).json().data).toHaveLength(0);
    expect((await context.storage.payments.list({ provider: 'stripe' })).total).toBe(0);
  });

  it('converts to active and charges when the trial ends', async () => {
    const { subscription } = await trialing();
    await advance('15d');

    const after = (await get(`/stripe/v1/subscriptions/${subscription.id}`)).json();
    expect(after.status).toBe('active');

    const invoices = (await get('/stripe/v1/invoices')).json().data;
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('paid');
    expect(invoices[0].amount_due).toBe(2_000);
  });

  it('warns three days before the trial ends, and only once', async () => {
    await endpoint();
    await trialing();

    await advance('10d');
    expect(deliveredTypes()).not.toContain('customer.subscription.trial_will_end');

    await advance('2d');
    const warnings = deliveredTypes().filter(
      (type) => type === 'customer.subscription.trial_will_end',
    );
    expect(warnings).toHaveLength(1);
  });

  it('gives no warning for a trial shorter than the notice period', async () => {
    await endpoint();
    await trialing(1);
    await advance('2d');

    expect(deliveredTypes()).not.toContain('customer.subscription.trial_will_end');
  });

  it('accepts an absolute trial_end', async () => {
    const customerId = await customerWithCard();
    const monthly = await price(2_000, 'Monthly');
    const endsAt = Math.floor((Date.parse(START) + 7 * 24 * 60 * 60_000) / 1000);

    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': monthly.id,
        trial_end: endsAt,
      })
    ).json();

    expect(subscription.status).toBe('trialing');
    expect(subscription.trial_end).toBe(endsAt);
  });

  it('ends a trial early with trial_end=now', async () => {
    const { subscription } = await trialing();
    await post(`/stripe/v1/subscriptions/${subscription.id}`, { trial_end: 'now' });

    await advance('1s');
    const after = (await get(`/stripe/v1/subscriptions/${subscription.id}`)).json();
    expect(after.status).toBe('active');
    expect((await get('/stripe/v1/invoices')).json().data).toHaveLength(1);
  });

  it('cancels during a trial without ever billing', async () => {
    const { subscription } = await trialing();
    const cancelled = (
      await app.inject({ method: 'DELETE', url: `/stripe/v1/subscriptions/${subscription.id}`, headers: auth })
    ).json();

    expect(cancelled.status).toBe('canceled');
    await advance('30d');
    expect((await context.storage.payments.list({ provider: 'stripe' })).total).toBe(0);
  });
});

describe('the current period', () => {
  it('moves forward with each renewal', async () => {
    const customerId = await customerWithCard();
    const monthly = await price(1_000, 'Monthly');
    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: customerId,
        'items[0][price]': monthly.id,
      })
    ).json();

    expect(subscription.current_period_start).toBe(Math.floor(Date.parse(START) / 1000));

    // Two whole months. `m` is minutes in paybox's duration parser.
    await advance('62d');
    const after = (await get(`/stripe/v1/subscriptions/${subscription.id}`)).json();

    // Not the subscription's start date: the period that is running *now*.
    expect(after.current_period_start).toBeGreaterThan(subscription.current_period_start);
    expect(after.current_period_end).toBeGreaterThan(after.current_period_start);
    expect(after.start_date).toBe(Math.floor(Date.parse(START) / 1000));
  });
});

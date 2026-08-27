import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { addInterval } from '@paybox/core';

/**
 * Recurring billing over virtual time.
 *
 * Request shapes verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27 (`PlanCreate`,
 * `SubscriptionCreate`, `SubscriptionCreateResponse`).
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-01-15T09:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'subscriptions';
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

const CARD_SUCCESS = '4000000000000000';
const CARD_INSUFFICIENT = '4000000000000002';

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

/** Charge a card so the customer has a reusable authorization to subscribe with. */
async function customerWithCard(
  email = 'sub@example.com',
  number = CARD_SUCCESS,
): Promise<string> {
  const charge = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email,
      amount: 10_000,
      currency: 'NGN',
      card: { number, expiry_month: '09', expiry_year: '31' },
    },
  });
  await advance('30s');
  const verified = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${charge.json().data.reference}`,
    headers: auth,
  });
  return verified.json().data.customer.customer_code as string;
}

async function createPlan(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/plan',
    headers: auth,
    payload: { name: 'Basic', amount: 150_000, interval: 'monthly', ...payload },
  });
  return res;
}

async function subscribe(customer: string, plan: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/paystack/subscription',
    headers: auth,
    payload: { customer, plan, ...payload },
  });
}

async function invoicesFor(subscriptionCode: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/subscription/${subscriptionCode}/invoices`,
    headers: auth,
  });
  return res.json().data as Array<{
    status: string;
    amount: number;
    period_start: string;
    period_end: string;
  }>;
}

async function withWebhooks() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: { url: 'http://localhost:9999/hook' },
  });
  return () => transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
}

describe('plans', () => {
  it('creates a plan with the documented interval enum', async () => {
    const res = await createPlan();
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.plan_code).toMatch(/^PLN_/);
    expect(data.interval).toBe('monthly');
    expect(data.amount).toBe(150_000);
  });

  it('rejects an interval outside the documented enum', async () => {
    const res = await createPlan({ interval: 'fortnightly' });
    expect(res.json().status).toBe(false);
  });

  it('updates the mutable fields only', async () => {
    const code = (await createPlan()).json().data.plan_code;
    const res = await app.inject({
      method: 'PUT',
      url: `/paystack/plan/${code}`,
      headers: auth,
      payload: { name: 'Pro', amount: 999_999 },
    });
    expect(res.json().data.name).toBe('Pro');
    // Repricing a live plan is deliberately not supported.
    expect(res.json().data.amount).toBe(150_000);
  });
});

describe('subscribing', () => {
  it('requires a reusable authorization', async () => {
    const customer = await app.inject({
      method: 'POST',
      url: '/paystack/customer',
      headers: auth,
      payload: { email: 'nocard@example.com' },
    });
    const plan = (await createPlan()).json().data.plan_code;

    const res = await subscribe(customer.json().data.customer_code, plan);
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/No reusable authorization/);
  });

  it('creates a subscription and charges the first period immediately', async () => {
    const events = await withWebhooks();
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;

    const res = await subscribe(customer, plan);
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.subscription_code).toMatch(/^SUB_/);
    expect(data.status).toBe('active');

    await advance('1m');
    const invoices = await invoicesFor(data.subscription_code);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe('success');

    const names = events();
    expect(names).toContain('subscription.create');
    expect(names).toContain('invoice.create');
    expect(names).toContain('charge.success');
  });
});

describe('renewal over virtual time', () => {
  /**
   * The load-bearing test.
   *
   * One `time advance` of a year must produce twelve renewals dated one month
   * apart -- not twelve renewals all stamped at the end of the advance. That
   * only works because the scheduler runs each job inside `VirtualClock#at`,
   * so a handler's clock reads the instant the job was due.
   */
  it('bills twelve monthly periods in a single advance, one month apart', async () => {
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;
    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    // 360 days, not 365. The subscription starts on 2026-01-15, so a full year
    // lands exactly on the anniversary and a thirteenth charge falls due that
    // instant; three days before that, the lead-time job raises its invoice.
    // Stopping at 2027-01-10 clears both, leaving exactly twelve settled
    // periods to assert against.
    await advance('360d');

    const invoices = await invoicesFor(code);
    expect(invoices).toHaveLength(12);
    expect(invoices.every((i) => i.status === 'success')).toBe(true);

    // Each period starts exactly one calendar month after the previous one.
    const starts = invoices.map((i) => i.period_start);
    const subscription = await context.storage.subscriptions.byCode(
      'paystack',
      code.replace(/^SUB_/, ''),
    );
    expect(starts[0]).toBe(subscription!.startDate);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBe(addInterval(starts[i - 1]!, 'monthly'));
    }
    // And each period's end is the next period's start: no gaps, no overlap.
    for (let i = 0; i < invoices.length - 1; i++) {
      expect(invoices[i]!.period_end).toBe(invoices[i + 1]!.period_start);
    }
  });

  it('stamps each renewal payment at its own due date, not at the advance', async () => {
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;
    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    await advance('90d');

    const subscription = await context.storage.subscriptions.byCode(
      'paystack',
      code.replace(/^SUB_/, ''),
    );
    const invoices = await context.storage.invoices.listBySubscription(subscription!.id);
    expect(invoices.length).toBeGreaterThanOrEqual(3);

    for (const invoice of invoices) {
      const payment = await context.storage.payments.byId(invoice.paymentId!);
      // The payment exists at the instant its period began -- the whole point
      // of running jobs inside VirtualClock#at.
      expect(payment?.createdAt).toBe(invoice.periodStart);
      expect(payment?.paidAt).toBe(invoice.periodStart);
    }
  });

  it('raises invoice.create three days ahead of the debit', async () => {
    const events = await withWebhooks();
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;
    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    // Past the first (immediate) charge, then to three days before the second.
    await advance('1m');
    const beforeNotice = events().filter((e) => e === 'invoice.create').length;

    await advance('28d');
    expect(events().filter((e) => e === 'invoice.create').length).toBeGreaterThan(
      beforeNotice,
    );

    // The invoice exists but has not been paid yet.
    const invoices = await invoicesFor(code);
    expect(invoices.at(-1)!.status).toBe('pending');
  });

  it('stops at the invoice limit and completes the subscription', async () => {
    const customer = await customerWithCard();
    const plan = (await createPlan({ invoice_limit: 3 })).json().data.plan_code;
    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    await advance('365d');

    expect(await invoicesFor(code)).toHaveLength(3);
    const res = await app.inject({
      method: 'GET',
      url: `/paystack/subscription/${code}`,
      headers: auth,
    });
    expect(res.json().data.status).toBe('complete');
    expect(res.json().data.next_payment_date).toBeNull();
  });
});

describe('failed renewals', () => {
  it('emits invoice.payment_failed and moves the subscription to attention', async () => {
    const events = await withWebhooks();
    // A card that succeeds once to mint the authorization would not decline
    // later, so subscribe with the insufficient-funds card: the 3-D Secure
    // path is what mints it, and every off-session renewal then declines.
    const customer = await customerWithCard('dunning@example.com', '4000000000000004');
    const plan = (await createPlan()).json().data.plan_code;

    // Complete the step-up so an authorization exists.
    const parked = await context.storage.payments.list({ provider: 'paystack', limit: 10 });
    const pending = parked.items.find((p) => p.status === 'requires_action');
    if (pending) {
      await app.inject({
        method: 'POST',
        url: '/paystack/charge/submit_otp',
        headers: auth,
        payload: { otp: '123456', reference: pending.reference },
      });
    }

    const created = await subscribe(customer, plan);
    expect(created.statusCode).toBe(201);
    const code = created.json().data.subscription_code;

    await advance('1m');

    // The stored card still requires a step-up, and nobody is there to do it.
    const invoices = await invoicesFor(code);
    expect(invoices[0]!.status).toBe('failed');
    expect(events()).toContain('invoice.payment_failed');

    const res = await app.inject({
      method: 'GET',
      url: `/paystack/subscription/${code}`,
      headers: auth,
    });
    expect(res.json().data.status).toBe('attention');
  });

  it('keeps trying after a failure rather than silently giving up', async () => {
    const customer = await customerWithCard('retry@example.com', '4000000000000004');
    const plan = (await createPlan()).json().data.plan_code;

    const parked = await context.storage.payments.list({ provider: 'paystack', limit: 10 });
    const pending = parked.items.find((p) => p.status === 'requires_action');
    await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference: pending!.reference },
    });

    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    await advance('1m');
    expect((await invoicesFor(code))).toHaveLength(1);

    // Still scheduled: a subscription in `attention` is recoverable, and the
    // merchant needs to see continued attempts rather than silent death.
    const afterFirst = await app.inject({
      method: 'GET',
      url: `/paystack/subscription/${code}`,
      headers: auth,
    });
    expect(afterFirst.json().data.status).toBe('attention');
    expect(afterFirst.json().data.next_payment_date).not.toBeNull();

    await advance('40d');
    const invoices = await invoicesFor(code);
    expect(invoices.length).toBeGreaterThan(1);
    expect(invoices.every((i) => i.status === 'failed')).toBe(true);
  });
});

describe('disable and enable', () => {
  it('disable stops future renewals', async () => {
    const events = await withWebhooks();
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;
    const created = await subscribe(customer, plan);
    const { subscription_code: code, email_token: token } = created.json().data;

    await advance('1m');
    const before = (await invoicesFor(code)).length;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/subscription/disable',
      headers: auth,
      payload: { code, token },
    });
    expect(res.json().status).toBe(true);

    await advance('365d');
    expect((await invoicesFor(code)).length).toBe(before);
    expect(events()).toContain('subscription.not_renew');
  });

  it('refuses to disable with the wrong email token', async () => {
    const customer = await customerWithCard();
    const plan = (await createPlan()).json().data.plan_code;
    const code = (await subscribe(customer, plan)).json().data.subscription_code;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/subscription/disable',
      headers: auth,
      payload: { code, token: 'wrong-token' },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/email token/i);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs subscriptions end to end through the HTTP surface a client uses.
 *
 * Sources (read 2026-10-10): guides/subscriptions/{overview, manage,
 * failed-payments, trials, proration}, guides/checkout/checkout-sessions
 * ("Recurring products"), the subscription and invoice event pages, and the
 * pinned OpenAPI document.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
});

describe('a subscription checkout', () => {
  it('saves the card, bills the first cycle and starts the subscription', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription, checkout } = await api.subscribe(productId, customerId);

    expect(subscription).toMatchObject({
      status: 'active',
      collection_method: 'charge_automatically',
      currency: 'USD',
      amount: '10.00',
      billing_cycle: { interval: 'month', frequency: 1 },
      quantity: 1,
      current_period_start: '2026-06-14T12:00:01.000Z',
      current_period_end: '2026-07-14T12:00:01.000Z',
      previously_billed_at: '2026-06-14T12:00:01.000Z',
      next_billed_at: '2026-07-14T12:00:01.000Z',
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      metadata: { checkout_id: checkout.id },
      product: { id: productId, name: 'Pro plan', status: 'active' },
      customer: { customer_id: customerId, email: 'jane@example.com' },
    });
    expect(subscription.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(subscription.payment_method_id).toMatch(/^pm_[0-9a-f]{20}$/);
    expect(subscription.items).toHaveLength(1);
    expect(subscription.items[0]).toMatchObject({ status: 'active', recurring: true, unit_amount: '10.00' });

    // The checkout names its subscription; the first charge is the first cycle.
    const [completed] = (await sent(env, 'checkout.completed'));
    expect(completed?.data).toMatchObject({
      mode: 'subscription',
      payment_status: 'paid',
      subscription: { subscription_id: subscription.id },
    });
    const [created] = (await sent(env, 'customer.subscription.created'));
    expect(created?.data).toMatchObject({ subscription_id: subscription.id, product_id: productId, status: 'active', items: [] });
    const [saved] = (await sent(env, 'payment_method.saved'));
    expect(saved?.data).toMatchObject({
      payment_method_id: subscription.payment_method_id,
      type: 'card',
      card_brand: 'visa',
      card_last4: '4242',
      card_exp_month: 12,
      card_exp_year: 2031,
      currency: 'USD',
      is_default: true,
    });
    const [invoiceCreated] = (await sent(env, 'invoice.created'));
    const [invoicePaid] = (await sent(env, 'invoice.paid'));
    expect(invoicePaid?.data).toMatchObject({
      invoice_id: invoiceCreated?.data.invoice_id,
      subscription: { subscription_id: subscription.id },
      status: 'paid',
      subtotal: '10.00',
      total: '10.00',
      amount_paid: '10.00',
      amount_remaining: '0.00',
      period_start: '2026-06-14T12:00:01Z',
      period_end: '2026-07-14T12:00:01Z',
      attempt_count: 1,
      next_payment_attempt: null,
    });
    expect((await sent(env, 'collection.succeeded'))).toHaveLength(1);

    const chargeId = invoicePaid?.data.charge.id as string;
    const payment = (await api.get(`/v1/payments/${chargeId}`)).json();
    expect(payment).toMatchObject({
      billing_reason: 'subscription_create',
      subscription_id: subscription.id,
      invoice: { invoice_id: invoiceCreated?.data.invoice_id, subscription_id: subscription.id, kind: 'cycle' },
    });
  });

  it('renews twelve times, one calendar month apart, from a single one-year advance', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    await api.advance('365d');

    const paid = (await sent(env, 'invoice.paid'));
    expect(paid).toHaveLength(13);
    const starts = paid.map((event) => event.data.period_start);
    expect(starts).toEqual([
      '2026-06-14T12:00:01Z',
      '2026-07-14T12:00:01Z',
      '2026-08-14T12:00:01Z',
      '2026-09-14T12:00:01Z',
      '2026-10-14T12:00:01Z',
      '2026-11-14T12:00:01Z',
      '2026-12-14T12:00:01Z',
      '2027-01-14T12:00:01Z',
      '2027-02-14T12:00:01Z',
      '2027-03-14T12:00:01Z',
      '2027-04-14T12:00:01Z',
      '2027-05-14T12:00:01Z',
      '2027-06-14T12:00:01Z',
    ]);
    // Each renewal's charge is stamped at its own period start.
    const last = paid[12]!.data.charge;
    expect(last.created_at).toBe('2027-06-14T12:00:01Z');
    const renewal = (await api.get(`/v1/payments/${last.id}`)).json();
    expect(renewal).toMatchObject({ billing_reason: 'subscription_cycle', channel: 'subscription', status: 'succeeded' });

    const after = (await api.get(`/v1/subscriptions/${subscription.id}`)).json();
    expect(after).toMatchObject({
      status: 'active',
      current_period_start: '2027-06-14T12:00:01.000Z',
      current_period_end: '2027-07-14T12:00:01.000Z',
      previously_billed_at: '2027-06-14T12:00:01.000Z',
    });
  });

  it('keeps a month-end anchor instead of drifting to the 28th', async () => {
    await env.close();
    env = await startBachs({ PAYBOX_START_AT: '2027-01-31T09:00:00.000Z' });
    api = client(env);
    const productId = await api.product();
    const customerId = await api.customer();
    await api.subscribe(productId, customerId);
    await api.advance('100d');
    expect((await sent(env, 'invoice.paid')).map((event) => event.data.period_start)).toEqual([
      '2027-01-31T09:00:01Z',
      '2027-02-28T09:00:01Z',
      '2027-03-31T09:00:01Z',
      '2027-04-30T09:00:01Z',
    ]);
  });

  it('refuses what a subscription checkout cannot be', async () => {
    const usd = await api.product();
    const customerId = await api.customer();
    const expectError = async (body: Record<string, unknown>, status: number, code: string) => {
      const response = await api.post('/v1/checkout-sessions', body);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error_code).toBe(code);
    };
    const ngn = await api.product({ currency: 'NGN', amount: '5000.00' });
    const ghs = await api.product({ currency: 'GHS', amount: '50.00' });
    const oneTime = await api.product({ currency: 'USD', amount: '5.00' }, {});
    const customer = { customer_id: customerId };
    await expectError({ product_cart: [{ product_id: usd }] }, 400, 'VALIDATION_ERROR');
    await expectError({ product_cart: [{ product_id: ngn }], customer }, 403, 'NGN_SUBSCRIPTIONS_NOT_ENABLED');
    await expectError({ product_cart: [{ product_id: ghs }], customer }, 422, 'BASE_CURRENCY_NOT_HELD_BY_ORG');
    await expectError(
      { product_cart: [{ product_id: usd }, { product_id: oneTime }], customer },
      400,
      'SUBSCRIPTION_REQUIRES_CATALOG_PRODUCT',
    );
    await expectError(
      { product_cart: [{ product_id: usd }], customer, payment_method_types: ['NGN_BANK_TRANSFER'] },
      400,
      'SUBSCRIPTION_METHOD_NOT_SUPPORTED',
    );
    await expectError(
      { product_cart: [{ product_id: usd, pricing: { price_type: 'custom' } }], customer },
      400,
      'INVALID_SUBSCRIPTION_PRICE',
    );
  });
});

describe('failed renewals', () => {
  /** A subscription on Bachs' "saves, then later charges decline" card, one renewal in. */
  async function failingSubscription() {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    expect(subscription.status).toBe('active');
    await api.advance('30d');
    return { subscription, customerId };
  }

  it('goes past_due and retries on days 1, 4 and 9, then cancels', async () => {
    const { subscription } = await failingSubscription();
    let failed = (await sent(env, 'invoice.payment_failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({
      status: 'open',
      attempt_count: 1,
      next_payment_attempt: '2026-07-15T12:00:01Z',
      amount_remaining: '10.00',
    });
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('past_due');
    expect((await sent(env, 'customer.subscription.updated')).at(-1)?.data.status).toBe('past_due');

    await api.advance('1d');
    failed = (await sent(env, 'invoice.payment_failed'));
    expect(failed.map((event) => [event.data.attempt_count, event.data.next_payment_attempt])).toEqual([
      [1, '2026-07-15T12:00:01Z'],
      [2, '2026-07-18T12:00:01Z'],
    ]);
    await api.advance('8d');
    failed = (await sent(env, 'invoice.payment_failed'));
    expect(failed.map((event) => [event.data.attempt_count, event.data.next_payment_attempt])).toEqual([
      [1, '2026-07-15T12:00:01Z'],
      [2, '2026-07-18T12:00:01Z'],
      [3, '2026-07-23T12:00:01Z'],
      [4, null],
    ]);

    // "moves to canceled with a cancellation reason of payment_failed".
    const deleted = (await sent(env, 'customer.subscription.deleted'));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toMatchObject({ status: 'canceled', canceled_at: '2026-07-23T12:00:01Z' });
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json()).toMatchObject({
      status: 'canceled',
      next_billed_at: null,
    });
    // Nothing more is billed.
    await api.advance('60d');
    expect((await sent(env, 'invoice.created'))).toHaveLength(2);
  });

  it('stays unpaid when the account keeps unpaid subscriptions, and a card update recovers it', async () => {
    await env.close();
    env = await startBachs({ PAYBOX_BACHS_SUBSCRIPTION_RECOVERY: 'unpaid' });
    api = client(env);
    const { subscription, customerId } = await failingSubscription();
    await api.advance('9d');
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('unpaid');
    expect((await sent(env, 'customer.subscription.deleted'))).toHaveLength(0);
    expect((await sent(env, 'customer.subscription.updated')).at(-1)?.data.status).toBe('unpaid');

    const good = await api.saveCard(customerId, '5555555555554444');
    const patched = await api.patch(`/v1/subscriptions/${subscription.id}`, { payment_method_id: good });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ status: 'active', payment_method_id: good });
    expect((await sent(env, 'invoice.paid')).at(-1)?.data).toMatchObject({ status: 'paid', amount_paid: '10.00' });
  });

  it('recovers mid-dunning when the card is changed, and the remaining retries do nothing', async () => {
    const { subscription, customerId } = await failingSubscription();
    const good = await api.saveCard(customerId, '5555555555554444');
    const patched = await api.patch(`/v1/subscriptions/${subscription.id}`, { payment_method_id: good });
    expect(patched.json().status).toBe('active');
    await api.advance('10d');
    expect((await sent(env, 'invoice.payment_failed'))).toHaveLength(1);
    expect((await sent(env, 'customer.subscription.deleted'))).toHaveLength(0);
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('active');
  });
});

describe('cancellation', () => {
  it('cancels at period end exactly once, without billing again', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    const scheduled = await api.del(`/v1/subscriptions/${subscription.id}`, { cancel_at_period_end: true, reason: 'too expensive' });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json()).toMatchObject({ status: 'active', cancel_at_period_end: true, next_billed_at: null, canceled_at: null });
    expect((await sent(env, 'customer.subscription.updated')).at(-1)?.data).toMatchObject({ cancel_at_period_end: true });

    await api.advance('60d');
    const deleted = (await sent(env, 'customer.subscription.deleted'));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toMatchObject({ status: 'canceled', canceled_at: '2026-07-14T12:00:01Z' });
    expect((await sent(env, 'invoice.created'))).toHaveLength(1);
  });

  it('cancels immediately, refuses a second cancel and any change after', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    const canceled = await api.del(`/v1/subscriptions/${subscription.id}`);
    expect(canceled.json()).toMatchObject({ status: 'canceled', canceled_at: '2026-06-14T12:00:01.000Z', next_billed_at: null });
    expect((await sent(env, 'customer.subscription.deleted'))).toHaveLength(1);

    const again = await api.del(`/v1/subscriptions/${subscription.id}`);
    expect(again.statusCode).toBe(400);
    expect(again.json().error_code).toBe('SUBSCRIPTION_ALREADY_CANCELED');
    const change = await api.patch(`/v1/subscriptions/${subscription.id}`, { metadata: { plan: 'pro' } });
    expect(change.statusCode).toBe(400);
    expect(change.json().error_code).toBe('SUBSCRIPTION_NOT_MODIFIABLE');
    await api.advance('60d');
    expect((await sent(env, 'invoice.created'))).toHaveLength(1);
  });

  it("stops billing when paybox's own tooling cancels the subscription", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    const core = await env.context.storage.subscriptions.byCode('bachs', subscription.id);
    const disabled = await env.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${core!.id}/disable`,
      payload: { status: 'cancelled' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    await api.advance('90d');
    expect((await sent(env, 'invoice.created'))).toHaveLength(1);
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('canceled');
  });

  it("treats paybox's non_renewing as a cancellation at the period end", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    const core = await env.context.storage.subscriptions.byCode('bachs', subscription.id);
    await env.app.inject({ method: 'POST', url: `/api/subscriptions/${core!.id}/disable`, payload: {} });
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json()).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      next_billed_at: null,
    });
    await api.advance('60d');
    expect(await sent(env, 'customer.subscription.deleted')).toHaveLength(1);
    expect(await sent(env, 'invoice.created')).toHaveLength(1);
  });
});

describe('trials', () => {
  async function trialProduct() {
    return api.product({ currency: 'USD', amount: '10.00' }, {
      billing_cycle: { interval: 'month', frequency: 1 },
      trial_period: { interval: 'day', frequency: 14 },
    });
  }

  it('saves the card without charging, then bills the first cycle when the trial ends', async () => {
    const productId = await trialProduct();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    const page = await api.pageGet(session.path);
    expect(page.body).toContain('Start trial');
    const started = await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.body).toContain('Trial started');

    expect((await sent(env, 'collection.succeeded'))).toHaveLength(0);
    expect((await sent(env, 'checkout.completed'))[0]?.data).toMatchObject({
      mode: 'subscription',
      payment_status: 'no_payment_required',
      amount: '0',
    });
    const [subscription] = await api.subscriptionsOf(customerId);
    expect(subscription).toMatchObject({
      status: 'trialing',
      trial_end: '2026-06-28T12:00:00.000Z',
      current_period_end: '2026-06-28T12:00:00.000Z',
      next_billed_at: '2026-06-28T12:00:00.000Z',
      previously_billed_at: null,
    });
    expect((await sent(env, 'customer.subscription.created'))[0]?.data.status).toBe('trialing');

    await api.advance('14d');
    const after = (await api.get(`/v1/subscriptions/${subscription!.id}`)).json();
    expect(after).toMatchObject({
      status: 'active',
      current_period_start: '2026-06-28T12:00:00.000Z',
      current_period_end: '2026-07-28T12:00:00.000Z',
    });
    const [paid] = (await sent(env, 'invoice.paid'));
    const payment = (await api.get(`/v1/payments/${paid!.data.charge.id}`)).json();
    expect(payment.billing_reason).toBe('subscription_create');
  });

  it('ends a trial early and bills now; extends one; refuses to end one that is not running', async () => {
    const productId = await trialProduct();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    const [subscription] = await api.subscriptionsOf(customerId);

    const extended = await api.patch(`/v1/subscriptions/${subscription!.id}`, { trial_end: '2026-07-14T00:00:00Z' });
    expect(extended.json()).toMatchObject({ status: 'trialing', trial_end: '2026-07-14T00:00:00.000Z', next_billed_at: '2026-07-14T00:00:00.000Z' });
    await api.advance('20d');
    expect((await sent(env, 'invoice.created'))).toHaveLength(0);

    const ended = await api.patch(`/v1/subscriptions/${subscription!.id}`, { trial_end: '2026-07-01T00:00:00Z' });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({
      status: 'active',
      current_period_start: '2026-07-04T12:00:00.000Z',
      current_period_end: '2026-08-04T12:00:00.000Z',
    });
    expect((await sent(env, 'invoice.paid'))).toHaveLength(1);

    const again = await api.patch(`/v1/subscriptions/${subscription!.id}`, { trial_end: '2026-07-01T00:00:00Z' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error_code).toBe('SUBSCRIPTION_NOT_TRIALING');

    // A future trial end on an active subscription "becomes trialing".
    const back = await api.patch(`/v1/subscriptions/${subscription!.id}`, { trial_end: '2026-09-01T00:00:00Z' });
    expect(back.json()).toMatchObject({ status: 'trialing', next_billed_at: '2026-09-01T00:00:00.000Z' });
  });
});

describe('plan changes', () => {
  /** A $10 subscription, half-way through a 30-day period (June has 30 days... from the 14th to July 14th). */
  async function halfWay() {
    const basic = await api.product({ currency: 'USD', amount: '10.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Basic');
    const pro = await api.product({ currency: 'USD', amount: '30.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Pro');
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(basic, customerId);
    // 2026-06-14T12:00:01 to 2026-07-14T12:00:01 is exactly 30 days.
    await api.advance('15d');
    return { basic, pro, customerId, subscription };
  }

  it('charges an upgrade now, prorated to the cent', async () => {
    const { pro, subscription } = await halfWay();
    const changed = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: pro });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ amount: '30.00', product: { id: pro } });
    // (30.00 - 10.00) x 1/2 = 10.00
    const proration = (await sent(env, 'invoice.paid')).at(-1)!;
    expect(proration.data).toMatchObject({ total: '10.00', subtotal: '10.00', period_end: '2026-07-14T12:00:01Z' });
    const payment = (await api.get(`/v1/payments/${proration.data.charge.id}`)).json();
    expect(payment).toMatchObject({ billing_reason: 'subscription_update', amount: '10.00', invoice: { kind: 'proration' } });

    // The next renewal is the new price.
    await api.advance('15d');
    expect((await sent(env, 'invoice.paid')).at(-1)?.data.total).toBe('30.00');
  });

  it('turns a downgrade into credit applied to the next invoices, without charging a fully covered one', async () => {
    const basic = await api.product({ currency: 'USD', amount: '10.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Basic');
    const pro = await api.product({ currency: 'USD', amount: '30.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Pro');
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(pro, customerId);
    // Straight away: the whole period remains, so the credit is 30.00 - 10.00.
    const down = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: basic });
    expect(down.statusCode, down.body).toBe(200);
    expect(await sent(env, 'invoice.created')).toHaveLength(1);
    const charges = (await sent(env, 'collection.succeeded')).length;

    // First renewal: 10.00 owed, all of it covered by credit; no card charge.
    await api.advance('30d');
    let renewal = (await sent(env, 'invoice.paid')).at(-1)!;
    expect(renewal.data).toMatchObject({ subtotal: '10.00', total: '0.00', amount_paid: '0.00', charge: null });
    // Second renewal: the last 10.00 of credit.
    await api.advance('31d');
    renewal = (await sent(env, 'invoice.paid')).at(-1)!;
    expect(renewal.data).toMatchObject({ subtotal: '10.00', total: '0.00', charge: null });
    // Third: credit spent, the card pays.
    await api.advance('31d');
    renewal = (await sent(env, 'invoice.paid')).at(-1)!;
    expect(renewal.data).toMatchObject({ subtotal: '10.00', total: '10.00', amount_paid: '10.00' });
    expect((await sent(env, 'collection.succeeded')).length).toBe(charges + 1);
  });

  it('defers the difference to the next renewal with next_cycle, and changes only the terms with none', async () => {
    const { pro, subscription, basic } = await halfWay();
    const deferred = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: pro, proration_behavior: 'next_cycle' });
    expect(deferred.statusCode, deferred.body).toBe(200);
    expect((await sent(env, 'invoice.created'))).toHaveLength(1);
    await api.advance('15d');
    // 30.00 for the new period plus 10.00 carried over.
    expect((await sent(env, 'invoice.paid')).at(-1)?.data).toMatchObject({ subtotal: '40.00', total: '40.00' });

    const none = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: basic, proration_behavior: 'none' });
    expect(none.json().amount).toBe('10.00');
    // The period that just began runs 14 July to 14 August: 31 days.
    await api.advance('31d');
    expect((await sent(env, 'invoice.paid')).at(-1)?.data).toMatchObject({ subtotal: '10.00', total: '10.00' });
  });

  it('refuses the plan changes Bachs refuses', async () => {
    const { subscription } = await halfWay();
    const yearly = await api.product({ currency: 'USD', amount: '100.00' }, { billing_cycle: { interval: 'year', frequency: 1 } }, 'Yearly');
    const eur = await api.product({ currency: 'NGN', amount: '9000.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Naira');
    const oneTime = await api.product({ currency: 'USD', amount: '9.00' }, {}, 'Once');
    const expectError = async (body: Record<string, unknown>, code: string) => {
      const response = await api.patch(`/v1/subscriptions/${subscription.id}`, body);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error_code).toBe(code);
    };
    await expectError({ product_id: yearly }, 'SUBSCRIPTION_PLAN_INTERVAL_MISMATCH');
    await expectError({ product_id: eur }, 'PLAN_NOT_PRICED_IN_CURRENCY');
    await expectError({ product_id: oneTime }, 'SUBSCRIPTION_PRICE_NOT_RECURRING');
    await expectError({ product_id: 'prod_missing' }, 'PRODUCT_NOT_FOUND');
    await expectError({ product_id: yearly, proration_behavior: 'reset' }, 'PRORATION_BEHAVIOR_NOT_SUPPORTED');
    await expectError({ metadata: { a: '1' }, trial_end: '2027-01-01T00:00:00Z' }, 'VALIDATION_ERROR');
    await expectError({}, 'VALIDATION_ERROR');
  });

  it('serialises two plan changes sent at once', async () => {
    const { pro, basic, subscription } = await halfWay();
    const [a, b] = await Promise.all([
      api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: pro }),
      api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: basic }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Pro first (an upgrade, charged) then back to Basic (a downgrade, credited).
    const final = (await api.get(`/v1/subscriptions/${subscription.id}`)).json();
    expect(final.product.id).toBe(basic);
    expect((await sent(env, 'invoice.created'))).toHaveLength(2);
  });
});

describe('metadata', () => {
  it('merges, deletes a key sent empty, clears on "", and keeps checkout_id', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription, checkout } = await api.subscribe(productId, customerId);
    let response = await api.patch(`/v1/subscriptions/${subscription.id}`, { metadata: { plan: 'pro', seats: '5' } });
    expect(response.json().metadata).toEqual({ checkout_id: checkout.id, plan: 'pro', seats: '5' });
    response = await api.patch(`/v1/subscriptions/${subscription.id}`, { metadata: { seats: '', checkout_id: 'nope' } });
    expect(response.json().metadata).toEqual({ checkout_id: checkout.id, plan: 'pro' });
    response = await api.patch(`/v1/subscriptions/${subscription.id}`, { metadata: '' });
    expect(response.json().metadata).toEqual({ checkout_id: checkout.id });
  });
});

describe('listing', () => {
  it('lists newest first, filters by customer and status, and 404s an unknown id', async () => {
    const productId = await api.product();
    const jane = await api.customer();
    const sam = await api.customer('sam@example.com', 'Sam');
    const first = await api.subscribe(productId, jane);
    const second = await api.subscribe(productId, sam);
    await api.del(`/v1/subscriptions/${first.subscription.id}`);

    const all = (await api.get('/v1/subscriptions')).json();
    expect(all.items.map((item: { id: string }) => item.id)).toEqual([second.subscription.id, first.subscription.id]);
    expect(all.pagination).toMatchObject({ total: 2, limit: 50, offset: 0, returned: 2, has_more: false });
    const canceled = (await api.get('/v1/subscriptions?status=canceled')).json();
    expect(canceled.items.map((item: { id: string }) => item.id)).toEqual([first.subscription.id]);
    const missing = await api.get('/v1/subscriptions/sub_missing');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error_code).toBe('NOT_FOUND');
  });
});

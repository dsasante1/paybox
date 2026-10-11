import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Defects found by review of Bachs billing before it shipped, one test each.
 * Every one of these failed against the first version of the code.
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

const credit = async (customerId: string) => {
  const core = await env.context.storage.customers.byProviderCustomerId('bachs', customerId);
  const raw = await env.context.storage.providerState.get('bachs', `credit:${core!.id}:USD`);
  return ((raw ? JSON.parse(raw) : []) as Array<{ amount: number }>).reduce((sum, entry) => sum + entry.amount, 0);
};

const invoiceStatuses = async (subscriptionId: string) => {
  const core = await env.context.storage.subscriptions.byCode('bachs', subscriptionId);
  return (await env.context.storage.invoices.listBySubscription(core!.id)).map((invoice) => invoice.status);
};

describe('Bachs billing regressions', () => {
  it('does not save a refused card when the payer then pays another way', async () => {
    const customerId = await api.customer();
    const session = await api.checkout({
      pricing: { currency: 'USD', amount: '29.00' },
      customer: { customer_id: customerId },
      save_payment_method: true,
    });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4000000000000002' });
    await api.pagePost(`${session.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    await api.pagePost(`${session.path}/simulate`, { action: 'succeed' });
    await api.advance('1s');
    expect(await sent(env, 'collection.succeeded')).toHaveLength(1);
    expect(await sent(env, 'payment_method.saved')).toHaveLength(0);
  });

  it('refuses a plan change while past_due, so no unpaid time becomes credit', async () => {
    const basic = await api.product({ currency: 'USD', amount: '10.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Basic');
    const premium = await api.product({ currency: 'USD', amount: '30.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Premium');
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(premium, customerId, '4000000000000341');
    await api.advance('30d');
    const down = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: basic });
    expect(down.statusCode).toBe(400);
    expect(down.json().error_code).toBe('SUBSCRIPTION_NOT_MODIFIABLE');
    expect(await credit(customerId)).toBe(0);
  });

  it('spends one customer credit once across two subscriptions changed at the same time', async () => {
    const basic = await api.product({ currency: 'USD', amount: '10.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Basic');
    const pro = await api.product({ currency: 'USD', amount: '30.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Pro');
    const customerId = await api.customer();
    const a = await api.subscribe(pro, customerId);
    const b = await api.subscribe(basic, customerId);
    // A straight back down to Basic: 20.00 of credit.
    await api.patch(`/v1/subscriptions/${a.subscription.id}`, { product_id: basic });
    expect(await credit(customerId)).toBe(2000);
    await api.advance('15d');
    const [upA, upB] = await Promise.all([
      api.patch(`/v1/subscriptions/${a.subscription.id}`, { product_id: pro }),
      api.patch(`/v1/subscriptions/${b.subscription.id}`, { product_id: pro }),
    ]);
    expect(upA.statusCode).toBe(200);
    expect(upB.statusCode).toBe(200);
    const prorations = (await sent(env, 'invoice.paid')).slice(-2);
    const applied = prorations.reduce((sum, event) => sum + Math.round((Number(event.data.subtotal) - Number(event.data.total)) * 100), 0);
    // Whatever was applied came out of the balance, and nothing more.
    expect(applied + (await credit(customerId))).toBe(2000);
  });

  it("keeps retrying, without crashing, a past_due subscription paybox's tooling set to non-renewing", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    const core = await env.context.storage.subscriptions.byCode('bachs', subscription.id);
    // past_due is canonical attention; the tooling's default target is non_renewing.
    await env.app.inject({ method: 'POST', url: `/api/subscriptions/${core!.id}/disable`, payload: {} });
    await api.advance('9d');
    expect((await sent(env, 'invoice.payment_failed')).map((event) => event.data.attempt_count)).toEqual([1, 2, 3, 4]);
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('canceled');
  });

  it('brings a re-saved card up to date instead of keeping its old expiry', async () => {
    const customerId = await api.customer();
    const first = await api.checkout({ customer: { customer_id: customerId }, save_payment_method: true });
    await api.pagePost(`${first.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242', exp_month: '7', exp_year: '2026' });
    await api.advance('60d');
    const expired = await api.post('/v1/charges', { customer: customerId, amount: '5.00', currency: 'USD' });
    expect(expired.json().error_code).toBe('PAYMENT_METHOD_UNUSABLE');
    const second = await api.checkout({ customer: { customer_id: customerId }, save_payment_method: true });
    await api.pagePost(`${second.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242', exp_month: '12', exp_year: '2034' });
    const charged = await api.post('/v1/charges', { customer: customerId, amount: '5.00', currency: 'USD' });
    expect(charged.statusCode, charged.body).toBe(201);
    expect(charged.json().status).toBe('processing');
    expect(await sent(env, 'payment_method.saved')).toHaveLength(1);
  });

  it('moves the period on when a renewal is skipped during recovery', async () => {
    await env.close();
    env = await startBachs({ PAYBOX_BACHS_SUBSCRIPTION_RECOVERY: 'unpaid' });
    api = client(env);
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    // Fails on 14 July, unpaid by the 23rd, still unpaid at the 14 August boundary.
    await api.advance('62d');
    const good = await api.saveCard(customerId, '5555555555554444');
    const recovered = (await api.patch(`/v1/subscriptions/${subscription.id}`, { payment_method_id: good })).json();
    expect(recovered).toMatchObject({
      status: 'active',
      current_period_start: '2026-08-14T12:00:01.000Z',
      current_period_end: '2026-09-14T12:00:01.000Z',
      next_billed_at: '2026-09-14T12:00:01.000Z',
    });
  });

  it('will not resume a canceled subscription from the portal', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    await api.del(`/v1/subscriptions/${subscription.id}`, { cancel_at_period_end: true });
    await api.advance('31d');
    const updates = (await sent(env, 'customer.subscription.updated')).length;
    const path = new URL((await api.post(`/v1/customers/${customerId}/portal-sessions`)).json().url).pathname;
    const resumed = await api.pagePost(`${path}/subscriptions/${subscription.id}/resume`, {});
    expect(resumed.body).toContain('cannot be modified');
    expect((await sent(env, 'customer.subscription.updated')).length).toBe(updates);
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json()).toMatchObject({ status: 'canceled' });
  });

  it('closes the owed invoice when a past_due subscription is canceled', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    await api.del(`/v1/subscriptions/${subscription.id}`);
    expect(await invoiceStatuses(subscription.id)).toEqual(['success', 'uncollectible']);
    await api.advance('10d');
    expect(await sent(env, 'invoice.payment_failed')).toHaveLength(1);
  });

  it('takes no recovery payment for a subscription that owes nothing', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId);
    const path = new URL((await api.post(`/v1/customers/${customerId}/portal-sessions`)).json().url).pathname;
    const paid = await api.pagePost(`${path}/subscriptions/${subscription.id}/pay`, { card_number: '5555555555554444' });
    expect(paid.body).toContain('Nothing is owed');
    expect(await sent(env, 'collection.succeeded')).toHaveLength(1);
  });

  it("starts the subscription from the checkout's expiry job when the completion event's work was lost", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    // The in-memory listener fails once, as a process stopping mid-way would leave it.
    const authorizations = env.context.storage.authorizations;
    const original = authorizations.bySignature.bind(authorizations);
    let failures = 1;
    authorizations.bySignature = async (...args) => {
      if (failures-- > 0) throw new Error('simulated crash');
      return original(...args);
    };
    await api.advance('1s');
    expect(await api.subscriptionsOf(customerId)).toHaveLength(0);
    expect((await api.get(`/v1/checkout-sessions/${session.id}`)).json().status).toBe('completed');

    await api.advance('1h');
    const [subscription] = await api.subscriptionsOf(customerId);
    expect(subscription).toMatchObject({ status: 'active', current_period_start: '2026-06-14T12:00:01.000Z' });
    expect(await sent(env, 'customer.subscription.created')).toHaveLength(1);
    // A second pass changes nothing.
    await api.advance('1d');
    expect(await api.subscriptionsOf(customerId)).toHaveLength(1);
  });

  it('gives no credit for a period that began while recovery was running', async () => {
    await env.close();
    env = await startBachs({ PAYBOX_BACHS_SUBSCRIPTION_RECOVERY: 'unpaid' });
    api = client(env);
    const cheap = await api.product({ currency: 'USD', amount: '1.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Cheap');
    const premium = await api.product({ currency: 'USD', amount: '30.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Premium');
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(premium, customerId, '4000000000000341');
    await api.advance('62d');
    const good = await api.saveCard(customerId, '5555555555554444');
    await api.patch(`/v1/subscriptions/${subscription.id}`, { payment_method_id: good });
    await api.advance('1d');
    const down = await api.patch(`/v1/subscriptions/${subscription.id}`, { product_id: cheap });
    expect(down.statusCode, down.body).toBe(200);
    expect(await credit(customerId)).toBe(0);
  });

  it('retries a subscription start that failed part-way, from the expiry job, without duplicating anything', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    const engine = env.context.engine;
    const createSubscription = engine.createSubscription.bind(engine);
    let failures = 1;
    engine.createSubscription = async (...args) => {
      if (failures-- > 0) throw new Error('simulated crash');
      return createSubscription(...args);
    };
    await api.advance('1s');
    expect(await api.subscriptionsOf(customerId)).toHaveLength(0);
    await api.advance('1h');
    const [subscription] = await api.subscriptionsOf(customerId);
    expect(subscription?.status).toBe('active');
    expect(await sent(env, 'invoice.paid')).toHaveLength(1);
    expect((await env.context.storage.plans.list({ provider: 'bachs' })).items).toHaveLength(1);
  });

  it("raises the first cycle's invoice when a retried start finds the subscription already made", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    const engine = env.context.engine;
    const createInvoice = engine.createInvoice.bind(engine);
    let failures = 1;
    engine.createInvoice = async (...args) => {
      if (failures-- > 0) throw new Error('simulated crash');
      return createInvoice(...args);
    };
    await api.advance('1s');
    await api.advance('1h');
    const paid = await sent(env, 'invoice.paid');
    expect(paid).toHaveLength(1);
    const payment = (await api.get(`/v1/payments/${paid[0]!.data.charge.id}`)).json();
    expect(payment.billing_reason).toBe('subscription_create');
  });

  it('refuses a card entered with an expiry in the past, leaving the saved one working', async () => {
    const customerId = await api.customer();
    await api.saveCard(customerId);
    const session = await api.checkout({ customer: { customer_id: customerId }, save_payment_method: true });
    const stale = await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242', exp_month: '1', exp_year: '2020' });
    expect(stale.body).toContain('Your card has expired.');
    const charged = await api.post('/v1/charges', { customer: customerId, amount: '5.00', currency: 'USD' });
    expect(charged.statusCode, charged.body).toBe(201);
  });

  it('never reports active between a failed retry and past_due on a non-renewing subscription', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    const core = await env.context.storage.subscriptions.byCode('bachs', subscription.id);
    await env.app.inject({ method: 'POST', url: `/api/subscriptions/${core!.id}/disable`, payload: {} });
    const before = (await sent(env, 'customer.subscription.updated')).length;
    await api.advance('1d');
    const after = (await sent(env, 'customer.subscription.updated')).slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((event) => event.data.status)).not.toContain('active');
  });

  /** Make `fn` on `target` throw the first time `when` holds for its arguments. */
  function failOnce<T extends object>(target: T, key: keyof T, when: (...args: any[]) => boolean = () => true) {
    const original = (target[key] as any).bind(target);
    let armed = true;
    (target as any)[key] = async (...args: any[]) => {
      if (armed && when(...args)) {
        armed = false;
        throw new Error('simulated crash');
      }
      return original(...args);
    };
  }

  it('still renews a subscription whose start was interrupted before its renewal was scheduled', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    failOnce(env.context.storage.jobs, 'enqueue', (job: { kind: string }) => job.kind === 'bachs.subscription.renew');
    await api.advance('1s');
    await api.advance('70d');
    expect((await sent(env, 'invoice.paid')).map((event) => event.data.period_start)).toEqual([
      '2026-06-14T12:00:01Z',
      '2026-07-14T12:00:01Z',
      '2026-08-14T12:00:01Z',
    ]);
  });

  it('finishes settling a first invoice an interrupted start left pending', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    failOnce(env.context.engine, 'transitionInvoice', (_id: string, to: string) => to === 'success');
    await api.advance('1s');
    await api.advance('1h');
    expect(await sent(env, 'invoice.paid')).toHaveLength(1);
    const [subscription] = await api.subscriptionsOf(customerId);
    expect(await invoiceStatuses(subscription!.id)).toEqual(['success']);
  });

  it('completes, rather than expires, a trial checkout whose subscription started before an interruption', async () => {
    const productId = await api.product({ currency: 'USD', amount: '10.00' }, {
      billing_cycle: { interval: 'month', frequency: 1 },
      trial_period: { interval: 'day', frequency: 14 },
    });
    const customerId = await api.customer();
    const session = await api.checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    // The fulfilment record is the last write; lose it.
    failOnce(env.context.storage.providerState, 'put', (_p: string, key: string) => key.startsWith('checkout-fulfilment:'));
    const started = await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(started.statusCode).toBe(500);
    await api.advance('1h');
    expect(await sent(env, 'checkout.expired')).toHaveLength(0);
    expect((await sent(env, 'checkout.completed'))[0]?.data.subscription).toMatchObject({ subscription_id: expect.stringMatching(/^sub_/) });
    expect((await api.get(`/v1/checkout-sessions/${session.id}`)).json().status).toBe('completed');
  });

  it("reads past_due, not active, while money is owed on a subscription paybox's tooling disabled", async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    const core = await env.context.storage.subscriptions.byCode('bachs', subscription.id);
    await env.app.inject({ method: 'POST', url: `/api/subscriptions/${core!.id}/disable`, payload: {} });
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json()).toMatchObject({ status: 'past_due', cancel_at_period_end: true });
    expect((await sent(env, 'customer.subscription.updated')).at(-1)?.data.status).toBe('past_due');
    const canceled = await api.del(`/v1/subscriptions/${subscription.id}`);
    expect(canceled.json().status).toBe('canceled');
    expect((await sent(env, 'customer.subscription.deleted'))[0]?.data.status).toBe('canceled');
    const again = await api.del(`/v1/subscriptions/${subscription.id}`);
    expect(again.json().error_code).toBe('SUBSCRIPTION_ALREADY_CANCELED');
  });
});

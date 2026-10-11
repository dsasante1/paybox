import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs saved cards, off-session charges, the customer portal and product
 * groups (guides/payments/charge-a-saved-card, guides/customer-portal/*,
 * the pinned OpenAPI document; read 2026-10-10).
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

describe('saving a card', () => {
  it('saves without charging; the same card twice is one pm_; the first saved is the default', async () => {
    const customerId = await api.customer();
    const first = await api.saveCard(customerId);
    expect(first).toMatch(/^pm_[0-9a-f]{20}$/);
    expect((await sent(env, 'checkout.completed'))[0]?.data).toMatchObject({
      mode: 'setup',
      payment_status: 'no_payment_required',
      subscription: null,
    });
    expect(await sent(env, 'collection.succeeded')).toHaveLength(0);

    const again = await api.saveCard(customerId);
    expect(again).toBe(first);
    expect(await sent(env, 'payment_method.saved')).toHaveLength(1);

    const second = await api.saveCard(customerId, '5555555555554444');
    const saved = await sent(env, 'payment_method.saved');
    expect(saved.map((event) => [event.data.payment_method_id, event.data.is_default])).toEqual([
      [first, true],
      [second, false],
    ]);
  });

  it('saves while the customer pays, and refuses a checkout that offers no card', async () => {
    const customerId = await api.customer();
    const session = await api.checkout({
      pricing: { currency: 'USD', amount: '29.00' },
      customer: { customer_id: customerId },
      save_payment_method: true,
    });
    await api.payByCard(session.path);
    expect(await sent(env, 'collection.succeeded')).toHaveLength(1);
    expect((await sent(env, 'payment_method.saved'))[0]?.data).toMatchObject({ card_last4: '4242', is_default: true });

    const refused = await api.post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', amount: '29.00', price_type: 'free' },
      customer: { customer_id: customerId },
      save_payment_method: true,
    });
    expect(refused.json().error_code).toBe('CHECKOUT_CANNOT_SAVE_PAYMENT_METHOD');
    const noCustomer = await api.post('/v1/checkout-sessions', { save_payment_method: true });
    expect(noCustomer.statusCode).toBe(400);
    expect(noCustomer.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('saves nothing when the card is refused, or when the payer pays another way', async () => {
    const customerId = await api.customer();
    const setup = await api.checkout({ customer: { customer_id: customerId }, save_payment_method: true });
    const refused = await api.pagePost(`${setup.path}/pay`, { corridor: 'USD_CARD', card_number: '4000000000000002' });
    expect(refused.body).toContain('Your card was declined.');
    expect(await sent(env, 'payment_method.saved')).toHaveLength(0);

    const ngn = await api.checkout({
      pricing: { currency: 'NGN', amount: '5000.00' },
      customer: { customer_id: customerId },
      save_payment_method: true,
    });
    await api.pagePost(`${ngn.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });
    await api.pagePost(`${ngn.path}/simulate`, { action: 'succeed' });
    await api.advance('1s');
    expect(await sent(env, 'collection.succeeded')).toHaveLength(1);
    expect(await sent(env, 'payment_method.saved')).toHaveLength(0);
  });
});

describe('POST /v1/charges', () => {
  it('answers processing, then settles a second later with collection.succeeded', async () => {
    const customerId = await api.customer();
    const pm = await api.saveCard(customerId);
    const response = await api.post(
      '/v1/charges',
      { customer: customerId, payment_method: pm, amount: '29.00', currency: 'USD', description: 'April usage', reference: 'INV-2026-04-881' },
      { 'idempotency-key': 'invoice-2026-04' },
    );
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'processing',
      amount: '29.00',
      amount_paid: '0.00',
      currency: 'USD',
      payment_method: 'USD_CARD',
      checkout_id: null,
      narration: 'April usage',
      reference: 'INV-2026-04-881',
      billing_reason: 'purchase',
      channel: 'api',
    });
    // A retry with the same key returns the original charge.
    const replay = await api.post(
      '/v1/charges',
      { customer: customerId, payment_method: pm, amount: '29.00', currency: 'USD', description: 'April usage', reference: 'INV-2026-04-881' },
      { 'idempotency-key': 'invoice-2026-04' },
    );
    expect(replay.json().payment_id).toBe(response.json().payment_id);

    await api.advance('1s');
    const [succeeded] = await sent(env, 'collection.succeeded');
    expect(succeeded?.data).toMatchObject({
      charge_id: response.json().payment_id,
      status: 'SUCCEEDED',
      reference: 'INV-2026-04-881',
      checkout_id: null,
    });
    expect((await api.get(`/v1/payments/${response.json().payment_id}`)).json().status).toBe('succeeded');
  });

  it('charges the default card when none is named, and answers a refusal with 201 failed', async () => {
    const customerId = await api.customer();
    await api.saveCard(customerId, '4000000000000341');
    const response = await api.post('/v1/charges', { customer: customerId, amount: '29.00', currency: 'USD' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'failed', amount_paid: '0.00' });
    expect((await sent(env, 'collection.failed'))[0]?.data).toMatchObject({ status: 'FAILED' });
  });

  it('converts a charge in the other currency at the fixed rate', async () => {
    const customerId = await api.customer();
    await api.saveCard(customerId);
    const response = await api.post('/v1/charges', { customer: customerId, amount: '45000.00', currency: 'NGN' });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ amount: '45000.00', currency: 'NGN', payment_method: 'USD_CARD' });
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', response.json().payment_id);
    const meta = JSON.parse((await env.context.storage.providerState.get('bachs', `payment-meta:${payment!.id}`))!);
    // 45,000.00 NGN at 1,500 to the dollar.
    expect(meta.conversion).toEqual({ cardCurrency: 'USD', cardAmount: 3000, ngnPerUsd: 1500 });
  });

  it('refuses what Bachs refuses, each with its code', async () => {
    const jane = await api.customer();
    const sam = await api.customer('sam@example.com', 'Sam');
    const expectError = async (body: Record<string, unknown>, status: number, code: string) => {
      const response = await api.post('/v1/charges', body);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error_code).toBe(code);
    };
    await expectError({ customer: jane, amount: '29.00', currency: 'USD' }, 400, 'NO_SAVED_PAYMENT_METHOD');
    const samsCard = await api.saveCard(sam);
    // "Cards are scoped to one customer, so another customer's card reads as missing."
    await expectError({ customer: jane, payment_method: samsCard, amount: '29.00', currency: 'USD' }, 404, 'SAVED_PAYMENT_METHOD_NOT_FOUND');
    await expectError({ customer: 'cust_missing', amount: '29.00', currency: 'USD' }, 404, 'NOT_FOUND');
    await expectError({ customer: sam, amount: '29.00', currency: 'GHS' }, 400, 'PAYMENT_METHOD_NOT_ENABLED');

    // A card paybox's own tooling removed is unusable.
    const authorization = await env.context.storage.authorizations.byCode('bachs', samsCard);
    await env.context.engine.deactivateAuthorization(authorization!.id);
    await expectError({ customer: sam, amount: '29.00', currency: 'USD' }, 400, 'PAYMENT_METHOD_UNUSABLE');
  });
});

describe('the customer portal', () => {
  it('hands out a short-lived link that cancels and resumes only its own customer\'s subscriptions', async () => {
    const productId = await api.product();
    const jane = await api.customer();
    const sam = await api.customer('sam@example.com', 'Sam');
    const { subscription } = await api.subscribe(productId, jane);
    const other = await api.subscribe(productId, sam);

    const created = await api.post(`/v1/customers/${jane}/portal-sessions`);
    expect(created.statusCode).toBe(200);
    expect(created.json().id).toMatch(/^psn_[0-9a-f]{12}$/);
    const path = new URL(created.json().url).pathname;
    expect(path).toMatch(/^\/bachs\/portal\/s\/[0-9A-Za-z]{22}$/);

    const page = await api.pageGet(path);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Pro plan');
    expect(page.body).toContain('visa •••• 4242');

    const cancel = await api.pagePost(`${path}/subscriptions/${subscription.id}/cancel`, {});
    expect(cancel.body).toContain('will end at the close');
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().cancel_at_period_end).toBe(true);
    await api.pagePost(`${path}/subscriptions/${subscription.id}/resume`, {});
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().cancel_at_period_end).toBe(false);

    const foreign = await api.pagePost(`${path}/subscriptions/${other.subscription.id}/cancel`, {});
    expect(foreign.statusCode).toBe(404);
    expect((await api.get(`/v1/subscriptions/${other.subscription.id}`)).json().cancel_at_period_end).toBe(false);

    await api.advance('1h');
    const expired = await api.pageGet(path);
    expect(expired.body).toContain('This link has expired');
    const late = await api.pagePost(`${path}/subscriptions/${subscription.id}/cancel`, {});
    expect(late.body).toContain('This link has expired');
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().cancel_at_period_end).toBe(false);

    const missing = await api.post('/v1/customers/cust_missing/portal-sessions');
    expect(missing.statusCode).toBe(404);
  });

  it('takes a recovery payment for a past_due subscription', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('past_due');

    const path = new URL((await api.post(`/v1/customers/${customerId}/portal-sessions`)).json().url).pathname;
    const page = await api.pageGet(path);
    expect(page.body).toContain('A payment is overdue');
    const paid = await api.pagePost(`${path}/subscriptions/${subscription.id}/pay`, { card_number: '5555555555554444' });
    expect(paid.body).toContain('active again');
    const after = (await api.get(`/v1/subscriptions/${subscription.id}`)).json();
    expect(after.status).toBe('active');
    expect(after.payment_method_id).not.toBe(subscription.payment_method_id);
  });
});

describe('product groups', () => {
  it('creates, lists, reads, replaces the members and deletes, leaving products alone', async () => {
    const monthly = await api.product({ currency: 'USD', amount: '10.00' }, { billing_cycle: { interval: 'month', frequency: 1 } }, 'Pro Monthly');
    const yearly = await api.product({ currency: 'USD', amount: '100.00' }, { billing_cycle: { interval: 'year', frequency: 1 } }, 'Pro Yearly');
    const created = await api.post('/v1/product-groups', { name: 'Choose your plan', product_ids: [monthly, yearly] });
    expect(created.statusCode, created.body).toBe(201);
    const group = created.json();
    expect(group.id).toMatch(/^pgrp_[0-9a-f]{20}$/);
    expect(group.products.map((entry: { id: string }) => entry.id)).toEqual([monthly, yearly]);
    expect(group.updated_at).toBe(group.created_at);

    const bad = await api.post('/v1/product-groups', { name: 'Bad', product_ids: ['prod_missing'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_code).toBe('INVALID_PRODUCT_REFERENCE');

    await api.post(`/v1/products/${yearly}/archive`);
    expect((await api.get(`/v1/product-groups/${group.id}`)).json().products).toHaveLength(1);
    expect((await api.get(`/v1/product-groups/${group.id}?include_archived=true`)).json().products).toHaveLength(2);

    await api.advance('1m');
    const replaced = await api.patch(`/v1/product-groups/${group.id}`, { product_ids: [yearly, monthly], name: 'Plans' });
    expect(replaced.json()).toMatchObject({ name: 'Plans' });
    expect(replaced.json().updated_at).not.toBe(group.created_at);

    const list = (await api.get('/v1/product-groups')).json();
    expect(list.items).toHaveLength(1);
    expect(list.pagination).toMatchObject({ total: 1, limit: 20 });

    const removed = await api.del(`/v1/product-groups/${group.id}`);
    expect(removed.statusCode).toBe(204);
    expect((await api.get(`/v1/product-groups/${group.id}`)).statusCode).toBe(404);
    expect((await api.get(`/v1/products/${monthly}`)).statusCode).toBe(200);
  });
});

describe('the worlds no fixture built', () => {
  it('completes a subscription checkout whose payment settles as the session expires, exactly once', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    const session = await api.checkout({
      product_cart: [{ product_id: productId }],
      customer: { customer_id: customerId },
      expires_in_minutes: 1,
    });
    await api.advance('59s');
    await api.pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await api.advance('5m');
    expect(await sent(env, 'checkout.expired')).toHaveLength(0);
    expect(await sent(env, 'customer.subscription.created')).toHaveLength(1);
    expect((await api.get(`/v1/checkout-sessions/${session.id}`)).json().status).toBe('completed');
  });

  it('survives paybox reset mid-subscription', async () => {
    const productId = await api.product();
    const customerId = await api.customer();
    await api.subscribe(productId, customerId);
    const reset = await env.app.inject({ method: 'POST', url: '/api/reset' });
    expect(reset.statusCode, reset.body).toBeLessThan(300);
    await api.advance('60d');
    expect((await api.get('/v1/subscriptions')).json().items).toEqual([]);
  });
});

describe('a restart mid-recovery', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paybox-bachs-billing-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('still runs the retries that were due', async () => {
    await env.close();
    const database = join(dir, 'paybox.db');
    env = await startBachs({ PAYBOX_DATABASE: database });
    api = client(env);
    const productId = await api.product();
    const customerId = await api.customer();
    const { subscription } = await api.subscribe(productId, customerId, '4000000000000341');
    await api.advance('30d');
    expect(await sent(env, 'invoice.payment_failed')).toHaveLength(1);

    await env.close();
    env = await startBachs({ PAYBOX_DATABASE: database });
    api = client(env);
    await api.advance('9d');
    expect(await sent(env, 'invoice.payment_failed')).toHaveLength(4);
    expect((await api.get(`/v1/subscriptions/${subscription.id}`)).json().status).toBe('canceled');
  });
});

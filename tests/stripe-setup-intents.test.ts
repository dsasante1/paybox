import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * SetupIntents: storing an instrument without charging for it.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` schema
 * `setup_intent` (API version 2026-08-26.dahlia, read 2026-08-28).
 *
 * The load-bearing assertion is that a setup produces a PaymentMethod that a
 * later off-session charge and a subscription can both use -- a setup that
 * "succeeds" without leaving something chargeable has achieved nothing.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-04T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'setup';
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

const VISA = '4242424242424242';
const DECLINE = '4000000000000002';
const SCA = '4000002500003155';

const card = (number: string) => ({
  'payment_method_data[type]': 'card',
  'payment_method_data[card][number]': number,
  'payment_method_data[card][exp_month]': '12',
  'payment_method_data[card][exp_year]': '2034',
});

async function customer(email = 'ada@example.com') {
  return (await post('/stripe/v1/customers', { email })).json();
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

async function deliveredTypes(): Promise<string[]> {
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });
  return transport.sent.map((request) => JSON.parse(request.body).type as string);
}

describe('POST /v1/setup_intents', () => {
  it('starts with nothing attached', async () => {
    const setup = (await post('/stripe/v1/setup_intents')).json();

    expect(setup).toMatchObject({
      object: 'setup_intent',
      status: 'requires_payment_method',
      usage: 'off_session',
      payment_method: null,
      last_setup_error: null,
    });
    expect(setup.id).toMatch(/^seti_/);
    expect(setup.client_secret).toContain(setup.id);
  });

  it('moves to requires_confirmation once a card is supplied', async () => {
    const setup = (await post('/stripe/v1/setup_intents', card(VISA))).json();
    expect(setup.status).toBe('requires_confirmation');
  });

  it('confirms inline and yields a chargeable PaymentMethod', async () => {
    const cus = await customer();
    const setup = (
      await post('/stripe/v1/setup_intents', {
        customer: cus.id,
        confirm: 'true',
        ...card(VISA),
      })
    ).json();

    expect(setup.status).toBe('succeeded');
    expect(setup.payment_method).toMatch(/^pm_/);
    expect(setup.customer).toBe(cus.id);

    const pm = (await get(`/stripe/v1/payment_methods/${setup.payment_method}`)).json();
    expect(pm).toMatchObject({ object: 'payment_method', type: 'card' });
    expect(pm.card.last4).toBe('4242');
  });

  it('honours usage=on_session', async () => {
    const setup = (await post('/stripe/v1/setup_intents', { usage: 'on_session' })).json();
    expect(setup.usage).toBe('on_session');
  });

  it('never records money moving', async () => {
    await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(VISA) });

    // A setup is not a payment. If it were modelled as a zero-amount charge it
    // would show up here and quietly corrupt every total.
    const payments = await context.storage.payments.list({ provider: 'stripe' });
    expect(payments.total).toBe(0);
  });
});

describe('confirming separately', () => {
  it('confirms with a previously stored PaymentMethod', async () => {
    const cus = await customer();
    const pm = (
      await post('/stripe/v1/payment_methods', {
        type: 'card',
        'card[number]': VISA,
        'card[exp_month]': '12',
        'card[exp_year]': '2034',
      })
    ).json();

    const setup = (await post('/stripe/v1/setup_intents', { customer: cus.id })).json();
    const confirmed = (
      await post(`/stripe/v1/setup_intents/${setup.id}/confirm`, { payment_method: pm.id })
    ).json();

    expect(confirmed.status).toBe('succeeded');
    // Same card, same fingerprint, so one PaymentMethod rather than two.
    expect(confirmed.payment_method).toBe(pm.id);
  });

  it('refuses to confirm with no instrument at all', async () => {
    const setup = (await post('/stripe/v1/setup_intents')).json();
    const response = await post(`/stripe/v1/setup_intents/${setup.id}/confirm`);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('payment_method');
  });
});

describe('one card, two customers', () => {
  it('gives each customer their own PaymentMethod', async () => {
    const ada = await customer('ada@example.com');
    const grace = await customer('grace@example.com');

    const first = (
      await post('/stripe/v1/setup_intents', {
        customer: ada.id,
        confirm: 'true',
        ...card(VISA),
      })
    ).json();
    const second = (
      await post('/stripe/v1/setup_intents', {
        customer: grace.id,
        confirm: 'true',
        ...card(VISA),
      })
    ).json();

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    // A stored instrument belongs to a customer. Deduping across customers
    // would hand Ada's saved card to Grace.
    expect(second.payment_method).not.toBe(first.payment_method);

    const gracesCard = (await get(`/stripe/v1/payment_methods/${second.payment_method}`)).json();
    expect(gracesCard.customer).toBe(grace.id);
  });

  it('still gives one customer a single PaymentMethod for one card', async () => {
    const ada = await customer('ada@example.com');
    const first = (
      await post('/stripe/v1/setup_intents', { customer: ada.id, confirm: 'true', ...card(VISA) })
    ).json();
    const again = (
      await post('/stripe/v1/setup_intents', { customer: ada.id, confirm: 'true', ...card(VISA) })
    ).json();

    expect(again.payment_method).toBe(first.payment_method);
  });

  it('charging a stored card does not mint a second one', async () => {
    const ada = await customer('ada@example.com');
    const setup = (
      await post('/stripe/v1/setup_intents', { customer: ada.id, confirm: 'true', ...card(VISA) })
    ).json();

    await post('/stripe/v1/charges', {
      amount: 1_200,
      currency: 'usd',
      customer: ada.id,
      source: setup.payment_method,
    });

    const stored = await context.storage.authorizations.listByCustomer(
      ada.id.replace('cus_', 'cus_'),
    );
    expect(stored).toHaveLength(1);
  });
});

describe('a declined setup', () => {
  it('reports the reason and stays retryable, as Stripe does', async () => {
    const setup = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(DECLINE) })
    ).json();

    // Stripe has no `failed` SetupIntent status: a decline returns it to
    // requires_payment_method with the reason in last_setup_error.
    expect(setup.status).toBe('requires_payment_method');
    expect(setup.payment_method).toBeNull();
    expect(setup.last_setup_error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
    });
  });

  it('succeeds when confirmed again with a good card', async () => {
    const failed = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(DECLINE) })
    ).json();

    const retried = (
      await post(`/stripe/v1/setup_intents/${failed.id}/confirm`, card(VISA))
    ).json();

    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe('succeeded');
    expect(retried.payment_method).toMatch(/^pm_/);
    // The previous attempt's error must not linger on a live object.
    expect(retried.last_setup_error).toBeNull();
  });
});

describe('a setup that needs authentication', () => {
  it('parks at requires_action with somewhere to send the customer', async () => {
    const setup = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(SCA) })
    ).json();

    expect(setup.status).toBe('requires_action');
    expect(setup.next_action.type).toBe('redirect_to_url');
    expect(setup.next_action.redirect_to_url.url).toContain(`/stripe/setup/${setup.id}`);
  });

  it('serves a real page at that url', async () => {
    const setup = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(SCA) })
    ).json();

    const page = await app.inject({ method: 'GET', url: `/stripe/setup/${setup.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('paybox emulator');
    expect(page.body).toContain('No charge will be made now');
  });

  it('stores the card when the customer confirms', async () => {
    const setup = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(SCA) })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/stripe/setup/${setup.id}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=approve',
    });

    const after = (await get(`/stripe/v1/setup_intents/${setup.id}`)).json();
    expect(after.status).toBe('succeeded');
    expect(after.payment_method).toMatch(/^pm_/);
  });

  it('fails it when the customer refuses', async () => {
    const setup = (
      await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(SCA) })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/stripe/setup/${setup.id}/complete`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=reject',
    });

    const after = (await get(`/stripe/v1/setup_intents/${setup.id}`)).json();
    expect(after.status).toBe('requires_payment_method');
    expect(after.last_setup_error.code).toBe('authentication_required');
    expect(after.payment_method).toBeNull();
  });
});

describe('cancelling', () => {
  it('records the reason and is terminal', async () => {
    const setup = (await post('/stripe/v1/setup_intents')).json();
    const cancelled = (
      await post(`/stripe/v1/setup_intents/${setup.id}/cancel`, {
        cancellation_reason: 'abandoned',
      })
    ).json();

    expect(cancelled).toMatchObject({ status: 'canceled', cancellation_reason: 'abandoned' });

    const again = await post(`/stripe/v1/setup_intents/${setup.id}/cancel`);
    expect(again.statusCode).toBe(400);
  });
});

describe('reading setups back', () => {
  it('updates metadata', async () => {
    const setup = (await post('/stripe/v1/setup_intents')).json();
    const updated = (
      await post(`/stripe/v1/setup_intents/${setup.id}`, {
        description: 'Save card at checkout',
        'metadata[flow]': 'checkout',
      })
    ).json();

    expect(updated.description).toBe('Save card at checkout');
    expect(updated.metadata.flow).toBe('checkout');
  });

  it('lists, and filters by customer', async () => {
    const ada = await customer('ada@example.com');
    const grace = await customer('grace@example.com');
    await post('/stripe/v1/setup_intents', { customer: ada.id });
    await post('/stripe/v1/setup_intents', { customer: grace.id });

    const all = (await get('/stripe/v1/setup_intents')).json();
    expect(all.object).toBe('list');
    expect(all.data.length).toBe(2);

    const mine = (await get(`/stripe/v1/setup_intents?customer=${ada.id}`)).json();
    expect(mine.data.length).toBe(1);
    expect(mine.data[0].customer).toBe(ada.id);
  });

  it('expands the customer, like every other route', async () => {
    const cus = await customer();
    const setup = (await post('/stripe/v1/setup_intents', { customer: cus.id })).json();
    const expanded = (
      await get(`/stripe/v1/setup_intents/${setup.id}?expand[]=customer`)
    ).json();

    expect(expanded.customer).toMatchObject({ object: 'customer', email: 'ada@example.com' });
  });
});

describe('what the setup is for', () => {
  it('charges the stored card off-session afterwards', async () => {
    const cus = await customer();
    const setup = (
      await post('/stripe/v1/setup_intents', {
        customer: cus.id,
        confirm: 'true',
        usage: 'off_session',
        ...card(VISA),
      })
    ).json();

    const charge = (
      await post('/stripe/v1/charges', {
        amount: 4_500,
        currency: 'usd',
        customer: cus.id,
        source: setup.payment_method,
      })
    ).json();

    expect(charge.status).toBe('succeeded');
    expect(charge.amount).toBe(4_500);
  });

  it('subscribes with it', async () => {
    const cus = await customer();
    const setup = (
      await post('/stripe/v1/setup_intents', { customer: cus.id, confirm: 'true', ...card(VISA) })
    ).json();

    const price = (
      await post('/stripe/v1/prices', {
        currency: 'usd',
        unit_amount: 1_200,
        'product_data[name]': 'Monthly',
        'recurring[interval]': 'month',
      })
    ).json();

    const subscription = (
      await post('/stripe/v1/subscriptions', {
        customer: cus.id,
        'items[0][price]': price.id,
        default_payment_method: setup.payment_method,
      })
    ).json();

    expect(subscription.status).toBe('active');
    expect(subscription.default_payment_method).toBe(setup.payment_method);
  });
});

describe('webhooks', () => {
  it('sends the events Stripe sends, and none it does not', async () => {
    await endpoint();

    await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(VISA) });
    const types = await deliveredTypes();

    expect(types).toContain('setup_intent.created');
    expect(types).toContain('setup_intent.succeeded');
    // Stripe emits nothing for requires_confirmation or processing.
    expect(types.filter((t) => t.startsWith('setup_intent.'))).toEqual([
      'setup_intent.created',
      'setup_intent.succeeded',
    ]);
  });

  it('reports a declined setup as setup_intent.setup_failed', async () => {
    await endpoint();

    await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(DECLINE) });
    expect(await deliveredTypes()).toContain('setup_intent.setup_failed');
  });

  it('reports payment_method.attached only when there is a customer', async () => {
    await endpoint();

    // Minted with nobody attached: no attachment happened.
    await post('/stripe/v1/setup_intents', { confirm: 'true', ...card(VISA) });
    expect(await deliveredTypes()).not.toContain('payment_method.attached');

    const cus = await customer('grace@example.com');
    const pm = (
      await post('/stripe/v1/payment_methods', {
        type: 'card',
        'card[number]': '5555555555554444',
      })
    ).json();
    await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: cus.id });

    expect(await deliveredTypes()).toContain('payment_method.attached');
  });
});

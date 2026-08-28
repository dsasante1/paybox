import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * The legacy Charges API (`PostCharges`, `stripe/openapi` read 2026-08-28).
 *
 * What these pin is the *difference* from PaymentIntents. A charge is
 * synchronous, so a decline is a 402 rather than a retryable 200 -- and it
 * cannot do SCA at all, which is the wall that pushed Stripe to PaymentIntents
 * in the first place.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-04-02T08:30:00.000Z';
  process.env.PAYBOX_SEED = 'charges';
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

const VISA = '4242424242424242';
/** Stripe's published always-declines card. */
const DECLINE = '4000000000000002';
/** Stripe's published card that always requires 3-D Secure. */
const SCA = '4000002500003155';

async function charge(fields: Record<string, string | number>) {
  return post('/stripe/v1/charges', { amount: 2_000, currency: 'usd', ...fields });
}

describe('POST /v1/charges', () => {
  it('settles synchronously and returns a captured charge', async () => {
    const response = await charge({ 'card[number]': VISA });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      object: 'charge',
      amount: 2_000,
      currency: 'usd',
      status: 'succeeded',
      captured: true,
      paid: true,
      amount_captured: 2_000,
    });
    expect(body.id).toMatch(/^ch_/);
    expect(body.payment_method_details.card.last4).toBe('4242');
  });

  it('is the same underlying resource as the PaymentIntent', async () => {
    const created = (await charge({ 'card[number]': VISA })).json();
    const intentId = created.payment_intent;

    const intent = (await get(`/stripe/v1/payment_intents/${intentId}`)).json();
    expect(intent.status).toBe('succeeded');
    expect(intent.amount).toBe(2_000);
    // Same row, two views -- documented in docs/stripe.md.
    expect(created.id.replace('ch_', '')).toBe(intentId.replace('pi_', ''));
  });

  it('answers a decline with 402 and a card_error, not a retryable object', async () => {
    const response = await charge({ 'card[number]': DECLINE });

    expect(response.statusCode).toBe(402);
    const error = response.json().error;
    expect(error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
    });
    expect(error.charge).toMatch(/^ch_/);
    expect(error.payment_intent).toMatch(/^pi_/);
  });

  it('records the declined attempt so it can still be read back', async () => {
    const failure = (await charge({ 'card[number]': DECLINE })).json().error;
    const readBack = (await get(`/stripe/v1/charges/${failure.charge}`)).json();

    expect(readBack).toMatchObject({
      status: 'failed',
      paid: false,
      captured: false,
      failure_code: 'card_declined',
    });
  });

  it('fails a card that needs SCA, because this API cannot present one', async () => {
    const response = await charge({ 'card[number]': SCA });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({
      type: 'card_error',
      code: 'authentication_required',
    });
    expect(response.json().error.message).toContain('PaymentIntents');
  });

  it('requires a source or a customer', async () => {
    const response = await charge({});
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('source or customer');
  });

  it('rejects an unsupported currency', async () => {
    const response = await charge({ 'card[number]': VISA, currency: 'zzz' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('currency_not_supported');
  });
});

describe('POST /v1/charges with a stored source', () => {
  async function storedCard() {
    const customer = (await post('/stripe/v1/customers', { email: 'ada@example.com' })).json();
    const pm = (
      await post('/stripe/v1/payment_methods', {
        type: 'card',
        'card[number]': VISA,
        'card[exp_month]': '11',
        'card[exp_year]': '2033',
      })
    ).json();
    await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
    return { customerId: customer.id as string, sourceId: pm.id as string };
  }

  it('charges an explicit source', async () => {
    const { sourceId } = await storedCard();
    const body = (await charge({ source: sourceId })).json();
    expect(body.status).toBe('succeeded');
    expect(body.payment_method_details.card.last4).toBe('4242');
  });

  it("falls back to the customer's attached card", async () => {
    const { customerId } = await storedCard();
    const body = (await charge({ customer: customerId })).json();
    expect(body.status).toBe('succeeded');
    expect(body.customer).toBe(customerId);
  });

  it('refuses a customer with nothing attached', async () => {
    const customer = (await post('/stripe/v1/customers', { email: 'nobody@example.com' })).json();
    const response = await charge({ customer: customer.id });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('no attached payment source');
  });
});

describe('authorize and capture', () => {
  it('capture=false authorizes without taking the money', async () => {
    const body = (await charge({ 'card[number]': VISA, capture: 'false' })).json();

    // Stripe reports an uncaptured charge as succeeded-but-not-captured; the
    // status is not where the two are told apart.
    expect(body).toMatchObject({
      status: 'succeeded',
      captured: false,
      paid: true,
      amount_captured: 0,
    });
    expect(body.balance_transaction).toBeNull();
  });

  it('captures it later', async () => {
    const authorized = (await charge({ 'card[number]': VISA, capture: 'false' })).json();
    const captured = (await post(`/stripe/v1/charges/${authorized.id}/capture`)).json();

    expect(captured).toMatchObject({
      id: authorized.id,
      status: 'succeeded',
      captured: true,
      amount_captured: 2_000,
    });
  });

  it('refuses to capture twice', async () => {
    const authorized = (await charge({ 'card[number]': VISA, capture: 'false' })).json();
    await post(`/stripe/v1/charges/${authorized.id}/capture`);
    const again = await post(`/stripe/v1/charges/${authorized.id}/capture`);

    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('already been captured');
  });
});

describe('POST /v1/charges/:charge', () => {
  it('updates description and metadata', async () => {
    const created = (await charge({ 'card[number]': VISA })).json();
    const updated = (
      await post(`/stripe/v1/charges/${created.id}`, {
        description: 'Order 4417',
        'metadata[order_id]': '4417',
      })
    ).json();

    expect(updated.description).toBe('Order 4417');
    expect(updated.metadata.order_id).toBe('4417');
    expect(updated.amount).toBe(2_000);
  });
});

describe('charges and refunds', () => {
  it('refunds a legacy charge by its ch_ id', async () => {
    const created = (await charge({ 'card[number]': VISA })).json();
    const refund = (await post('/stripe/v1/refunds', { charge: created.id, amount: 500 })).json();

    expect(refund).toMatchObject({ object: 'refund', amount: 500, status: 'succeeded' });
    const after = (await get(`/stripe/v1/charges/${created.id}`)).json();
    expect(after.amount_refunded).toBe(500);
    expect(after.refunded).toBe(false);
  });
});

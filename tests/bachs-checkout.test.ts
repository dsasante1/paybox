import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  BACHS_SIGNATURE_HEADER,
  BACHS_SIGNATURE_V2_HEADER,
  BACHS_TIMESTAMP_HEADER,
  signBachsPayload,
  verifyBachsSignatureV2,
} from '@paybox/bachs';

/**
 * Bachs: hosted checkout end to end through the HTTP surface a client uses.
 *
 * REST shapes from the pinned OpenAPI document (docs.bachs.io/docs/openapi/
 * openapi.json, sha256 9c2265585c2b…4810); webhook payloads from the event
 * pages under docs.bachs.io/guides/webhooks/events/; both read 2026-10-10.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'bachs';
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

const auth = () => ({
  authorization: `Bearer ${context.bachsKeys.secretKey}`,
  'content-type': 'application/json',
});
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/bachs${url}`, headers: { ...auth(), ...headers }, payload: (body ?? {}) as object });
const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: auth(), payload: body as object });
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
/** The hosted page: no key, form-encoded, like a payer's browser. */
const pageGet = (path: string) => app.inject({ method: 'GET', url: path });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function endpoint(types: string[] = ['checkout.completed', 'collection.succeeded', 'collection.failed', 'checkout.expired', 'refund.created', 'refund.paid', 'refund.failed', 'collection.underpaid', 'customer.created', 'customer.updated']) {
  const response = await post('/v1/webhooks/endpoints', {
    name: 'Local receiver',
    url: 'https://merchant.example.com/webhooks/bachs',
    event_types: types,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { endpoint_id: string; signing_secret: string };
}

async function product(price: Record<string, unknown> = { currency: 'USD', amount: '29.00' }) {
  const response = await post('/v1/products', { name: 'Pro plan', price });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

/** The path part of a checkout_url. */
const pathOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

function sent(type: string) {
  return transport.sent
    .map((request) => ({ request, body: JSON.parse(request.body) as { id: string; type: string; data: Record<string, unknown> } }))
    .filter(({ body }) => body.type === type);
}

describe('checkout sessions', () => {
  it('creates a session, pays it by card on the hosted page, and settles a second later', async () => {
    const hook = await endpoint();
    const { id: productId } = await product();
    const created = await post('/v1/checkout-sessions', {
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: 'jane@example.com', name: 'Jane Doe' },
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'https://shop.example.com/cart',
      reference: 'order_1042',
      metadata: { order_id: 'ORD-1042' },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    expect(Object.keys(session)).toEqual([
      'checkout_id',
      'checkout_url',
      'status',
      'expires_at',
      'created_at',
      'reference',
      'platform_fee',
      'destination_amount',
    ]);
    expect(session.status).toBe('open');
    expect(session.checkout_id).toMatch(/^chk_[0-9a-f]{32}$/);
    expect(session.expires_at).toBe('2026-06-14T13:00:00.000Z');
    expect(session.platform_fee).toBeNull();

    // Open and unattempted: no charge yet.
    const before = (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json();
    expect(before.status).toBe('open');
    expect(before.charge).toBeNull();
    expect(before.payment_status).toBe('requires_payment_method');
    expect(before.amount).toBe('29.00');
    expect(before.products[0]).toMatchObject({ product_id: productId, unit_amount: '29.00', line_total: '29.00', price_type: 'fixed' });

    const page = await pageGet(pathOf(session.checkout_url));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('paybox test control');

    const paid = await pagePost(`${pathOf(session.checkout_url)}/pay`, {
      corridor: 'USD_CARD',
      card_number: '4242 4242 4242 4242',
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain('Processing');

    const processing = (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json();
    expect(processing.payment_status).toBe('processing');
    expect(processing.charge.status).toBe('processing');
    expect(processing.charge.payment_id).toMatch(/^ch_[0-9a-f]{32}$/);

    await advance('1s');
    const done = (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json();
    expect(done.status).toBe('completed');
    expect(done.payment_status).toBe('succeeded');
    expect(done.payment_method).toBe('CARD');
    expect(done.charge).toMatchObject({
      status: 'succeeded',
      amount: '29.00',
      amount_paid: '29.00',
      amount_remaining: '0.00',
      fees: { amount: '1.85', currency: 'USD' },
      payment_method: 'USD_CARD',
      reference: 'order_1042',
      checkout_id: session.checkout_id,
      is_refundable: true,
    });
    expect(done.completed_at).toBe('2026-06-14T12:00:01.000Z');

    // Both webhooks, signed three ways that agree.
    const [succeeded] = sent('collection.succeeded');
    const [completed] = sent('checkout.completed');
    expect(succeeded?.body.data).toMatchObject({
      charge_id: done.charge.payment_id,
      checkout_id: session.checkout_id,
      status: 'SUCCEEDED',
      amount: '29.00',
      settlement_amount: '27.15',
      processing_fee: '1.85',
      reference: 'order_1042',
      customer: { email: 'jane@example.com', name: 'Jane Doe' },
      metadata: { order_id: 'ORD-1042' },
    });
    expect(completed?.body.data).toMatchObject({
      checkout_id: session.checkout_id,
      status: 'completed',
      mode: 'payment',
      payment_status: 'paid',
      amount: '29.00',
    });
    for (const delivery of [succeeded!, completed!]) {
      const { headers, body: raw } = delivery.request;
      const t = Number(headers[BACHS_TIMESTAMP_HEADER]);
      expect(headers[BACHS_SIGNATURE_HEADER]).toBe(signBachsPayload(raw, hook.signing_secret, t));
      expect(verifyBachsSignatureV2(headers[BACHS_SIGNATURE_V2_HEADER]!, raw, hook.signing_secret, t)).toBe(true);
    }
  });

  it('refunds a settled charge and reports refund.created then refund.paid', async () => {
    await endpoint();
    const { id: productId } = await product();
    const session = (
      await post('/v1/checkout-sessions', {
        product_cart: [{ product_id: productId }],
        customer: { email: 'jane@example.com' },
      })
    ).json();
    await pagePost(`${pathOf(session.checkout_url)}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await advance('1s');
    const charge = (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json().charge;

    const refund = await post('/v1/refunds', { charge_id: charge.payment_id, reference: 'RF-1' });
    expect(refund.statusCode).toBe(201);
    expect(refund.json()).toMatchObject({
      charge_id: charge.payment_id,
      reference: 'RF-1',
      status: 'processing',
      requested_amount: '29.00',
      refunded_amount: null,
      refund_fee_amount: '0.00',
      fee_bearer: 'org',
      completed_at: null,
    });
    expect(refund.json().refund_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // One live refund per charge.
    const second = await post('/v1/refunds', { charge_id: charge.payment_id, reference: 'RF-2' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error_code: 'CONFLICT', detail: 'A refund already exists for this charge' });

    await advance('1s');
    const settled = (await get(`/v1/refunds/${refund.json().refund_id}`)).json();
    expect(settled).toMatchObject({ status: 'success', refunded_amount: '29.00', completed_at: '2026-06-14T12:00:02.000Z' });
    expect(sent('refund.created')[0]?.body.data).toMatchObject({ status: 'processing', fee_bearer: 'merchant' });
    expect(sent('refund.paid')[0]?.body.data).toMatchObject({ status: 'paid', refunded_amount: '29.00' });

    const payment = (await get(`/v1/payments/${charge.payment_id}`)).json();
    expect(payment.status).toBe('refunded');
    expect(payment.refunds).toEqual([refund.json().refund_id]);
  });
});

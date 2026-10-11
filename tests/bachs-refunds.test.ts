import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Bachs: refunds through the HTTP surface a client uses.
 *
 * REST shapes from the pinned OpenAPI document (docs.bachs.io/docs/openapi/
 * openapi.json, sha256 9c2265585c2b…4810: createRefund, listRefunds,
 * getRefund, getRefundByCharge); rules and refusal messages from
 * guides/refunds; webhook payloads from guides/webhooks/events/refund-created,
 * refund-paid and refund-failed. All read 2026-10-10.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function endpoint(types: string[] = ['refund.created', 'refund.paid', 'refund.failed']) {
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

const pathOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

function sent(type: string) {
  return transport.sent
    .map((request) => ({ request, body: JSON.parse(request.body) as { id: string; type: string; data: Record<string, unknown> } }))
    .filter(({ body }) => body.type === type);
}

/**
 * A charge paid on the hosted page. `settle: false` leaves a card charge
 * `processing`; other corridors are pushed through the page's test controls.
 */
async function charge(
  options: {
    price?: Record<string, unknown>;
    corridor?: string;
    form?: Record<string, string>;
    settle?: boolean;
    email?: string;
  } = {},
): Promise<{ payment_id: string; checkout_id: string }> {
  const { id: productId } = await product(options.price);
  const created = await post('/v1/checkout-sessions', {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: options.email ?? 'jane@example.com', name: 'Jane Doe' },
  });
  expect(created.statusCode).toBe(201);
  const session = created.json();
  const corridor = options.corridor ?? 'USD_CARD';
  const paid = await pagePost(`${pathOf(session.checkout_url)}/pay`, {
    corridor,
    ...(corridor.endsWith('CARD') ? { card_number: '4242424242424242' } : {}),
    ...(options.form ?? {}),
  });
  expect(paid.statusCode).toBe(200);
  if (!corridor.endsWith('CARD') && options.settle !== false) {
    const simulated = await pagePost(`${pathOf(session.checkout_url)}/simulate`, { action: 'succeed' });
    expect(simulated.statusCode).toBe(200);
  }
  if (options.settle !== false) await advance('1s');
  const detail = (await get(`/v1/checkout-sessions/${session.checkout_id}`)).json();
  if (options.settle !== false) expect(detail.charge.status).toBe('succeeded');
  return { payment_id: detail.charge.payment_id, checkout_id: session.checkout_id };
}

const refund = (body: Record<string, unknown>) => post('/v1/refunds', body);

describe('refunds: the full path', () => {
  it('creates a processing refund, settles it a second later, and reports created then paid', async () => {
    await endpoint();
    const { payment_id } = await charge();
    transport.sent.length = 0;

    const created = await refund({ charge_id: payment_id, reference: 'RF-1', reason: 'Customer request' });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(Object.keys(body)).toEqual([
      'refund_id',
      'charge_id',
      'reference',
      'status',
      'requested_amount',
      'refunded_amount',
      'refund_fee_amount',
      'fee_bearer',
      'reason',
      'created_at',
      'updated_at',
      'completed_at',
    ]);
    expect(body.refund_id).toMatch(UUID_V4);
    expect(body).toEqual({
      refund_id: body.refund_id,
      charge_id: payment_id,
      reference: 'RF-1',
      status: 'processing',
      requested_amount: '29.00',
      refunded_amount: null,
      refund_fee_amount: '0.00',
      fee_bearer: 'org',
      reason: 'Customer request',
      created_at: '2026-06-14T12:00:01.000Z',
      updated_at: '2026-06-14T12:00:01.000Z',
      completed_at: null,
    });

    // While processing the charge is spoken for.
    const during = (await get(`/v1/payments/${payment_id}`)).json();
    expect(during.is_refundable).toBe(false);

    await advance('1s');
    const settled = (await get(`/v1/refunds/${body.refund_id}`)).json();
    expect(settled).toEqual({
      ...body,
      status: 'success',
      refunded_amount: '29.00',
      updated_at: '2026-06-14T12:00:02.000Z',
      completed_at: '2026-06-14T12:00:02.000Z',
    });

    const createdEvents = sent('refund.created');
    const paidEvents = sent('refund.paid');
    expect(createdEvents).toHaveLength(1);
    expect(paidEvents).toHaveLength(1);
    expect(sent('refund.failed')).toHaveLength(0);
    expect(transport.sent.indexOf(createdEvents[0]!.request)).toBeLessThan(transport.sent.indexOf(paidEvents[0]!.request));
    // The event pages' vocabulary: processing/paid, merchant.
    expect(createdEvents[0]!.body.data).toEqual({
      refund_id: body.refund_id,
      charge_id: payment_id,
      reference: 'RF-1',
      status: 'processing',
      requested_amount: '29.00',
      refunded_amount: '0.00',
      refund_fee_amount: '0.00',
      fee_bearer: 'merchant',
      reason: 'Customer request',
    });
    expect(paidEvents[0]!.body.data).toEqual({
      refund_id: body.refund_id,
      charge_id: payment_id,
      reference: 'RF-1',
      status: 'paid',
      requested_amount: '29.00',
      refunded_amount: '29.00',
      refund_fee_amount: '0.00',
      fee_bearer: 'merchant',
      reason: 'Customer request',
    });

    const payment = (await get(`/v1/payments/${payment_id}`)).json();
    expect(payment.status).toBe('refunded');
    expect(payment.refunds).toEqual([body.refund_id]);
    expect(payment.is_refundable).toBe(false);
  });

  it('a partial refund leaves the charge partially_refunded and takes no second refund', async () => {
    const { payment_id } = await charge();
    const partial = await refund({ charge_id: payment_id, reference: 'RF-P1', amount: '10.00' });
    expect(partial.statusCode).toBe(201);
    expect(partial.json()).toMatchObject({ requested_amount: '10.00', status: 'processing' });
    await advance('1s');
    expect((await get(`/v1/refunds/${partial.json().refund_id}`)).json()).toMatchObject({
      status: 'success',
      refunded_amount: '10.00',
    });
    const payment = (await get(`/v1/payments/${payment_id}`)).json();
    expect(payment.status).toBe('partially_refunded');
    expect(payment.is_refundable).toBe(false);

    // "Once you refund part of a payment, you cannot come back later for the rest."
    const rest = await refund({ charge_id: payment_id, reference: 'RF-P2', amount: '5.00' });
    expect(rest.statusCode).toBe(409);
    expect(rest.json()).toMatchObject({ error_code: 'CONFLICT', detail: 'A refund already exists for this charge' });
  });

  it('a failed refund frees the charge, and a new refund then succeeds', async () => {
    await endpoint();
    const { payment_id } = await charge();
    transport.sent.length = 0;

    const failing = await refund({ charge_id: payment_id, reference: 'RF-F1', simulated_outcome: 'failed' });
    expect(failing.statusCode).toBe(201);
    expect(failing.json().status).toBe('processing');
    await advance('1s');

    const failed = (await get(`/v1/refunds/${failing.json().refund_id}`)).json();
    expect(failed).toMatchObject({
      status: 'failed',
      refunded_amount: null,
      completed_at: '2026-06-14T12:00:02.000Z',
    });
    const failedEvents = sent('refund.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.body.data).toMatchObject({
      refund_id: failing.json().refund_id,
      status: 'failed',
      refunded_amount: '0.00',
      fee_bearer: 'merchant',
    });
    expect(sent('refund.paid')).toHaveLength(0);

    // "A refund that failed does not count."
    const payment = (await get(`/v1/payments/${payment_id}`)).json();
    expect(payment.status).toBe('succeeded');
    expect(payment.is_refundable).toBe(true);

    const retry = await refund({ charge_id: payment_id, reference: 'RF-F2' });
    expect(retry.statusCode).toBe(201);
    await advance('1s');
    expect((await get(`/v1/refunds/${retry.json().refund_id}`)).json()).toMatchObject({
      status: 'success',
      refunded_amount: '29.00',
    });
    expect((await get(`/v1/payments/${payment_id}`)).json().status).toBe('refunded');
    expect(sent('refund.paid')).toHaveLength(1);
  });
});

describe('refunds: one per charge under concurrency', () => {
  it('two concurrent full refunds on one charge give one 201 and one 409', async () => {
    const { payment_id } = await charge();
    const responses = await Promise.all([
      refund({ charge_id: payment_id, reference: 'RF-C1' }),
      refund({ charge_id: payment_id, reference: 'RF-C2' }),
    ]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = responses.find((response) => response.statusCode === 409)!;
    expect(conflict.json()).toMatchObject({ error_code: 'CONFLICT', detail: 'A refund already exists for this charge' });
    expect((await get('/v1/refunds')).json().total).toBe(1);
  });
});

describe('refunds: refusals', () => {
  it('refuses a reference already used on another charge', async () => {
    const first = await charge({ email: 'a@example.com' });
    const second = await charge({ email: 'b@example.com' });
    expect((await refund({ charge_id: first.payment_id, reference: 'RF-DUP' })).statusCode).toBe(201);
    const response = await refund({ charge_id: second.payment_id, reference: 'RF-DUP' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: 'CONFLICT', detail: 'Refund reference already exists' });
    expect((await get(`/v1/payments/${second.payment_id}`)).json().is_refundable).toBe(true);
  });

  it('refuses an amount above the refundable balance', async () => {
    const { payment_id } = await charge();
    const response = await refund({ charge_id: payment_id, reference: 'RF-X', amount: '30.00' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'BAD_REQUEST',
      detail: 'Refund amount `30.00` exceeds refundable balance',
    });
  });

  it('answers 404 for an unknown charge', async () => {
    const response = await refund({ charge_id: 'ch_00000000000000000000000000000000', reference: 'RF-404' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error_code).toBe('NOT_FOUND');
  });

  it('refuses a charge that has not settled', async () => {
    const { payment_id } = await charge({ settle: false });
    const response = await refund({ charge_id: payment_id, reference: 'RF-U' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'BAD_REQUEST',
      detail: 'Charge is not refundable in status `processing`',
    });
  });

  it('refuses an NGN bank-transfer charge', async () => {
    const { payment_id } = await charge({
      price: { currency: 'NGN', amount: '45000.00' },
      corridor: 'NGN_BANK_TRANSFER',
    });
    const payment = (await get(`/v1/payments/${payment_id}`)).json();
    expect(payment.status).toBe('succeeded');
    expect(payment.is_refundable).toBe(false);
    const response = await refund({ charge_id: payment_id, reference: 'RF-NGN' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error_code: 'BAD_REQUEST',
      detail: 'Refunds are not supported for this charge',
    });
  });

  it('refuses a crypto refund without a refund_address and accepts one with it', async () => {
    const { payment_id } = await charge({ corridor: 'CRYPTO', form: { asset: 'USDT_TRC20' } });
    const missing = await refund({ charge_id: payment_id, reference: 'RF-CR1' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error_code).toBe('VALIDATION_ERROR');

    const ok = await refund({ charge_id: payment_id, reference: 'RF-CR2', refund_address: 'TXyz123456789' });
    expect(ok.statusCode).toBe(201);
  });

  it('reads fee_bearer case-insensitively', async () => {
    await endpoint();
    const { payment_id } = await charge();
    const response = await refund({ charge_id: payment_id, reference: 'RF-FB', fee_bearer: 'CUSTOMER' });
    expect(response.statusCode).toBe(201);
    expect(response.json().fee_bearer).toBe('customer');
    await advance('0s');
    expect(sent('refund.created')[0]?.body.data.fee_bearer).toBe('customer');
  });
});

describe('refunds: body idempotency_key', () => {
  it('returns the existing refund for the same key on the same charge', async () => {
    const { payment_id } = await charge();
    const first = await refund({ charge_id: payment_id, reference: 'RF-I1', idempotency_key: 'retry-1' });
    expect(first.statusCode).toBe(201);
    const second = await refund({ charge_id: payment_id, reference: 'RF-I1', idempotency_key: 'retry-1' });
    expect(second.statusCode).toBe(201);
    expect(second.json().refund_id).toBe(first.json().refund_id);
    expect(second.json()).toEqual(first.json());
    expect((await get('/v1/refunds')).json().total).toBe(1);
  });
});

describe('refunds: reading them back', () => {
  it('lists as {total, items}, newest first, filtered by status; reads by id and by charge', async () => {
    const one = await charge({ email: 'a@example.com' });
    const two = await charge({ email: 'b@example.com' });
    const untouched = await charge({ email: 'c@example.com' });

    const failing = (await refund({ charge_id: one.payment_id, reference: 'RF-L1', simulated_outcome: 'failed' })).json();
    await advance('1s');
    const good = (await refund({ charge_id: two.payment_id, reference: 'RF-L2' })).json();
    await advance('1s');

    const listed = await get('/v1/refunds');
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(Object.keys(body)).toEqual(['total', 'items']);
    expect(body.total).toBe(2);
    expect(body.items.map((item: { refund_id: string }) => item.refund_id)).toEqual([good.refund_id, failing.refund_id]);

    const failedOnly = (await get('/v1/refunds?status=failed')).json();
    expect(failedOnly).toMatchObject({ total: 1 });
    expect(failedOnly.items.map((item: { refund_id: string }) => item.refund_id)).toEqual([failing.refund_id]);
    const succeeded = (await get('/v1/refunds?status=success')).json();
    expect(succeeded.items.map((item: { refund_id: string }) => item.refund_id)).toEqual([good.refund_id]);

    const byId = await get(`/v1/refunds/${good.refund_id}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ refund_id: good.refund_id, status: 'success' });
    expect((await get('/v1/refunds/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);

    // By charge: the live refund, not the failed one before it.
    const retry = (await refund({ charge_id: one.payment_id, reference: 'RF-L3' })).json();
    const byCharge = await get(`/v1/refunds/by-charge/${one.payment_id}`);
    expect(byCharge.statusCode).toBe(200);
    expect(byCharge.json()).toMatchObject({ refund_id: retry.refund_id, status: 'processing' });

    const none = await get(`/v1/refunds/by-charge/${untouched.payment_id}`);
    expect(none.statusCode).toBe(404);
    expect(none.json().error_code).toBe('NOT_FOUND');
  });
});

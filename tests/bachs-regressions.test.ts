import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Regressions for the defects the adversarial review of the Bachs adapter
 * found. Each test names the failure it pins; together they are what makes
 * the locks, the orphan adoption and the money fixes claims rather than
 * hopes.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
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

const auth = () => ({ authorization: `Bearer ${context.bachsKeys.secretKey}`, 'content-type': 'application/json' });
const flush = () => context.scheduler.drain();
const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url: `/bachs${url}`, headers: auth(), payload: (body ?? {}) as object });
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
const pagePost = (path: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
const advance = async (value: string) => {
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });
  await flush();
};
const types = () => transport.sent.map((request) => (JSON.parse(request.body) as { type: string }).type);

async function hook() {
  const response = await post('/v1/webhooks/endpoints', {
    name: 'receiver',
    url: 'https://merchant.example.com/hooks',
    event_types: ['checkout.completed', 'checkout.expired', 'collection.succeeded', 'collection.failed', 'refund.created', 'refund.paid'],
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { endpoint_id: string };
}

async function session(body: Record<string, unknown>) {
  const response = await post('/v1/checkout-sessions', {
    customer: { email: 'jane@example.com', name: 'Jane Doe' },
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  const created = response.json() as { checkout_id: string; checkout_url: string };
  return { ...created, path: new URL(created.checkout_url).pathname };
}

const usd = (amount: string) => ({ pricing: { currency: 'USD', amount } });

async function paidCard(amount = '29.00', extra: Record<string, unknown> = {}) {
  const s = await session({ ...usd(amount), ...extra });
  await pagePost(`${s.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
  await advance('1s');
  const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge as { payment_id: string };
  return { ...s, chargeId: charge.payment_id };
}

async function engineId(chargeId: string): Promise<string> {
  const payment = await context.storage.payments.byProviderTransactionId('bachs', chargeId);
  return payment!.id;
}

describe('a checkout is never left open behind an expiry', () => {
  it('serialises the expiry job and a hosted-page payment on one checkout', async () => {
    await hook();
    const s = await session({ ...usd('29.00'), expires_in_minutes: 1 });
    await advance('59s');
    // The expiry fires while the payer is submitting.
    await Promise.all([
      pagePost(`${s.path}/pay`, { corridor: 'USD_CARD', card_number: '4000000000000002' }),
      app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1s' } }),
    ]);
    await flush();
    const after = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json();
    expect(after.status).toBe('expired');
    expect(types().filter((type) => type === 'checkout.expired')).toHaveLength(1);
  });

  it('adopts a payment the engine committed but the checkout never recorded', async () => {
    const s = await session(usd('29.00'));
    // A crash between createPayment and the checkout write leaves exactly this.
    await context.engine.createPayment({
      provider: 'bachs',
      amount: 2900,
      currency: 'USD',
      reference: s.checkout_id,
      providerTransactionId: 'ch_00000000000000000000000000000001',
      status: 'created',
    });
    const paid = await pagePost(`${s.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(paid.body).not.toContain('already been used');
    await advance('1s');
    const after = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json();
    expect(after.status).toBe('completed');
    expect(after.charge.payment_id).toBe('ch_00000000000000000000000000000001');
  });

  it('lets a card already being verified finish after the checkout expires', async () => {
    await hook();
    const s = await session({ ...usd('29.00'), expires_in_minutes: 1 });
    await advance('59s');
    await pagePost(`${s.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    // Expiry and the one-second finalisation land on the same instant.
    await advance('1s');
    const after = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json();
    expect(after.status).toBe('completed');
    expect(types()).not.toContain('checkout.expired');
  });

  it('gives money in flight a grace period, then closes a checkout whose payment failed meanwhile', async () => {
    await hook();
    const s = await session({ ...usd('29.00'), expires_in_minutes: 1 });
    await pagePost(`${s.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge.payment_id as string;
    const id = await engineId(charge);
    // Being verified at expiry, with nothing queued to finish it.
    await context.engine.transitionPayment(id, 'processing');
    await advance('1m');
    expect((await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().status).toBe('open');
    // It fails during the grace period; the second look closes the checkout.
    await context.engine.transitionPayment(id, 'failed', { failureCode: 'provider_error' });
    await advance('1m');
    expect((await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().status).toBe('expired');
    expect(types()).toContain('checkout.expired');
  });

  it('expires a payment paybox tooling moved to authorized', async () => {
    await hook();
    const s = await session({ pricing: { currency: 'GHS', amount: '50.00' }, expires_in_minutes: 1 });
    await pagePost(`${s.path}/pay`, { corridor: 'MOMO_GHS', phone_number: '+233241234567' });
    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge.payment_id as string;
    await app.inject({ method: 'POST', url: `/api/payments/${await engineId(charge)}/authorize` });
    await advance('1m');
    expect((await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().status).toBe('expired');
  });
});

describe('money that did not arrive is never refunded', () => {
  async function cryptoUnderpaid() {
    const s = await session(usd('100.00'));
    await pagePost(`${s.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    await pagePost(`${s.path}/simulate`, { action: 'underpaid' });
    return s;
  }

  it('says an underpaid charge is not refundable, as the API then answers', async () => {
    const s = await cryptoUnderpaid();
    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge;
    expect(charge.status).toBe('underpaid');
    expect(charge.is_refundable).toBe(false);
  });

  it('settles and refunds an accepted underpayment at what was paid', async () => {
    const before = await context.engine.getBalance('bachs', 'USD');
    const s = await cryptoUnderpaid();
    await pagePost(`${s.path}/simulate`, { action: 'accept_underpayment' });
    // $50.00 arrived; Bachs' 1.5% crypto fee on the $100.00 charge comes off
    // at settlement (money out phase).
    expect((await context.engine.getBalance('bachs', 'USD')) - before).toBe(4850);

    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge;
    expect(charge.status).toBe('accepted');
    const refund = await post('/v1/refunds', {
      charge_id: charge.payment_id,
      reference: 'RF-accepted',
      refund_address: 'TQ1xYzTestAddress',
    });
    expect(refund.statusCode, refund.body).toBe(201);
    expect(refund.json().requested_amount).toBe('50.00');
    await advance('1s');
    expect((await get(`/v1/payments/${charge.payment_id}`)).json().status).toBe('refunded');
  });

  it('overpays by at least one minor unit, however small the charge', async () => {
    const s = await session({ pricing: { currency: 'NGN', amount: '150.00', currency_options: { USD: '0.04' } } });
    const page = await pagePost(`${s.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    expect(page.statusCode).toBe(200);
    const overpaid = await pagePost(`${s.path}/simulate`, { action: 'overpaid' });
    expect(overpaid.body).not.toContain('positive integer');
    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge;
    expect(charge).toMatchObject({ status: 'overpaid', amount: '0.04', amount_paid: '0.05' });
  });

  it('credits what an overpayment brought and refuses to refund it', async () => {
    const before = await context.engine.getBalance('bachs', 'USD');
    const s = await session(usd('100.00'));
    await pagePost(`${s.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    await pagePost(`${s.path}/simulate`, { action: 'overpaid' });
    // $110.00 arrived, less the $1.50 fee settled off it.
    expect((await context.engine.getBalance('bachs', 'USD')) - before).toBe(10850);
    const charge = (await get(`/v1/checkout-sessions/${s.checkout_id}`)).json().charge;
    const refund = await post('/v1/refunds', { charge_id: charge.payment_id, reference: 'RF-over' });
    expect(refund.statusCode).toBe(400);
    expect(refund.json().detail).toBe('Charge is not refundable in status `overpaid`');
  });
});

describe('every refund on a Bachs charge counts, however it was made', () => {
  it('lists a refund made by paybox tooling, sends its webhook, and refuses a second', async () => {
    await hook();
    const { chargeId } = await paidCard();
    await app.inject({
      method: 'POST',
      url: `/api/payments/${await engineId(chargeId)}/refund`,
      payload: { amount: 1000, settle: false },
    });
    await flush();
    const listed = (await get('/v1/refunds')).json() as { total: number; items: Array<{ charge_id: string; status: string }> };
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ charge_id: chargeId, status: 'processing' });
    expect(types()).toContain('refund.created');
    const second = await post('/v1/refunds', { charge_id: chargeId, reference: 'RF-second' });
    expect(second.statusCode).toBe(409);
  });

  it('gives one reference to one refund even when two charges race for it', async () => {
    const a = await paidCard('10.00');
    const b = await paidCard('20.00');
    const results = await Promise.all([
      post('/v1/refunds', { charge_id: a.chargeId, reference: 'RF-SAME' }),
      post('/v1/refunds', { charge_id: b.chargeId, reference: 'RF-SAME' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('uniqueness under concurrency', () => {
  it('gives one checkout reference to one session', async () => {
    const results = await Promise.all([
      post('/v1/checkout-sessions', { ...usd('5.00'), reference: 'ORDER-1' }),
      post('/v1/checkout-sessions', { ...usd('5.00'), reference: 'ORDER-1' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('makes one customer from two concurrent creates with one email', async () => {
    const results = await Promise.all([
      post('/v1/customers', { email: 'ada@example.com', name: 'Ada' }),
      post('/v1/customers', { email: 'ada@example.com', phone_number: '+2348012345678' }),
    ]);
    expect(results.map((response) => response.statusCode)).toEqual([201, 201]);
    const ids = results.map((response) => response.json().customer_id as string);
    expect(ids[0]).toBe(ids[1]);
    const list = (await get('/v1/customers')).json() as { pagination: { total: number } };
    expect(list.pagination.total).toBe(1);
    const merged = (await get(`/v1/customers/${ids[0]}`)).json();
    expect(merged).toMatchObject({ name: 'Ada', phone_number: '+2348012345678' });
  });
});

describe('webhook bookkeeping', () => {
  it('replays by checkout reference, not by a refund that reused it', async () => {
    await hook();
    const a = await paidCard('10.00', { reference: 'ORD-1' });
    const b = await paidCard('20.00');
    await post('/v1/refunds', { charge_id: b.chargeId, reference: 'ORD-1' });
    await advance('1s');
    const replay = await post('/v1/webhooks/replay', { reference: 'ORD-1' });
    expect(replay.statusCode, replay.body).toBe(200);
    const event = (await get(`/v1/webhooks/events/${replay.json().event_id}`)).json();
    expect(JSON.stringify(event.payload)).toContain(a.chargeId);
  });

  it('does not leave a resend pending when its endpoint is disabled before it runs', async () => {
    const { endpoint_id } = await hook();
    await paidCard();
    await flush();
    const events = (await get('/v1/webhooks/events')).json() as { items: Array<{ event_id: string }> };
    const eventId = events.items[0]!.event_id;
    const resent = await post(`/v1/webhooks/endpoints/${endpoint_id}/events/${eventId}/resend`);
    expect(resent.statusCode).toBe(200);
    await app.inject({
      method: 'PATCH',
      url: `/bachs/v1/webhooks/endpoints/${endpoint_id}`,
      headers: auth(),
      payload: { enabled: false },
    });
    await flush();
    const detail = (await get(`/v1/webhooks/events/${eventId}`)).json() as { attempts: Array<{ attempt_id: string; status: string }> };
    const attempt = detail.attempts.find((entry) => entry.attempt_id === resent.json().attempt_id);
    expect(attempt?.status).toBe('failed');
  });

  it('clears disabled_reason when paybox tooling turns an endpoint back on', async () => {
    const { endpoint_id } = await hook();
    await context.storage.webhooks.updateEndpoint(endpoint_id, { enabled: false });
    await context.storage.providerState.put(
      'bachs',
      `endpoint:${endpoint_id}`,
      JSON.stringify({ id: endpoint_id, seq: 1, name: 'receiver', eventSource: 'account', disabledAt: '2026-06-17T12:00:00.000Z', disabledReason: 'consecutive_failures' }),
      '2026-06-17T12:00:00.000Z',
    );
    expect((await get(`/v1/webhooks/endpoints/${endpoint_id}`)).json().disabled_reason).toBe('consecutive_failures');
    await app.inject({ method: 'PATCH', url: `/api/webhooks/endpoints/${endpoint_id}`, payload: { enabled: true } });
    const after = (await get(`/v1/webhooks/endpoints/${endpoint_id}`)).json();
    expect(after).toMatchObject({ enabled: true, disabled_at: null, disabled_reason: null });
  });
});

describe('cancel_url', () => {
  it('must be an http or https URL, since the payer is shown it as a link', async () => {
    const response = await post('/v1/checkout-sessions', { ...usd('5.00'), cancel_url: 'javascript:alert(1)' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_ERROR');
  });
});

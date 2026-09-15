import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  parseQuiddpaySignature,
  verifyQuiddpaySignature,
  QUIDDPAY_SIGNATURE_HEADER,
} from '@paybox/quiddpay';

/**
 * Quid Payments: hosted checkout, attempts, the test simulator and webhooks.
 *
 * Shapes transcribed from Quid's published OpenAPI document
 * (`docs.quiddpayments.com/openapi.json`, contract `2026-06`), the merchant
 * guide at `/merchant-api.md` and the webhook and testing pages, all read
 * 2026-09-15.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const API = '/quiddpay/api/v1';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'quiddpay';
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

const key = () => context.quiddpayKeys.apiKey;
const auth = () => ({ authorization: `Bearer ${key()}`, 'content-type': 'application/json' });

const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...auth(), ...headers }, payload: (body ?? {}) as object });

const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: auth(), payload: body as object });

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key()}` } });

/** The public checkout endpoints carry no key: a payer's browser holds none. */
const publicGet = (url: string) => app.inject({ method: 'GET', url });
const publicPost = (url: string, body?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: (body ?? {}) as object,
  });

/** Deliveries are scheduled jobs; moving virtual time is what drains them. */
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

const customer = { name: 'Ama Mensah', email: 'ama@example.com' };

/** paybox's shared last-four convention, which this adapter falls back to. */
const SUCCEEDS = '0550000000';
const DECLINES = '0550000001';

async function openSession(overrides: Record<string, unknown> = {}) {
  const response = await post(`${API}/sessions`, {
    invoice_ref: 'INV-2026-001',
    amount_minor: 307038,
    currency: 'GHS',
    description: 'Order payment',
    customer,
    callback_url: 'https://merchant.example.com/payments/return',
    ...overrides,
  });
  return response.json();
}

async function startMomo(sessionId: string, phone = SUCCEEDS) {
  const response = await publicPost(`${API}/checkout/sessions/${sessionId}/provider-attempts`, {
    rail: 'momo',
    phone,
    operator: 'MTN',
  });
  return { status: response.statusCode, body: response.json() };
}

describe('creating a checkout session', () => {
  it('answers with the shape the merchant guide publishes', async () => {
    const session = await openSession();

    expect(session.id).toMatch(/^cs_/);
    expect(session.status).toBe('open');
    expect(session.amount_minor).toBe(307038);
    expect(session.currency).toBe('GHS');
    expect(session.invoice_ref).toBe('INV-2026-001');
    expect(session.description).toBe('Order payment');
    expect(session.checkout_url).toContain('/quiddpay/checkout/');
    expect(session.expires_at).toBe('2026-06-14T12:30:00.000Z');
    expect(session.environment).toBe('test');
    expect(session.livemode).toBe(false);
  });

  it('never echoes the API key itself', async () => {
    const session = await openSession();

    // `api_key` is required and nullable in the published schema. Echoing the
    // credential would put it in every log that captured a response.
    expect(session.api_key).toEqual({ environment: 'test', label: 'Integration test key' });
    expect(JSON.stringify(session)).not.toContain(key());
  });

  it('honours expires_in_seconds', async () => {
    const session = await openSession({ expires_in_seconds: 600 });
    expect(session.expires_at).toBe('2026-06-14T12:10:00.000Z');
  });

  it('settles in GHS only', async () => {
    const response = await post(`${API}/sessions`, {
      invoice_ref: 'INV-2026-002',
      amount_minor: 1000,
      currency: 'NGN',
      customer,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ARGUMENT');
  });

  it('reports validation failures as a field map, not a coded envelope', async () => {
    const response = await post(`${API}/sessions`, { amount_minor: 1000, customer });

    // Quid's documented validation shape. A client branches on it.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ invoice_ref: ['Invalid input: expected string, received undefined'] });
  });

  it('refuses a live key outright', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API}/payouts/balance`,
      headers: { authorization: 'Bearer ak_live_notarealkey' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    expect(response.json().error.message).toContain('refuses live credentials');
  });
});

describe('invoice lines', () => {
  it('returns the ingest summary the guide publishes', async () => {
    const body = (
      await post(`${API}/invoice-lines`, {
        invoice_ref: 'INV-2026-001',
        currency: 'GHS',
        lines: [
          { code: 'ORDER', name: 'Order payment', amount_minor: 300000 },
          { code: 'DELIVERY', name: 'Order payment', amount_minor: 7038 },
        ],
      })
    ).json();

    expect(body).toEqual({
      object: 'invoice.line_items',
      invoice_ref: 'INV-2026-001',
      ingested: 2,
      billed_minor: 307038,
      errors: [],
    });
  });

  it('replays an unchanged retry and refuses a changed one', async () => {
    const payload = {
      invoice_ref: 'INV-2026-003',
      lines: [{ code: 'ORDER', amount_minor: 500 }],
    };
    const first = await post(`${API}/invoice-lines`, payload, { 'idempotency-key': 'inv-3' });
    const replay = await post(`${API}/invoice-lines`, payload, { 'idempotency-key': 'inv-3' });
    const changed = await post(
      `${API}/invoice-lines`,
      { ...payload, lines: [{ code: 'ORDER', amount_minor: 900 }] },
      { 'idempotency-key': 'inv-3' },
    );

    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['x-paybox-idempotent-replay']).toBe('true');
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('the mobile-money flow', () => {
  it('parks at a prompt, then settles on the wallet PIN', async () => {
    const session = await openSession();
    const started = await startMomo(session.id);

    expect(started.status).toBe(201);
    expect(started.body.rail).toBe('momo');
    expect(started.body.status).toBe('pending');
    expect(started.body.replayed).toBe(false);
    expect(started.body.instructions.type).toBe('momo_prompt');
    // Quid returns the +233 form whichever form was sent.
    expect(started.body.instructions.phone).toBe('+233550000000');

    // The session is `pending` while the prompt is out: not `open`, because an
    // attempt is in flight, and not final, because nobody has answered.
    const during = (await get(`${API}/sessions/${session.id}`)).json();
    expect(during.status).toBe('pending');

    const authorized = (
      await publicPost(
        `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
        { code: '1234' },
      )
    ).json();

    expect(authorized.status).toBe('paid');
    expect(authorized.session_status).toBe('success');
    expect(authorized.finalized).toBe(true);
    expect(authorized.session_finalized_at).toBe('2026-06-14T12:00:00.000Z');
  });

  it('lets the phone number decide, not the PIN', async () => {
    const session = await openSession();
    const started = await startMomo(session.id, DECLINES);

    const authorized = (
      await publicPost(
        `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
        { code: '0000' },
      )
    ).json();

    expect(authorized.status).toBe('failed');
    expect(authorized.session_status).toBe('failed');
    expect(authorized.finalized).toBe(true);
  });

  it('replays the same rail rather than minting a second prompt', async () => {
    const session = await openSession();
    const first = await startMomo(session.id);
    const second = await startMomo(session.id);

    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.attempt_reference).toBe(first.body.attempt_reference);
  });

  it('refuses a different rail while one is in flight', async () => {
    const session = await openSession();
    await startMomo(session.id);

    const response = await publicPost(
      `${API}/checkout/sessions/${session.id}/provider-attempts`,
      { rail: 'cash' },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PAYMENT_ATTEMPT_PENDING');
  });

  it('rejects an amount that does not match the session', async () => {
    const session = await openSession();
    const response = await publicPost(`${API}/checkout/sessions/${session.id}/provider-attempts`, {
      rail: 'momo',
      phone: SUCCEEDS,
      operator: 'MTN',
      amount_minor: 1,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
  });
});

describe('bank transfer and cash', () => {
  it('records a declaration without confirming it', async () => {
    const session = await openSession();
    const started = (
      await publicPost(`${API}/checkout/sessions/${session.id}/provider-attempts`, {
        rail: 'bank_transfer',
        sender: {
          bank_id: 'gcb-bank',
          account_name: 'Ama Mensah',
          account_number: '1234567890',
        },
      })
    ).json();

    expect(started.instructions.type).toBe('bank_transfer');
    expect(started.instructions.transfer_method).toBe('ghipss');

    const declared = (
      await publicPost(
        `${API}/checkout/sessions/${session.id}/provider-attempts/${started.attempt_reference}/payment-declarations`,
      )
    ).json();

    // The payer's claim is recorded; the session is emphatically not final.
    expect(declared.payment_declared_at).toBe('2026-06-14T12:00:00.000Z');
    expect(declared.session_status).toBe('pending');
    expect(declared.finalized).toBe(false);
  });

  it('issues one cash slip per session', async () => {
    const session = await openSession();
    const first = await post(`${API}/checkout/cash-slips`, {
      session_id: session.id,
      amount_minor: 307038,
    });
    const second = await post(`${API}/checkout/cash-slips`, {
      session_id: session.id,
      amount_minor: 307038,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    expect(first.json().can_record).toBe(true);
    // A second slip a teller could also take would collect the invoice twice.
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().slip_token).toBe(first.json().slip_token);
  });
});

describe('the test simulator', () => {
  it('settles a cash deposit that no teller could confirm', async () => {
    const session = await openSession();
    const started = (
      await publicPost(`${API}/checkout/sessions/${session.id}/provider-attempts`, { rail: 'cash' })
    ).json();

    const simulated = (
      await post(`${API}/test/payment-attempts/${started.attempt_reference}/simulate`, {
        outcome: 'paid',
      })
    ).json();

    expect(simulated.outcome).toBe('paid');
    expect(simulated.status).toBe('paid');
    expect(simulated.session_status).toBe('success');
    expect(simulated.environment).toBe('test');
    expect(simulated.livemode).toBe(false);
  });

  it('leaves the session payable for an outcome that is not a decision', async () => {
    const session = await openSession();
    const started = (
      await publicPost(`${API}/checkout/sessions/${session.id}/provider-attempts`, { rail: 'cash' })
    ).json();

    const simulated = (
      await post(`${API}/test/payment-attempts/${started.attempt_reference}/simulate`, {
        outcome: 'manual_review',
      })
    ).json();

    expect(simulated.status).toBe('manual_review');
    expect(simulated.session_status).toBe('pending');

    const attempt = (
      await publicGet(
        `${API}/checkout/sessions/${session.id}/provider-attempts/${started.attempt_reference}`,
      )
    ).json();
    expect(attempt.raw_status).toBe('UNDER_REVIEW');
    expect(attempt.finalized).toBe(false);
  });

  it('refuses to simulate against a session that is already final', async () => {
    const session = await openSession();
    const started = (
      await publicPost(`${API}/checkout/sessions/${session.id}/provider-attempts`, { rail: 'cash' })
    ).json();
    await post(`${API}/test/payment-attempts/${started.attempt_reference}/simulate`, {
      outcome: 'paid',
    });

    const again = await post(`${API}/test/payment-attempts/${started.attempt_reference}/simulate`, {
      outcome: 'failed',
    });

    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SESSION_NOT_PAYABLE');
  });
});

describe('the public checkout view', () => {
  it('shows the payer a narrower session than the merchant sees', async () => {
    const session = await openSession();
    const publicView = (await publicGet(`${API}/checkout/sessions/${session.id}`)).json();

    expect(publicView.merchant_name).toBe('paybox Test Merchant');
    expect(publicView.customer_name).toBe('Ama Mensah');
    expect(publicView.allowed_rails).toEqual(['momo', 'bank_transfer', 'cash']);
    // No credential and no merchant-only link reach a payer's browser.
    expect(publicView.checkout_url).toBeUndefined();
    expect(publicView.api_key).toBeUndefined();
  });

  it('produces a receipt only once the session is paid', async () => {
    const session = await openSession();
    expect((await publicGet(`${API}/checkout/sessions/${session.id}/receipt`)).statusCode).toBe(404);

    const started = await startMomo(session.id);
    await publicPost(
      `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
      { code: '1234' },
    );

    const receipt = (await publicGet(`${API}/checkout/sessions/${session.id}/receipt`)).json();
    expect(receipt.rail).toBe('momo');
    expect(receipt.amount_minor).toBe(307038);
    expect(receipt.is_test).toBe(true);
    expect(receipt.email_status).toBe('pending');
  });

  it('masks a verified wallet to its last four digits', async () => {
    const session = await openSession();
    const verified = (
      await publicPost(`${API}/checkout/sessions/${session.id}/momo-account-verification`, {
        phone: '0241234567',
        operator: 'MTN',
      })
    ).json();

    expect(verified).toEqual({
      operator: 'MTN',
      phone_last4: '4567',
      account_name: 'AMA MENSAH',
    });
  });

  it('records a receipt email without claiming to have sent one', async () => {
    const session = await openSession();
    const response = await put(`${API}/checkout/sessions/${session.id}/receipt-email`, {
      email: 'ama@example.com',
    });

    expect(response.json()).toEqual({ receipt_email_available: true });
  });
});

describe('webhooks', () => {
  async function endpoint() {
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'https://merchant.example.com/hook', provider: 'quiddpay', eventTypes: [] },
    });
    expect(response.statusCode).toBe(201);
  }

  it('signs <t>.<body> with the documented header format', async () => {
    await endpoint();

    const session = await openSession();
    const started = await startMomo(session.id);
    await publicPost(
      `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
      { code: '1234' },
    );
    await advance('30s');

    const delivery = transport.sent.find(
      (request) => request.headers['x-payment-platform-event-type'] === 'checkout.session.completed',
    );
    expect(delivery).toBeDefined();

    const body = JSON.parse(delivery!.body);
    expect(body.type).toBe('checkout.session.completed');
    expect(body.environment).toBe('test');
    expect(body.livemode).toBe(false);
    expect(body.data.session).toEqual({
      id: session.id,
      status: 'success',
      amount_minor: 307038,
      currency: 'GHS',
      invoice_ref: 'INV-2026-001',
      metadata: {},
    });
    // The header repeats the id a consumer is told to deduplicate on.
    expect(delivery!.headers['x-payment-platform-event-id']).toBe(body.id);

    // Signed over the exact bytes sent, and it verifies the way Quid's own
    // checklist says a consumer should verify it.
    expect(delivery!.headers[QUIDDPAY_SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyQuiddpaySignature(
        delivery!.headers[QUIDDPAY_SIGNATURE_HEADER],
        delivery!.body,
        context.quiddpayKeys.signingSecret,
        { now: context.clock.now() },
      ),
    ).toBe(true);
  });

  it('rejects a body altered after signing', async () => {
    await endpoint();

    const session = await openSession();
    const started = await startMomo(session.id);
    await publicPost(
      `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
      { code: '1234' },
    );
    await advance('30s');

    const delivery = transport.sent.find(
      (request) => request.headers['x-payment-platform-event-type'] === 'checkout.session.completed',
    )!;

    expect(
      verifyQuiddpaySignature(
        delivery.headers[QUIDDPAY_SIGNATURE_HEADER],
        delivery.body.replace('307038', '1'),
        context.quiddpayKeys.signingSecret,
        { now: context.clock.now() },
      ),
    ).toBe(false);
  });

  it('emits a test.payment.* event beside the checkout one, and only then', async () => {
    await endpoint();

    // An ordinary hosted checkout: one event, not two.
    const ordinary = await openSession();
    const started = await startMomo(ordinary.id);
    await publicPost(
      `${API}/checkout/sessions/${ordinary.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
      { code: '1234' },
    );
    await advance('30s');
    expect(types()).toEqual(['checkout.session.completed']);

    // Driven through the test simulator: both.
    const simulated = await openSession({ invoice_ref: 'INV-2026-004' });
    const cash = (
      await publicPost(`${API}/checkout/sessions/${simulated.id}/provider-attempts`, {
        rail: 'cash',
      })
    ).json();
    await post(`${API}/test/payment-attempts/${cash.attempt_reference}/simulate`, {
      outcome: 'paid',
    });
    await advance('30s');

    expect(types()).toEqual([
      'checkout.session.completed',
      'checkout.session.completed',
      'test.payment.paid',
    ]);

    const test = transport.sent
      .map((request) => JSON.parse(request.body))
      .find((body) => body.type === 'test.payment.paid');
    expect(test.data.test_payment).toMatchObject({
      payment_reference: cash.attempt_reference,
      session_reference: simulated.id,
      outcome: 'paid',
      rail: 'cash',
      amount_minor: 307038,
      synthetic: true,
    });
  });

  it('re-signs every retry with a fresh timestamp', async () => {
    await endpoint();
    transport.respondWith(() => ({ status: 500, body: 'no', durationMs: 1, error: null }));

    const session = await openSession();
    const started = await startMomo(session.id);
    await publicPost(
      `${API}/checkout/sessions/${session.id}/provider-attempts/${started.body.attempt_reference}/authorize`,
      { code: '1234' },
    );

    // Only far enough to land the first attempt: the exponential ladder would
    // otherwise run to exhaustion inside a single larger advance.
    await advance('1s');
    const before = transport.sent.length;
    expect(before).toBeGreaterThan(0);

    await advance('10m');
    const retries = transport.sent.slice(before);
    expect(retries.length).toBeGreaterThan(0);

    const first = parseQuiddpaySignature(
      transport.sent[0]!.headers[QUIDDPAY_SIGNATURE_HEADER],
    )!;
    const retry = retries.at(-1)!;
    const retrySignature = parseQuiddpaySignature(retry.headers[QUIDDPAY_SIGNATURE_HEADER])!;

    // A replayed signature would fail any correct verifier's tolerance window --
    // teaching a developer to work around a bug the emulator invented.
    expect(retrySignature.timestamp).toBeGreaterThan(first.timestamp);
    expect(retry.headers[QUIDDPAY_SIGNATURE_HEADER]).not.toBe(
      transport.sent[0]!.headers[QUIDDPAY_SIGNATURE_HEADER],
    );

    // Each attempt's MAC is correct for the timestamp that attempt carries.
    // `VirtualClock#at` runs a due job at the instant it was scheduled for, so
    // that timestamp is the retry's own, not the clock's current reading.
    expect(
      verifyQuiddpaySignature(
        retry.headers[QUIDDPAY_SIGNATURE_HEADER],
        retry.body,
        context.quiddpayKeys.signingSecret,
        { now: retrySignature.timestamp * 1000 },
      ),
    ).toBe(true);

    // The id a consumer deduplicates on is stable across the retry.
    expect(retry.headers['x-payment-platform-event-id']).toBe(
      transport.sent[0]!.headers['x-payment-platform-event-id'],
    );
  });

  function types(): string[] {
    return transport.sent.map((request) => request.headers['x-payment-platform-event-type']!);
  }
});

describe('the hosted page', () => {
  it('serves the page checkout_url points at', async () => {
    const session = await openSession();
    const page = await app.inject({ method: 'GET', url: `/quiddpay/checkout/${session.id}` });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Mobile Money');
    // Quid accepts no cards, so the page must not ask for one.
    expect(page.body).not.toContain('Card number');
  });
});

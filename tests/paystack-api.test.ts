import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, type PayboxContext } from '@paybox/api';
import { RecordingTransport, type TransportRequest } from '@paybox/webhooks';
import { verifyPaystackSignature } from '@paybox/paystack';
import { loadConfig } from '@paybox/api';

/**
 * Integration tests over the real HTTP surface.
 *
 * Uses fastify.inject() rather than binding a port: the whole stack runs —
 * routing, hooks, plugins, serialisation — but the suite stays fast and can
 * run in parallel without port collisions.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;
const KEY = 'sk_test_local_suite';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'suite';
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

const auth = { authorization: `Bearer ${KEY}` };

async function initialize(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/paystack/transaction/initialize',
    headers: auth,
    payload: { email: 'dev@example.com', amount: 10_000, currency: 'GHS', ...body },
  });
}

/** Run every job that is due, the way `paybox time advance` does. */
async function advance(duration: string) {
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: duration } });
}

describe('safety (spec §15, §29)', () => {
  it('refuses a live secret key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers: { authorization: 'Bearer sk_live_abc123' },
      payload: { email: 'a@b.com', amount: 100 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/live Paystack secret key/i);
  });

  it('refuses a request with no credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      payload: { email: 'a@b.com', amount: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never stores a full card number or any CVV', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'a@b.com',
        amount: 5_000,
        currency: 'GHS',
        reference: 'card_1',
        card: { number: '4000000000000000', expiry_month: '12', expiry_year: '2030', cvv: '123' },
      },
    });
    const payment = await context.storage.payments.byReference('paystack', 'card_1');
    const serialised = JSON.stringify(payment);
    expect(serialised).not.toContain('4000000000000000');
    expect(serialised).not.toContain('123');
    expect(payment?.paymentMethodDetails.last4).toBe('0000');
  });
});

describe('transaction initialize + verify (spec §33)', () => {
  it('returns Paystack\'s envelope with a working checkout URL', async () => {
    const res = await initialize({ reference: 'order_1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe(true);
    expect(body.message).toBe('Authorization URL created');
    expect(body.data.reference).toBe('order_1');
    expect(body.data.access_code).toBeTruthy();

    const checkout = await app.inject({
      method: 'GET',
      url: new URL(body.data.authorization_url).pathname,
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.body).toContain('paybox emulator');
  });

  it('verify reports Paystack status vocabulary, not ours', async () => {
    await initialize({ reference: 'order_2' });
    const pending = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/verify/order_2',
      headers: auth,
    });
    expect(pending.json().data.status).toBe('pending');

    const payment = await context.storage.payments.byReference('paystack', 'order_2');
    await context.simulator.apply(payment!.id, 'success');

    const done = await app.inject({
      method: 'GET',
      url: '/paystack/transaction/verify/order_2',
      headers: auth,
    });
    const data = done.json().data;
    expect(data.status).toBe('success');
    expect(data.gateway_response).toBe('Successful');
    expect(data.paid_at).toBeTruthy();
    // The log history is built from the canonical event timeline.
    expect(data.log.history.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate reference', async () => {
    await initialize({ reference: 'dupe' });
    const res = await initialize({ reference: 'dupe' });
    expect(res.statusCode).toBe(400);
    expect(res.json().status).toBe(false);
  });

  it('accepts amount as a string, as many integrations send it', async () => {
    const res = await initialize({ reference: 'str_amt', amount: '15000' });
    expect(res.statusCode).toBe(200);
    const payment = await context.storage.payments.byReference('paystack', 'str_amt');
    expect(payment?.amount).toBe(15_000);
  });
});

describe('mobile money (spec §5)', () => {
  it('returns immediately as pending and settles asynchronously', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'kofi@example.com',
        amount: 20_000,
        currency: 'GHS',
        reference: 'momo_1',
        mobile_money: { phone: '0550000000', provider: 'mtn' },
      },
    });
    // The API answers before the customer has done anything — the asymmetry
    // that makes mobile money hard to integrate and hard to test.
    expect(res.json().data.status).toBe('pay_offline');
    expect(res.json().data.display_text).toMatch(/approve/i);

    const payment = await context.storage.payments.byReference('paystack', 'momo_1');
    expect(payment?.status).toBe('requires_action');

    await advance('5s');
    const settled = await context.storage.payments.byReference('paystack', 'momo_1');
    expect(settled?.status).toBe('successful');
    expect(settled?.providerStatus).toBe('success');
  });

  it('a rejecting test number fails the payment with the right reason', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'ama@example.com',
        amount: 1_000,
        currency: 'GHS',
        reference: 'momo_reject',
        mobile_money: { phone: '0550000008', provider: 'atl' },
      },
    });
    await advance('5s');
    const payment = await context.storage.payments.byReference('paystack', 'momo_reject');
    expect(payment?.status).toBe('failed');
    expect(payment?.failureCode).toBe('authorization_rejected');
  });
});

describe('idempotency (spec §16)', () => {
  it('returns the original response for a repeated identical request', async () => {
    const headers = { ...auth, 'idempotency-key': 'key-1' };
    const payload = { email: 'a@b.com', amount: 700, currency: 'GHS' };
    const first = await app.inject({ method: 'POST', url: '/paystack/transaction/initialize', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/paystack/transaction/initialize', headers, payload });
    const third = await app.inject({ method: 'POST', url: '/paystack/transaction/initialize', headers, payload });

    expect(second.json().data.reference).toBe(first.json().data.reference);
    expect(third.json().data.reference).toBe(first.json().data.reference);
    expect(second.headers['x-paybox-idempotent-replay']).toBe('true');

    const { total } = await context.storage.payments.list({ limit: 100 });
    expect(total).toBe(1);
  });

  it('conflicts when the same key is reused with a different body', async () => {
    const headers = { ...auth, 'idempotency-key': 'key-2' };
    await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers,
      payload: { email: 'a@b.com', amount: 700, currency: 'GHS' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers,
      payload: { email: 'a@b.com', amount: 800, currency: 'GHS' },
    });
    expect(conflict.statusCode).toBe(409);
  });
});

describe('webhooks (spec §9, §10)', () => {
  async function registerEndpoint(url = 'http://localhost:4000/hook') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url, secret: KEY },
    });
    return res.json();
  }

  it('delivers a correctly signed charge.success', async () => {
    await registerEndpoint();
    await initialize({ reference: 'wh_1' });
    const payment = await context.storage.payments.byReference('paystack', 'wh_1');
    await context.simulator.apply(payment!.id, 'success');
    await advance('1s');

    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0] as TransportRequest;
    const body = JSON.parse(sent.body);
    expect(body.event).toBe('charge.success');
    expect(body.data.reference).toBe('wh_1');

    const signature = sent.headers['x-paystack-signature'];
    expect(signature).toBeTruthy();
    // Verified over the exact bytes sent, which is what Paystack does.
    expect(verifyPaystackSignature(sent.body, KEY, signature!)).toBe(true);
  });

  it('does not emit a webhook for a failed charge, matching Paystack', async () => {
    await registerEndpoint();
    await initialize({ reference: 'wh_fail' });
    const payment = await context.storage.payments.byReference('paystack', 'wh_fail');
    await context.simulator.apply(payment!.id, 'declined');
    await advance('1s');

    // Paystack's documented event list has no charge.failed. Emitting one
    // would train integrations to expect a callback production never sends.
    expect(transport.sent).toHaveLength(0);
  });

  it('retries a failing endpoint and exhausts on the configured limit', async () => {
    await registerEndpoint();
    transport.respondWith(() => ({ status: 500, body: 'boom', durationMs: 2, error: null }));

    await initialize({ reference: 'wh_retry' });
    const payment = await context.storage.payments.byReference('paystack', 'wh_retry');
    await context.simulator.apply(payment!.id, 'success');

    await advance('1s');
    await advance('2h');

    const { items } = await context.storage.webhooks.listDeliveries({ limit: 10 });
    const delivery = items[0]!;
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempt).toBe(delivery.maxAttempts);
    expect(transport.sent.length).toBe(delivery.maxAttempts);
  });

  it('replay creates a new delivery with a byte-identical payload', async () => {
    await registerEndpoint();
    await initialize({ reference: 'wh_replay' });
    const payment = await context.storage.payments.byReference('paystack', 'wh_replay');
    await context.simulator.apply(payment!.id, 'success');
    await advance('1s');

    const { items } = await context.storage.webhooks.listDeliveries({ limit: 10 });
    const original = items[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/deliveries/${original.id}/replay`,
    });
    expect(res.statusCode).toBe(200);
    await advance('1s');

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.body).toBe(transport.sent[0]!.body);
    expect(transport.sent[1]!.headers['x-paystack-signature']).toBe(
      transport.sent[0]!.headers['x-paystack-signature'],
    );
    expect(res.json().replayOfDeliveryId).toBe(original.id);
  });

  it('duplicate chaos delivers every webhook twice', async () => {
    await registerEndpoint();
    await app.inject({ method: 'POST', url: '/api/webhooks/chaos', payload: { duplicate: true } });
    await initialize({ reference: 'wh_dupe' });
    const payment = await context.storage.payments.byReference('paystack', 'wh_dupe');
    await context.simulator.apply(payment!.id, 'success');
    await advance('1s');
    expect(transport.sent).toHaveLength(2);
  });
});

describe('refunds over the provider API (spec §18)', () => {
  async function succeededPayment(reference: string, amount = 10_000) {
    await initialize({ reference, amount });
    const payment = await context.storage.payments.byReference('paystack', reference);
    await context.simulator.apply(payment!.id, 'success');
    return payment!;
  }

  it('queues a partial refund and enforces the remaining balance', async () => {
    await succeededPayment('rf_1');
    const first = await app.inject({
      method: 'POST',
      url: '/paystack/refund',
      headers: auth,
      payload: { transaction: 'rf_1', amount: 4_000 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().message).toMatch(/queued/i);

    const tooMuch = await app.inject({
      method: 'POST',
      url: '/paystack/refund',
      headers: auth,
      payload: { transaction: 'rf_1', amount: 7_000 },
    });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().message).toMatch(/exceeds/i);
  });
});

describe('time control (spec §39)', () => {
  it('expires an abandoned checkout without waiting', async () => {
    await initialize({ reference: 'expire_1' });
    const before = await context.storage.payments.byReference('paystack', 'expire_1');
    expect(before?.status).toBe('pending');

    // Checkout links live an hour; advance past it.
    await advance('61m');

    const after = await context.storage.payments.byReference('paystack', 'expire_1');
    expect(after?.status).toBe('expired');
    expect(after?.providerStatus).toBe('abandoned');
  });

  it('does not expire a payment that already succeeded', async () => {
    await initialize({ reference: 'expire_2' });
    const payment = await context.storage.payments.byReference('paystack', 'expire_2');
    await context.simulator.apply(payment!.id, 'success');
    await advance('3h');
    const after = await context.storage.payments.byReference('paystack', 'expire_2');
    expect(after?.status).toBe('successful');
  });
});

describe('network simulation (spec §40)', () => {
  it('fails provider requests at the configured rate in the provider\'s own error shape', async () => {
    await app.inject({ method: 'POST', url: '/api/network', payload: { failureRate: 1 } });
    const res = await initialize({ reference: 'net_1' });
    expect(res.statusCode).toBe(500);
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/simulated by paybox/);

    await app.inject({ method: 'DELETE', url: '/api/network' });
    expect((await initialize({ reference: 'net_2' })).statusCode).toBe(200);
  });

  it('leaves the control plane reachable while providers are failing', async () => {
    await app.inject({ method: 'POST', url: '/api/network', payload: { failureRate: 1 } });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});

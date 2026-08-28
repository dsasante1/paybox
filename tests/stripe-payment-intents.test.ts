import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { verifyStripeSignature } from '@paybox/stripe';

/**
 * The Stripe-compatible surface.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia) and docs.stripe.com/testing, both read 2026-08-28.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'stripe';
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
const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const CARD_INSUFFICIENT = '4000000000009995';
const CARD_3DS = '4000002500003155';

/** Stripe takes form-encoded bodies with bracketed keys, and nothing else. */
function form(fields: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

async function post(url: string, fields: Record<string, string | number | undefined>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: auth });
}

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function intentWithCard(number: string, extra: Record<string, string> = {}) {
  const res = await post('/stripe/v1/payment_intents', {
    amount: 2000,
    currency: 'usd',
    confirm: 'true',
    'payment_method_data[type]': 'card',
    'payment_method_data[card][number]': number,
    'payment_method_data[card][exp_month]': '12',
    'payment_method_data[card][exp_year]': '2034',
    ...extra,
  });
  return res;
}

describe('authentication (spec §15, §29)', () => {
  it('refuses a live secret key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: { authorization: 'Bearer sk_live_abc', 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ amount: 100, currency: 'usd' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/live Stripe secret key/i);
  });

  it('refuses a request with no credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ amount: 100, currency: 'usd' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('accepts Basic auth, which Stripe SDKs also use', async () => {
    const basic = Buffer.from('sk_test_local_suite:').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({ amount: 2000, currency: 'usd' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('payment_intent');
  });
});

describe('creating a PaymentIntent', () => {
  it('starts at requires_payment_method with nothing attached', async () => {
    const res = await post('/stripe/v1/payment_intents', { amount: 2000, currency: 'usd' });

    expect(res.statusCode).toBe(200);
    const pi = res.json();
    expect(pi.object).toBe('payment_intent');
    expect(pi.id).toMatch(/^pi_/);
    expect(pi.status).toBe('requires_payment_method');
    expect(pi.amount).toBe(2000);
    expect(pi.currency).toBe('usd');
    expect(pi.client_secret).toContain(pi.id);
    expect(pi.livemode).toBe(false);
    // Stripe timestamps are unix seconds, not ISO strings.
    expect(typeof pi.created).toBe('number');
    expect(pi.created).toBe(Math.floor(Date.parse('2026-01-01T09:00:00.000Z') / 1000));
  });

  it('reads bracketed metadata out of the form body', async () => {
    const res = await post('/stripe/v1/payment_intents', {
      amount: 2000,
      currency: 'usd',
      'metadata[order_id]': 'A-1',
      'metadata[customer_note]': 'gift wrap',
    });
    expect(res.json().metadata.order_id).toBe('A-1');
    expect(res.json().metadata.customer_note).toBe('gift wrap');
  });

  it('rejects an unsupported currency', async () => {
    const res = await post('/stripe/v1/payment_intents', { amount: 2000, currency: 'xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('currency_not_supported');
  });
});

describe('confirming', () => {
  it('settles a successful card', async () => {
    const created = await intentWithCard(CARD_OK);
    expect(created.json().status).toBe('processing');

    await advance('30s');
    const pi = (await get(`/stripe/v1/payment_intents/${created.json().id}`)).json();
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received).toBe(2000);
    expect(pi.latest_charge).toMatch(/^ch_/);
  });

  it('returns a declined intent to requires_payment_method, not a failed status', async () => {
    // Stripe has no terminal failure on an intent: it comes back ready to
    // retry, with the reason in last_payment_error.
    const created = await intentWithCard(CARD_DECLINED);
    await advance('30s');

    const pi = (await get(`/stripe/v1/payment_intents/${created.json().id}`)).json();
    expect(pi.status).toBe('requires_payment_method');
    expect(pi.last_payment_error.code).toBe('card_declined');
    expect(pi.last_payment_error.decline_code).toBe('generic_decline');
    expect(pi.amount_received).toBe(0);
  });

  it('reports the documented decline code for insufficient funds', async () => {
    const created = await intentWithCard(CARD_INSUFFICIENT);
    await advance('30s');
    const pi = (await get(`/stripe/v1/payment_intents/${created.json().id}`)).json();
    expect(pi.last_payment_error.decline_code).toBe('insufficient_funds');
  });

  it('parks a 3-D Secure card at requires_action with a next_action', async () => {
    const created = await intentWithCard(CARD_3DS);
    await advance('30s');

    const pi = (await get(`/stripe/v1/payment_intents/${created.json().id}`)).json();
    expect(pi.status).toBe('requires_action');
    expect(pi.next_action.type).toBe('redirect_to_url');
    expect(pi.next_action.redirect_to_url.url).toContain(pi.id);
  });

  it('retries a declined intent on the same id', async () => {
    // The whole reason the engine grew a `retry` flag.
    const created = await intentWithCard(CARD_DECLINED);
    await advance('30s');
    const id = created.json().id as string;
    expect((await get(`/stripe/v1/payment_intents/${id}`)).json().status).toBe(
      'requires_payment_method',
    );

    const retried = await post(`/stripe/v1/payment_intents/${id}/confirm`, {
      'payment_method_data[type]': 'card',
      'payment_method_data[card][number]': CARD_OK,
    });
    expect(retried.statusCode).toBe(200);
    await advance('30s');

    const pi = (await get(`/stripe/v1/payment_intents/${id}`)).json();
    expect(pi.id).toBe(id);
    expect(pi.status).toBe('succeeded');
    // The stale decline must not survive onto an intent that then succeeded.
    expect(pi.last_payment_error).toBeNull();
  });
});

describe('separate capture', () => {
  it('holds at requires_capture and captures on demand', async () => {
    const created = await intentWithCard(CARD_OK, { capture_method: 'manual' });
    const id = created.json().id as string;

    // Card authorization is synchronous at Stripe, so confirming a
    // manual-capture intent comes straight back as requires_capture. paybox
    // models that state as its canonical `authorized`.
    expect(created.json().status).toBe('requires_capture');
    expect(created.json().amount_capturable).toBe(2000);
    expect((await get(`/stripe/v1/payment_intents/${id}`)).json().status).toBe(
      'requires_capture',
    );

    const captured = await post(`/stripe/v1/payment_intents/${id}/capture`, {});
    expect(captured.json().status).toBe('succeeded');
  });

  it('refuses to capture an intent that is not awaiting capture', async () => {
    const created = await intentWithCard(CARD_OK);
    const res = await post(`/stripe/v1/payment_intents/${created.json().id}/capture`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('payment_intent_unexpected_state');
  });
});

describe('cancelling', () => {
  it('cancels an unconfirmed intent', async () => {
    const created = await post('/stripe/v1/payment_intents', { amount: 2000, currency: 'usd' });
    const res = await post(`/stripe/v1/payment_intents/${created.json().id}/cancel`, {});
    expect(res.json().status).toBe('canceled');
    expect(res.json().cancellation_reason).toBe('requested_by_customer');
    expect(typeof res.json().canceled_at).toBe('number');
  });
});

describe('charges', () => {
  it('exposes the charge behind a settled intent', async () => {
    const created = await intentWithCard(CARD_OK);
    await advance('30s');
    const chargeId = (await get(`/stripe/v1/payment_intents/${created.json().id}`)).json()
      .latest_charge as string;

    const charge = (await get(`/stripe/v1/charges/${chargeId}`)).json();
    expect(charge.object).toBe('charge');
    expect(charge.status).toBe('succeeded');
    expect(charge.paid).toBe(true);
    expect(charge.captured).toBe(true);
    expect(charge.payment_intent).toBe(created.json().id);
    expect(charge.payment_method_details.card.last4).toBe('4242');
  });

  it('marks the charge failed even though its intent is retryable', async () => {
    // Charges are immutable attempt records: `failed` here IS terminal.
    const created = await intentWithCard(CARD_DECLINED);
    await advance('30s');
    const chargeId = created.json().id.replace(/^pi_/, 'ch_');

    const charge = (await get(`/stripe/v1/charges/${chargeId}`)).json();
    expect(charge.status).toBe('failed');
    expect(charge.paid).toBe(false);
    expect(charge.failure_code).toBe('card_declined');
    expect(charge.outcome.type).toBe('issuer_declined');
  });
});

describe('refunds', () => {
  it('refunds a settled intent', async () => {
    const created = await intentWithCard(CARD_OK);
    await advance('30s');

    const refund = await post('/stripe/v1/refunds', {
      payment_intent: created.json().id,
      amount: 500,
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json().object).toBe('refund');
    expect(refund.json().id).toMatch(/^re_/);
    expect(refund.json().status).toBe('succeeded');
    expect(refund.json().amount).toBe(500);

    const charge = (await get(`/stripe/v1/charges/${created.json().id.replace(/^pi_/, 'ch_')}`)).json();
    expect(charge.amount_refunded).toBe(500);
    expect(charge.refunded).toBe(false);
  });

  it('refuses to refund more than the charge', async () => {
    const created = await intentWithCard(CARD_OK);
    await advance('30s');
    const res = await post('/stripe/v1/refunds', {
      payment_intent: created.json().id,
      amount: 999_999,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('charge_already_refunded');
  });
});

describe('customers and payment methods', () => {
  it('creates a customer and attaches a payment method', async () => {
    const customer = await post('/stripe/v1/customers', {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
    expect(customer.json().object).toBe('customer');
    expect(customer.json().id).toMatch(/^cus_/);

    const pm = await post('/stripe/v1/payment_methods', {
      type: 'card',
      'card[number]': CARD_OK,
      'card[exp_month]': '12',
      'card[exp_year]': '2034',
    });
    expect(pm.json().object).toBe('payment_method');
    expect(pm.json().card.last4).toBe('4242');
    expect(pm.json().customer).toBeNull();

    const attached = await post(`/stripe/v1/payment_methods/${pm.json().id}/attach`, {
      customer: customer.json().id,
    });
    expect(attached.json().customer).toBe(customer.json().id);

    const detached = await post(`/stripe/v1/payment_methods/${pm.json().id}/detach`, {});
    expect(detached.json().customer).toBeNull();
  });

  it('refuses a non-card payment method rather than pretending', async () => {
    const res = await post('/stripe/v1/payment_methods', { type: 'sepa_debit' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/only implements card/i);
  });
});

describe('list endpoints', () => {
  it('returns Stripe list envelopes', async () => {
    await post('/stripe/v1/payment_intents', { amount: 100, currency: 'usd' });
    await post('/stripe/v1/payment_intents', { amount: 200, currency: 'usd' });

    const res = (await get('/stripe/v1/payment_intents?limit=1')).json();
    expect(res.object).toBe('list');
    expect(res.url).toBe('/v1/payment_intents');
    expect(res.data).toHaveLength(1);
    expect(res.has_more).toBe(true);
  });

  it('honours the starting_after cursor', async () => {
    await post('/stripe/v1/payment_intents', { amount: 100, currency: 'usd' });
    await post('/stripe/v1/payment_intents', { amount: 200, currency: 'usd' });

    const first = (await get('/stripe/v1/payment_intents?limit=1')).json();
    const next = (
      await get(`/stripe/v1/payment_intents?limit=1&starting_after=${first.data[0].id}`)
    ).json();

    expect(next.data[0].id).not.toBe(first.data[0].id);
  });
});

describe('errors', () => {
  it('answers in Stripe shape, never Paystack shape', async () => {
    const res = await get('/stripe/v1/payment_intents/pi_nope');
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('resource_missing');
    // Paystack's envelope must not leak across the plugin boundary.
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('message');
  });

  it('returns 404 in Stripe shape for an unknown route', async () => {
    const res = await get('/stripe/v1/nonexistent');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('invalid_request_error');
  });
});

describe('webhooks', () => {
  it('signs with a verifiable Stripe-Signature over the virtual clock', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'http://localhost:9999/hook', provider: 'stripe', secret: 'whsec_x' },
    });

    const created = await intentWithCard(CARD_OK);
    await advance('30s');
    expect(created.statusCode).toBe(200);

    const sent = transport.sent.find((r) => r.headers['stripe-signature']);
    expect(sent).toBeTruthy();
    expect(
      verifyStripeSignature(sent!.body, 'whsec_x', sent!.headers['stripe-signature']!, {
        nowMs: context.clock.now(),
      }),
    ).toBe(true);

    const event = JSON.parse(sent!.body);
    expect(event.object).toBe('event');
    expect(event.type).toMatch(/^payment_intent\./);
    expect(event.data.object.object).toBe('payment_intent');
  });
});

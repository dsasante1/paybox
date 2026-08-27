import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Stored authorizations (spec §5) over the real HTTP surface.
 *
 * Endpoint and field shapes verified against the official Paystack OpenAPI
 * specification, `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'authorizations';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

/** Card suffixes select the outcome; see packages/simulator/src/instruments.ts. */
const CARD_SUCCESS = '4000000000000000';
const CARD_INSUFFICIENT = '4000000000000002';
const CARD_3DS = '4000000000000004';

async function chargeCard(number: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email: 'dev@example.com',
      amount: 50_000,
      currency: 'NGN',
      card: { number, expiry_month: '09', expiry_year: '31', cvv: '123' },
      ...extra,
    },
  });
}

async function chargeMomo(phone: string) {
  return app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email: 'momo@example.com',
      amount: 25_000,
      currency: 'GHS',
      mobile_money: { phone, provider: 'mtn' },
    },
  });
}

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function verify(reference: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${reference}`,
    headers: auth,
  });
  return res.json().data;
}

/** Charge a card and advance until it settles, returning its authorization. */
async function settledCardAuthorization(number = CARD_SUCCESS) {
  const charge = await chargeCard(number);
  const reference = charge.json().data.reference as string;
  await advance('30s');
  return { reference, transaction: await verify(reference) };
}

describe('minting (spec §5)', () => {
  it('mints a reusable authorization when a card charge succeeds', async () => {
    const { transaction } = await settledCardAuthorization();

    expect(transaction.status).toBe('success');
    expect(transaction.authorization.authorization_code).toMatch(/^AUTH_/);
    expect(transaction.authorization.reusable).toBe(true);
    expect(transaction.authorization.last4).toBe('0000');
    // The PAN never reaches storage; only the masked fragments do (spec §29).
    expect(JSON.stringify(transaction)).not.toContain(CARD_SUCCESS);
    expect(JSON.stringify(transaction)).not.toContain('123');
  });

  it('mints a non-reusable authorization for mobile money', async () => {
    const charge = await chargeMomo('0550000000');
    const reference = charge.json().data.reference as string;
    await advance('30s');
    const transaction = await verify(reference);

    expect(transaction.status).toBe('success');
    expect(transaction.authorization.reusable).toBe(false);
    expect(transaction.authorization.mobile_money_number).toBe('0550000000');
  });

  it('does not mint an authorization for a charge that failed', async () => {
    const charge = await chargeCard(CARD_INSUFFICIENT);
    const reference = charge.json().data.reference as string;
    await advance('30s');

    expect((await verify(reference)).status).toBe('failed');
    const { total } = await context.storage.authorizations.list();
    expect(total).toBe(0);
  });

  it('dedupes: the same card charged twice yields one authorization', async () => {
    const first = await settledCardAuthorization();
    const second = await settledCardAuthorization();

    expect(second.transaction.authorization.authorization_code).toBe(
      first.transaction.authorization.authorization_code,
    );
    const { total } = await context.storage.authorizations.list();
    expect(total).toBe(1);
  });
});

describe('charge_authorization', () => {
  it('charges a stored card off-session and settles inline', async () => {
    const { transaction } = await settledCardAuthorization();
    const code = transaction.authorization.authorization_code as string;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/charge_authorization',
      headers: auth,
      payload: { email: 'dev@example.com', amount: 12_000, authorization_code: code },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe(true);
    // No prompt, no waiting: the customer is not present, so unlike /charge
    // this comes back already settled without advancing the clock.
    expect(body.data.status).toBe('success');
    expect(body.data.amount).toBe(12_000);
    expect(body.data.authorization.authorization_code).toBe(code);
  });

  it('carries the instrument outcome rather than always succeeding', async () => {
    // The 3-D Secure card only settles once its OTP is submitted, so it mints
    // an authorization whose last four still select a step-up.
    const stepUp = await chargeCard(CARD_3DS);
    const reference = stepUp.json().data.reference as string;
    await advance('30s');
    await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference },
    });
    const code = (await verify(reference)).authorization.authorization_code as string;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/charge_authorization',
      headers: auth,
      payload: { email: 'dev@example.com', amount: 7_000, authorization_code: code },
    });

    // A card that needs the customer present cannot settle off-session: it
    // parks awaiting the step-up instead of quietly succeeding.
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('ongoing');
  });

  it('refuses a non-reusable (mobile money) authorization', async () => {
    const charge = await chargeMomo('0550000000');
    const reference = charge.json().data.reference as string;
    await advance('30s');
    const code = (await verify(reference)).authorization.authorization_code as string;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/charge_authorization',
      headers: auth,
      payload: { email: 'momo@example.com', amount: 5_000, authorization_code: code },
    });

    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/not reusable/i);
  });

  it('refuses an unknown authorization code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/charge_authorization',
      headers: auth,
      payload: { email: 'a@b.com', amount: 1_000, authorization_code: 'AUTH_nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().status).toBe(false);
  });

  it('refuses a deactivated authorization', async () => {
    const { transaction } = await settledCardAuthorization();
    const code = transaction.authorization.authorization_code as string;

    const off = await app.inject({
      method: 'POST',
      url: '/paystack/customer/authorization/deactivate',
      headers: auth,
      payload: { authorization_code: code },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.authorization_code).toBe(code);

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/charge_authorization',
      headers: auth,
      payload: { email: 'dev@example.com', amount: 1_000, authorization_code: code },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/deactivated/i);
  });
});

describe('partial_debit', () => {
  it('debits less than the original charge', async () => {
    const { transaction } = await settledCardAuthorization();
    const code = transaction.authorization.authorization_code as string;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/partial_debit',
      headers: auth,
      payload: {
        email: 'dev@example.com',
        amount: 5_000,
        currency: 'NGN',
        authorization_code: code,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('success');
    expect(res.json().data.amount).toBe(5_000);
  });

  it('rejects at_least above amount', async () => {
    const { transaction } = await settledCardAuthorization();
    const code = transaction.authorization.authorization_code as string;

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/partial_debit',
      headers: auth,
      payload: {
        email: 'dev@example.com',
        amount: 5_000,
        currency: 'NGN',
        at_least: '9000',
        authorization_code: code,
      },
    });

    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/at_least/);
  });
});

describe('the OTP loop', () => {
  /** The 3-D Secure test card parks the charge awaiting a customer action. */
  async function parkedCharge() {
    const charge = await chargeCard(CARD_3DS);
    const reference = charge.json().data.reference as string;
    await advance('30s');
    expect((await verify(reference)).status).toBe('ongoing');
    return reference;
  }

  it('completes the charge on the correct OTP', async () => {
    const reference = await parkedCharge();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('success');
    expect(res.json().data).toHaveProperty('redirect_url');
  });

  it('fails the charge on a wrong OTP and records both hops', async () => {
    const reference = await parkedCharge();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '000000', reference },
    });

    expect(res.json().data.status).toBe('failed');

    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.failureCode).toBe('authentication_required');

    // The timeline is the source of truth, so both hops must be in it.
    const timeline = await context.engine.getTimeline(payment!.id);
    const types = timeline.map((e) => e.type);
    expect(types).toContain('payment.requires_action');
    expect(types).toContain('payment.failed');
    expect(timeline.map((e) => e.sequence)).toEqual(
      timeline.map((_, index) => index + 1),
    );
  });

  it('asks for the OTP after a correct PIN, without settling', async () => {
    const reference = await parkedCharge();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_pin',
      headers: auth,
      payload: { pin: '1234', reference },
    });

    expect(res.json().data.status).toBe('send_otp');
    // Still parked: a PIN alone settles nothing.
    expect((await verify(reference)).status).toBe('ongoing');
  });

  it('refuses to submit an OTP for a charge that is not awaiting one', async () => {
    const { reference } = await settledCardAuthorization();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference },
    });

    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/not awaiting a customer action/i);
  });
});

describe('GET /charge/:reference', () => {
  it('polls a pending charge', async () => {
    const charge = await chargeMomo('0550000000');
    const reference = charge.json().data.reference as string;

    const pending = await app.inject({
      method: 'GET',
      url: `/paystack/charge/${reference}`,
      headers: auth,
    });
    expect(pending.json().data.status).toBe('ongoing');

    await advance('30s');

    const settled = await app.inject({
      method: 'GET',
      url: `/paystack/charge/${reference}`,
      headers: auth,
    });
    expect(settled.json().data.status).toBe('success');
  });
});

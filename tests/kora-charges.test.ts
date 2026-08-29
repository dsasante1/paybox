import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { encryptChargeData, signKoraData, verifyKoraSignature } from '@paybox/kora';

/**
 * Kora: charges, step-ups, refunds, payouts and virtual accounts.
 *
 * Shapes transcribed from the Kora Public APIs Postman collection
 * (docs.korapay.com, collection 303979/SVzxXeSM) and the webhook guide at
 * developers.korapay.com/docs/webhooks, both read 2026-08-29.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const API = '/kora/merchant/api/v1';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'kora';
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

const key = () => context.koraKeys.secretKey;
const auth = () => ({ authorization: `Bearer ${key()}`, 'content-type': 'application/json' });

const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: body as object });

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key()}` } });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

const customer = { name: 'Ada Lovelace', email: 'ada@example.com' };

/** paybox's shared last-four convention, which Kora's adapter falls back to. */
const SUCCEEDS = '5060000000000000';
const DECLINES = '5060000000000001';
const NO_FUNDS = '5060000000000002';

describe('the response envelope', () => {
  it('uses a boolean status, unlike Flutterwave’s string', async () => {
    const body = (
      await post(`${API}/charges/initialize`, {
        reference: 'env-1',
        amount: 6000,
        currency: 'NGN',
        customer,
      })
    ).json();

    expect(body.status).toBe(true);
    expect(typeof body.status).toBe('boolean');
    expect(body.message).toBe('Charge created successfully');
    expect(body.data.checkout_url).toContain('/kora/checkout/env-1');
  });

  it('reports errors in the same envelope', async () => {
    const response = await post(`${API}/charges/initialize`, {
      reference: 'env-2',
      amount: 100,
      currency: 'ZZZ',
      customer,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: false, data: { code: 'unsupported_currency' } });
  });

  it('converts major units once, at the boundary', async () => {
    await post(`${API}/charges/initialize`, {
      reference: 'major-1',
      amount: 75.5,
      currency: 'NGN',
      customer,
    });

    const stored = await context.storage.payments.byReference('kora', 'major-1');
    expect(stored?.amount).toBe(7_550);

    const body = (await get(`${API}/charges/major-1`)).json();
    expect(body.data.amount).toBe('75.50');
  });
});

describe('credentials', () => {
  it('refuses a live secret key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API}/charges/anything`,
      headers: { authorization: 'Bearer sk_live_realkey' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('refuses live credentials');
  });
});

describe('card charges', () => {
  const cardBody = (number: string, reference: string) => ({
    reference,
    amount: 200,
    currency: 'NGN',
    customer,
    card: { number, cvv: '564', expiry_month: '09', expiry_year: '32' },
  });

  it('steps up through an OTP, as Kora always does', async () => {
    const body = (await post(`${API}/charges/card`, cardBody(SUCCEEDS, 'card-1'))).json();

    expect(body.message).toBe('Charge in progress');
    expect(body.data.status).toBe('processing');
    expect(body.data.auth_model).toBe('OTP');
    expect(body.data.transaction_reference).toMatch(/^KPY-CA-/);
  });

  it('settles once the OTP is authorized', async () => {
    await post(`${API}/charges/card`, cardBody(SUCCEEDS, 'card-2'));
    const authorized = (
      await post(`${API}/charges/card/authorize`, { reference: 'card-2', authorization: { otp: '123456' } })
    ).json();

    expect(authorized.data.status).toBe('success');
    expect(authorized.data.response_message).toBe('Approved by financial institution');
    expect(authorized.data.amount_paid).toBe('200.00');
  });

  it('fails on the instruments that should fail', async () => {
    await post(`${API}/charges/card`, cardBody(NO_FUNDS, 'card-3'));
    const authorized = (
      await post(`${API}/charges/card/authorize`, { reference: 'card-3', authorization: { otp: '123456' } })
    ).json();

    expect(authorized.data.status).toBe('failed');
    expect(authorized.data.response_message).toBe('Insufficient funds');
  });

  it('refuses to authorize a charge that is not waiting', async () => {
    await post(`${API}/charges/card`, cardBody(SUCCEEDS, 'card-4'));
    await post(`${API}/charges/card/authorize`, { reference: 'card-4' });
    const again = await post(`${API}/charges/card/authorize`, { reference: 'card-4' });

    expect(again.statusCode).toBe(400);
  });

  it('never stores the card number', async () => {
    await post(`${API}/charges/card`, cardBody(SUCCEEDS, 'card-5'));
    const stored = await context.storage.payments.byReference('kora', 'card-5');

    expect(JSON.stringify(stored)).not.toContain(SUCCEEDS);
    expect(stored?.paymentMethodDetails.last4).toBe('0000');
  });
});

describe('the encrypted charge_data', () => {
  it('accepts an AES-encrypted payload, as the SDKs send', async () => {
    const charge_data = encryptChargeData(key(), {
      reference: 'enc-1',
      amount: 500,
      currency: 'NGN',
      customer,
      card: { number: SUCCEEDS, cvv: '564', expiry_month: '09', expiry_year: '32' },
    });

    const body = (await post(`${API}/charges/card`, { charge_data })).json();
    expect(body.status).toBe(true);
    expect(body.data.reference).toBe('enc-1');
  });

  it('answers a bad payload in Kora’s own words', async () => {
    const charge_data = encryptChargeData('a-different-secret-key-entirely', {
      reference: 'enc-2',
      amount: 500,
      customer,
      card: { number: SUCCEEDS },
    });
    const response = await post(`${API}/charges/card`, { charge_data });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe(
      'Unable to decrypt charge data, please check encryption and try again.',
    );
  });
});

describe('bank transfer', () => {
  it('mints a virtual account and stays pending until money arrives', async () => {
    const body = (
      await post(`${API}/charges/bank-transfer`, {
        reference: 'bt-1',
        amount: 1500,
        currency: 'NGN',
        account_name: 'Demo account',
        customer,
      })
    ).json();

    expect(body.message).toBe('Bank transfer initiated successfully');
    expect(body.data.status).toBe('processing');
    expect(body.data.bank_account.account_number).toMatch(/^\d{10}$/);
    // Synthetic and generated: nothing can pay into it for real (spec §29).
    expect(body.data.bank_account.bank_name).toBe('PAYBOX TEST BANK');
    expect(body.data.bank_account.expiry_date_in_utc).toBeTruthy();
  });
});

describe('mobile money', () => {
  it('is a three-call flow: charge, OTP, then the handset prompt', async () => {
    const first = (
      await post(`${API}/charges/mobile-money`, {
        reference: 'momo-1',
        amount: 701,
        currency: 'GHS',
        customer,
        mobile_money: { number: '+233240000000' },
      })
    ).json();

    expect(first.message).toBe('Authorization required');
    expect(first.data.auth_model).toBe('OTP');

    const second = (
      await post(`${API}/charges/mobile-money/authorize`, { reference: 'momo-1', token: '123456' })
    ).json();

    // The OTP is not the end of it: an STK prompt goes to the handset next.
    expect(second.data.auth_model).toBe('STK_PROMPT');
    expect(second.data.status).toBe('processing');

    const third = (
      await post(`${API}/charges/mobile-money/sandbox/authorize-stk`, {
        reference: 'momo-1',
        pin: '1234',
      })
    ).json();

    expect(third.message).toBe('Approved by financial institution');
    expect(third.data.status).toBe('success');
  });
});

describe('querying a charge', () => {
  it('finds it by the merchant reference or Kora’s own', async () => {
    await post(`${API}/charges/initialize`, {
      reference: 'q-1',
      amount: 1000,
      currency: 'NGN',
      customer,
    });

    const byRef = (await get(`${API}/charges/q-1`)).json();
    expect(byRef.message).toBe('Charge retrieved successfully');

    const byKoraRef = (await get(`${API}/charges/${byRef.data.transaction_reference}`)).json();
    expect(byKoraRef.data.reference).toBe('q-1');
  });

  it('404s for an unknown reference', async () => {
    const response = await get(`${API}/charges/nope`);
    expect(response.statusCode).toBe(404);
    expect(response.json().status).toBe(false);
  });

  it('refuses a duplicate reference', async () => {
    const body = { reference: 'dup-1', amount: 100, currency: 'NGN', customer };
    await post(`${API}/charges/initialize`, body);
    const again = await post(`${API}/charges/initialize`, body);

    expect(again.statusCode).toBe(400);
    expect(again.json().message).toContain('already been used');
  });
});

describe('refunds', () => {
  it('refunds a settled charge', async () => {
    await post(`${API}/charges/card`, {
      reference: 'ref-1',
      amount: 200,
      currency: 'NGN',
      customer,
      card: { number: SUCCEEDS, cvv: '564', expiry_month: '09', expiry_year: '32' },
    });
    await post(`${API}/charges/card/authorize`, { reference: 'ref-1' });

    const refund = (
      await post(`${API}/refunds/initiate`, {
        payment_reference: 'ref-1',
        amount: 100,
        reference: 'RFD-1',
        reason: 'Customer request',
      })
    ).json();

    expect(refund.message).toBe('Refund successfully initiated');
    expect(refund.data.amount_returned).toBe(100);
    expect(refund.data.status).toBe('success');
  });

  it('lists refunds under Kora’s has_more envelope', async () => {
    await post(`${API}/charges/card`, {
      reference: 'ref-2',
      amount: 200,
      currency: 'NGN',
      customer,
      card: { number: SUCCEEDS, cvv: '564' },
    });
    await post(`${API}/charges/card/authorize`, { reference: 'ref-2' });
    await post(`${API}/refunds/initiate`, { payment_reference: 'ref-2', amount: 50 });

    const body = (await get(`${API}/refunds`)).json();
    expect(body.data.has_more).toBe(false);
    expect(body.data.refunds).toHaveLength(1);
  });
});

describe('payouts', () => {
  it('disburses to a bank account', async () => {
    const body = (
      await post(`${API}/transactions/disburse`, {
        reference: 'po-1',
        destination: {
          type: 'bank_account',
          amount: 1000,
          currency: 'NGN',
          narration: 'payout to customer',
          bank_account: { bank_code: '044', account_number: '0690000031' },
          customer: { name: 'John Doe', email: 'john@example.com' },
        },
      })
    ).json();

    expect(body.message).toBe('transfer initiated successfully');
    expect(body.data.status).toBe('processing');
    expect(body.data.amount).toBe('1000.00');
    expect(body.data.trace_id).toMatch(/^KPY-TRC-/);
  });

  it('disburses to mobile money', async () => {
    const body = (
      await post(`${API}/transactions/disburse`, {
        reference: 'po-2',
        destination: {
          type: 'mobile_money',
          amount: 100,
          currency: 'KES',
          mobile_money: { operator: 'safaricom-ke', mobile_number: '256700000000' },
        },
      })
    ).json();

    expect(body.status).toBe(true);
    expect(body.data.currency).toBe('KES');
  });

  it('refuses a payout the balance cannot cover', async () => {
    const response = await post(`${API}/transactions/disburse`, {
      reference: 'po-3',
      destination: {
        type: 'bank_account',
        amount: 9_999_999,
        currency: 'NGN',
        bank_account: { bank_code: '044', account_number: '0690000031' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.code).toBe('balance_insufficient');
  });

  it('is retrievable by reference', async () => {
    await post(`${API}/transactions/disburse`, {
      reference: 'po-4',
      destination: {
        type: 'bank_account',
        amount: 500,
        currency: 'NGN',
        bank_account: { bank_code: '044', account_number: '0690000031' },
      },
    });

    const body = (await get(`${API}/transactions/po-4`)).json();
    expect(body.message).toBe('Transaction retrieved successfully');
    expect(body.data.reference).toBe('po-4');
  });
});

describe('virtual bank accounts', () => {
  it('creates one and reads it back', async () => {
    const created = (
      await post(`${API}/virtual-bank-account`, {
        account_name: 'Ada Lovelace',
        account_reference: 'vba-1',
        permanent: true,
        customer,
      })
    ).json();

    expect(created.data.account_number).toMatch(/^\d{10}$/);
    expect(created.data.account_status).toBe('active');

    const read = (await get(`${API}/virtual-bank-account/vba-1`)).json();
    expect(read.data.account_reference).toBe('vba-1');
  });

  it('credits one through Kora’s own sandbox endpoint', async () => {
    const created = (
      await post(`${API}/virtual-bank-account`, {
        account_name: 'Ada Lovelace',
        account_reference: 'vba-2',
        customer,
      })
    ).json();

    // Money into a virtual account originates with the payer's bank, so this
    // endpoint is the only way to test the inbound rail — and it is Kora's
    // own, not a paybox invention.
    const credited = (
      await post(`${API}/virtual-bank-account/sandbox/credit`, {
        account_number: created.data.account_number,
        amount: 2500,
        currency: 'NGN',
      })
    ).json();

    expect(credited.data.status).toBe('success');
    expect(credited.data.amount).toBe('2500.00');
  });
});

describe('webhooks', () => {
  async function endpoint() {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: {
        url: 'http://localhost:9999/hook',
        provider: 'kora',
        secret: context.koraKeys.secretKey,
        eventTypes: [],
      },
    });
  }

  it('distinguishes success from failure by event name', async () => {
    await endpoint();
    await post(`${API}/charges/card`, {
      reference: 'wh-1',
      amount: 200,
      currency: 'NGN',
      customer,
      card: { number: SUCCEEDS, cvv: '564' },
    });
    await post(`${API}/charges/card/authorize`, { reference: 'wh-1' });
    await advance('30s');

    const events = transport.sent.map((r) => JSON.parse(r.body).event as string);
    // Unlike Flutterwave, Kora *does* have a separate failure event, so an
    // integration can branch on the name here where it could not there.
    expect(events).toContain('charge.success');
  });

  it('sends charge.failed for a decline', async () => {
    await endpoint();
    await post(`${API}/charges/card`, {
      reference: 'wh-2',
      amount: 200,
      currency: 'NGN',
      customer,
      card: { number: DECLINES, cvv: '564' },
    });
    await post(`${API}/charges/card/authorize`, { reference: 'wh-2' });
    await advance('30s');

    const events = transport.sent.map((r) => JSON.parse(r.body).event as string);
    expect(events).toContain('charge.failed');
  });

  it('signs only the data object, hex-encoded', async () => {
    await endpoint();
    await post(`${API}/charges/card`, {
      reference: 'wh-3',
      amount: 200,
      currency: 'NGN',
      customer,
      card: { number: SUCCEEDS, cvv: '564' },
    });
    await post(`${API}/charges/card/authorize`, { reference: 'wh-3' });
    await advance('30s');

    const sent = transport.sent[0];
    expect(sent).toBeDefined();

    const body = JSON.parse(sent!.body);
    const header = sent!.headers['x-korapay-signature'];
    expect(header).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyKoraSignature(body.data, header, context.koraKeys.secretKey)).toBe(true);
    expect(verifyKoraSignature(body.data, header, 'a-different-key')).toBe(false);
  });

  it('leaves the event name outside the signature, as Kora does', async () => {
    // A real property of Kora's scheme, reproduced rather than improved on:
    // signing only `data` means the event name is not covered, so the same
    // signature verifies under a different event.
    const data = { reference: 'x', amount: '100.00', status: 'success' };
    const signature = signKoraData(data, 'sk_test_key');

    expect(verifyKoraSignature(data, signature, 'sk_test_key')).toBe(true);
    // Same data, different event — still verifies. That is the point.
    const tamperedEnvelope = { event: 'charge.failed', data };
    expect(verifyKoraSignature(tamperedEnvelope.data, signature, 'sk_test_key')).toBe(true);
  });
});

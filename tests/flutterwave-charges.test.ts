import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { encryptPayload, verifyV3Signature, verifyV4Signature, signV4Payload } from '@paybox/flutterwave';

/**
 * Flutterwave v3: charges, step-ups, verification, refunds and payouts.
 *
 * Shapes and test instruments transcribed from
 * developer.flutterwave.com/v3.0.0/docs (read 2026-08-29). The card table in
 * particular is verbatim: these are the numbers a developer already has in
 * their tests, so a decline that silently succeeded here would turn their
 * failure test into a false pass.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-04-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'flutterwave';
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

const key = () => context.flutterwaveKeys.secretKey;
const auth = () => ({ authorization: `Bearer ${key()}`, 'content-type': 'application/json' });

const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: body as object });

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key()}` } });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

/** Flutterwave's published cards, by the behaviour each triggers. */
const PIN_CARD = '5531886652142950';
const THREE_DS_CARD = '4187427415564246';
const NO_AUTH_CARD = '5061460166976054667';
const AVS_CARD = '4556052704172643';
const DECLINE_CARD = '5143010522339965';
const INSUFFICIENT_CARD = '5258585922666506';

function cardBody(number: string, ref: string, extra: Record<string, unknown> = {}) {
  return {
    card_number: number,
    cvv: '564',
    expiry_month: '09',
    expiry_year: '32',
    currency: 'NGN',
    amount: '7500',
    email: 'ada@example.com',
    fullname: 'Ada Lovelace',
    tx_ref: ref,
    ...extra,
  };
}

describe('the response envelope', () => {
  it('is Flutterwave-shaped, not another provider’s', async () => {
    const response = await post('/flutterwave/v3/payments', {
      tx_ref: 'env-1',
      amount: '5000',
      currency: 'NGN',
      customer: { email: 'ada@example.com' },
    });

    const body = response.json();
    expect(body.status).toBe('success');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('data');
    // Not Paystack's boolean status, and not Stripe's bare object.
    expect(typeof body.status).toBe('string');
  });

  it('reports errors in the same envelope', async () => {
    const response = await post('/flutterwave/v3/payments', {
      tx_ref: 'env-2',
      amount: '5000',
      currency: 'ZZZ',
      customer: { email: 'ada@example.com' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 'error', data: { code: 'unsupported_currency' } });
  });

  it('reports amounts in major units, as Flutterwave does', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'major-1'));
    await advance('30s');
    const body = (await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=major-1')).json();

    // 7500 major units in, 7500 major units out — the engine stored 750000.
    expect(body.data.amount).toBe(7500);
    const stored = await context.storage.payments.byReference('flutterwave', 'major-1');
    expect(stored?.amount).toBe(750_000);
  });
});

describe('credentials', () => {
  it('refuses a live secret key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/flutterwave/v3/transactions',
      headers: { authorization: 'Bearer FLWSECK-0123456789abcdef-X' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('refuses live credentials');
  });

  it('refuses a key that is not a test key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/flutterwave/v3/transactions',
      headers: { authorization: 'Bearer sk_test_wrong_provider' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('issues three keys, including a 24-character encryption key', async () => {
    // 3DES-EDE3 takes a 24-byte key; a shorter one would make a developer's
    // real encryption code fail against the emulator.
    expect(context.flutterwaveKeys.encryptionKey).toHaveLength(24);
    expect(context.flutterwaveKeys.secretKey).toMatch(/^FLWSECK_TEST-/);
    expect(context.flutterwaveKeys.publicKey).toMatch(/^FLWPUBK_TEST-/);
  });
});

describe('direct card charges', () => {
  it('asks for a PIN, then settles once it is supplied', async () => {
    const first = (await post('/flutterwave/v3/charges?type=card', cardBody(PIN_CARD, 'pin-1'))).json();

    expect(first.message).toBe('Charge authorization data required');
    expect(first.meta.authorization).toEqual({ mode: 'pin', fields: ['pin'] });
    expect(first.data.status).toBe('pending');
    expect(first.data.auth_model).toBe('PIN');

    const second = (
      await post('/flutterwave/v3/charges?type=card', cardBody(PIN_CARD, 'pin-1', { pin: '3310' }))
    ).json();

    expect(second.message).toBe('Charge initiated');
    expect(second.data.status).toBe('successful');
    expect(second.data.processor_response).toBe('Approved. Successful');
  });

  it('asks for address details on an AVS card', async () => {
    const first = (await post('/flutterwave/v3/charges?type=card', cardBody(AVS_CARD, 'avs-1'))).json();

    expect(first.meta.authorization.mode).toBe('avs_noauth');
    expect(first.meta.authorization.fields).toEqual([
      'city',
      'address',
      'state',
      'country',
      'zipcode',
    ]);
  });

  it('hands back a redirect for a 3-D Secure card', async () => {
    const first = (
      await post('/flutterwave/v3/charges?type=card', cardBody(THREE_DS_CARD, '3ds-1'))
    ).json();

    expect(first.meta.authorization.mode).toBe('redirect');
    expect(first.meta.authorization.redirect).toContain('/flutterwave/3ds/3ds-1');
    expect(first.data.auth_model).toBe('VBVSECURECODE');
  });

  it('serves a real page at that redirect', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(THREE_DS_CARD, '3ds-2'));
    const page = await app.inject({ method: 'GET', url: '/flutterwave/3ds/3ds-2' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('paybox emulator');

    const after = (await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=3ds-2')).json();
    expect(after.data.status).toBe('successful');
  });

  it('settles a no-auth card without a step-up', async () => {
    const body = (
      await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'noauth-1'))
    ).json();
    expect(body.meta).toBeUndefined();

    await advance('30s');
    const after = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=noauth-1')
    ).json();
    expect(after.data.status).toBe('successful');
  });

  it('declines the cards Flutterwave publishes as declining', async () => {
    const declined = (
      await post('/flutterwave/v3/charges?type=card', cardBody(DECLINE_CARD, 'dec-1', { pin: '3310' }))
    ).json();
    expect(declined.data.status).toBe('failed');
    expect(declined.data.processor_response).toBe('Do not honour');

    const broke = (
      await post(
        '/flutterwave/v3/charges?type=card',
        cardBody(INSUFFICIENT_CARD, 'dec-2', { pin: '3310' }),
      )
    ).json();
    expect(broke.data.status).toBe('failed');
    expect(broke.data.processor_response).toBe('Insufficient Funds');
  });

  it('never stores the card number', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(PIN_CARD, 'mask-1', { pin: '3310' }));
    const stored = await context.storage.payments.byReference('flutterwave', 'mask-1');

    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain(PIN_CARD);
    expect(stored?.paymentMethodDetails.last4).toBe('2950');
    expect(stored?.paymentMethodDetails.bin).toBe('553188');
    // The CVV is never read into the domain model at all (spec §29).
    expect(serialised).not.toContain('564');
  });
});

describe('the encrypted payload', () => {
  it('accepts a 3DES-encrypted `client` field, as the SDKs send', async () => {
    const client = encryptPayload(
      context.flutterwaveKeys.encryptionKey,
      cardBody(NO_AUTH_CARD, 'enc-1'),
    );

    const body = (await post('/flutterwave/v3/charges?type=card', { client })).json();
    expect(body.status).toBe('success');
    expect(body.data.tx_ref).toBe('enc-1');
  });

  it('says which key is wrong rather than leaking a crypto error', async () => {
    const client = encryptPayload('a-completely-different-key', cardBody(NO_AUTH_CARD, 'enc-2'));
    const response = await post('/flutterwave/v3/charges?type=card', { client });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('encryption key');
  });
});

describe('OTP validation', () => {
  it('validates any OTP, as Flutterwave documents for test mode', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(THREE_DS_CARD, 'otp-1'));
    const charge = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=otp-1')
    ).json();

    const validated = (
      await post('/flutterwave/v3/validate-charge', { otp: '12345', flw_ref: charge.data.flw_ref })
    ).json();

    expect(validated.message).toBe('Charge validated');
    expect(validated.data.status).toBe('successful');
  });

  it('fails on the OTP Flutterwave reserves for a wrong one', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(THREE_DS_CARD, 'otp-2'));
    const charge = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=otp-2')
    ).json();

    const failed = (
      await post('/flutterwave/v3/validate-charge', { otp: '5548', flw_ref: charge.data.flw_ref })
    ).json();

    expect(failed.message).toBe('Charge validation failed');
    expect(failed.data.status).toBe('failed');
  });

  it('refuses to validate a charge that is not waiting', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'otp-3'));
    await advance('30s');
    const charge = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=otp-3')
    ).json();

    const response = await post('/flutterwave/v3/validate-charge', {
      otp: '12345',
      flw_ref: charge.data.flw_ref,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('mobile money', () => {
  it('parks awaiting the customer’s handset', async () => {
    const body = (
      await post('/flutterwave/v3/charges?type=mobile_money_ghana', {
        tx_ref: 'momo-1',
        amount: '2000',
        currency: 'GHS',
        email: 'ada@example.com',
        phone_number: '233550000000',
        network: 'MTN',
      })
    ).json();

    // The merchant does not control when — or whether — this completes, which
    // is the whole reason the rail is worth emulating.
    expect(body.data.status).toBe('pending');
    expect(body.meta.authorization.endpoint).toBe('/v3/validate-charge');
    expect(body.data.payment_type).toBe('mobilemoney');
  });

  it('fails on the number Flutterwave publishes as failing', async () => {
    const body = (
      await post('/flutterwave/v3/charges?type=mobile_money_ghana', {
        tx_ref: 'momo-2',
        amount: '2000',
        currency: 'GHS',
        email: 'ada@example.com',
        phone_number: '233121212121',
      })
    ).json();

    expect(body.data.status).toBe('failed');
  });
});

describe('verification and listing', () => {
  it('addresses one transaction by id, flw_ref and tx_ref alike', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'find-1'));
    const byRef = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=find-1')
    ).json();

    const byId = (await get(`/flutterwave/v3/transactions/${byRef.data.id}/verify`)).json();
    const byFlwRef = (await get(`/flutterwave/v3/transactions/${byRef.data.flw_ref}/verify`)).json();

    expect(byId.data.id).toBe(byRef.data.id);
    expect(byFlwRef.data.id).toBe(byRef.data.id);
  });

  it('404s for an unknown reference', async () => {
    const response = await get('/flutterwave/v3/transactions/nope/verify');
    expect(response.statusCode).toBe(404);
    expect(response.json().status).toBe('error');
  });

  it('lists with page info', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'list-1'));
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'list-2'));

    const body = (await get('/flutterwave/v3/transactions')).json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.meta.page_info.total).toBeGreaterThanOrEqual(2);
  });

  it('refuses a duplicate tx_ref', async () => {
    await post('/flutterwave/v3/payments', {
      tx_ref: 'dup-1',
      amount: '1000',
      currency: 'NGN',
      customer: { email: 'ada@example.com' },
    });
    const again = await post('/flutterwave/v3/payments', {
      tx_ref: 'dup-1',
      amount: '1000',
      currency: 'NGN',
      customer: { email: 'ada@example.com' },
    });

    expect(again.statusCode).toBe(400);
    expect(again.json().message).toContain('already been used');
  });
});

describe('refunds', () => {
  it('refunds a settled charge', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'ref-1'));
    await advance('30s');
    const charge = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=ref-1')
    ).json();

    const refund = (
      await post(`/flutterwave/v3/transactions/${charge.data.id}/refund`, { amount: '2500' })
    ).json();

    expect(refund.status).toBe('success');
    expect(refund.data.amount_refunded).toBe(2500);
    // Flutterwave calls a settled refund `completed`, not `successful`.
    expect(refund.data.status).toBe('completed');
  });

  it('refuses to refund more than the charge', async () => {
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'ref-2'));
    await advance('30s');
    const charge = (
      await get('/flutterwave/v3/transactions/verify_by_reference?tx_ref=ref-2')
    ).json();

    const response = await post(`/flutterwave/v3/transactions/${charge.data.id}/refund`, {
      amount: '99999',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('payouts', () => {
  it('queues a transfer against the balance', async () => {
    const body = (
      await post('/flutterwave/v3/transfers', {
        account_bank: '044',
        account_number: '0690000031',
        amount: '5000',
        currency: 'NGN',
        narration: 'Payout',
        reference: 'payout-1',
      })
    ).json();

    expect(body.message).toBe('Transfer Queued Successfully');
    expect(body.data).toMatchObject({
      amount: 5000,
      status: 'NEW',
      account_number: '0690000031',
      bank_code: '044',
    });
  });

  it('refuses a payout the balance cannot cover', async () => {
    const response = await post('/flutterwave/v3/transfers', {
      account_bank: '044',
      account_number: '0690000031',
      amount: '999999999',
      currency: 'NGN',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.code).toBe('balance_insufficient');
  });
});

describe('webhooks', () => {
  async function endpoint() {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: {
        url: 'http://localhost:9999/hook',
        provider: 'flutterwave',
        secret: 'my-secret-hash',
        eventTypes: [],
      },
    });
  }

  it('sends charge.completed for a success', async () => {
    await endpoint();
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'wh-1'));
    await advance('30s');

    const bodies = transport.sent.map((r) => JSON.parse(r.body));
    const charge = bodies.find((b) => b.event === 'charge.completed');
    expect(charge).toBeDefined();
    expect(charge.data.status).toBe('successful');
    expect(charge['event.type']).toBe('CARD_TRANSACTION');
  });

  it('sends charge.completed for a failure too, with the status inside', async () => {
    await endpoint();
    await post('/flutterwave/v3/charges?type=card', cardBody(INSUFFICIENT_CARD, 'wh-2', { pin: '3310' }));
    await advance('30s');

    const bodies = transport.sent.map((r) => JSON.parse(r.body));
    // Flutterwave has no charge.failed. An integration that assumes the event
    // name implies success is wrong, and the emulator has to show that.
    expect(bodies.every((b) => b.event !== 'charge.failed')).toBe(true);
    const failed = bodies.find((b) => b.data?.status === 'failed');
    expect(failed?.event).toBe('charge.completed');
  });

  it('signs v3 by sending the secret verbatim in verif-hash', async () => {
    await endpoint();
    await post('/flutterwave/v3/charges?type=card', cardBody(NO_AUTH_CARD, 'wh-3'));
    await advance('30s');

    const sent = transport.sent[0];
    expect(sent).toBeDefined();
    // v3 does not sign the body at all: the header *is* the secret.
    expect(sent!.headers['verif-hash']).toBe('my-secret-hash');
    expect(verifyV3Signature(sent!.headers['verif-hash'], 'my-secret-hash')).toBe(true);
    expect(verifyV3Signature(sent!.headers['verif-hash'], 'a-different-hash')).toBe(false);
  });
});

describe('the v4 signature scheme', () => {
  it('is a base64 HMAC-SHA256 over the body', async () => {
    const body = JSON.stringify({ event: 'charge.completed', data: { id: 1 } });
    const signature = signV4Payload(body, 'secret-hash');

    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifyV4Signature(body, signature, 'secret-hash')).toBe(true);
    expect(verifyV4Signature(body, signature, 'wrong')).toBe(false);
    // Tampering is detectable, unlike v3.
    expect(verifyV4Signature(`${body} `, signature, 'secret-hash')).toBe(false);
  });
});

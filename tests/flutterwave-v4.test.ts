import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { parseScenarioKey, outcomeForIssuer, ISSUER_RESPONSES } from '@paybox/flutterwave';

/**
 * Flutterwave v4 — a second, genuinely different API from the same provider.
 *
 * Verified at developer.flutterwave.com/docs (authentication, api-headers,
 * testing, charging-a-card), read 2026-08-29.
 *
 * The point of these is the *differences* from v3: OAuth instead of API keys,
 * `{status:"failed", error:{type,code}}` instead of `{status:"error",…}`,
 * prefixed string ids instead of integers, and `X-Scenario-Key` instead of a
 * test-card table.
 */
let app: FastifyInstance;
let context: PayboxContext;

const V4 = '/flutterwave/v4';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'flw-v4';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

async function token(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${V4}/oauth/token`,
    headers: { 'content-type': 'application/json' },
    payload: {
      client_id: context.flutterwaveV4.clientId,
      client_secret: context.flutterwaveV4.clientSecret,
      grant_type: 'client_credentials',
    },
  });
  return response.json().access_token as string;
}

async function post(url: string, body: unknown, scenario?: string, bearer?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${bearer ?? (await token())}`,
      'content-type': 'application/json',
      ...(scenario ? { 'x-scenario-key': scenario } : {}),
    },
    payload: body as object,
  });
}

async function put(url: string, body: unknown, scenario?: string) {
  return app.inject({
    method: 'PUT',
    url,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      ...(scenario ? { 'x-scenario-key': scenario } : {}),
    },
    payload: body as object,
  });
}

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function customerAndCard() {
  const customer = (await post(`${V4}/customers`, { email: 'ada@example.com', name: { first: 'Ada', last: 'Lovelace' } })).json();
  const method = (
    await post(`${V4}/payment-methods`, {
      type: 'card',
      card: { card_number: '5531886652142950', expiry_month: 9, expiry_year: 32, cvv: '564' },
      customer_id: customer.data.id,
    })
  ).json();
  return { customerId: customer.data.id as string, methodId: method.data.id as string };
}

describe('OAuth 2.0', () => {
  it('exchanges client credentials for a short-lived token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${V4}/oauth/token`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_id: context.flutterwaveV4.clientId,
        client_secret: context.flutterwaveV4.clientSecret,
        grant_type: 'client_credentials',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 600,
      refresh_expires_in: 0,
      scope: 'profile email',
    });
    expect(response.json().access_token).toMatch(/^flwtok_/);
  });

  it('refuses a grant type other than client_credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${V4}/oauth/token`,
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'x', client_secret: 'y', grant_type: 'password' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses wrong credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${V4}/oauth/token`,
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'nope', client_secret: 'wrong', grant_type: 'client_credentials' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe('UNAUTHORIZED');
  });

  it('refuses a live-looking client secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${V4}/oauth/token`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_id: 'x',
        client_secret: 'flwsec-live-realcredential',
        grant_type: 'client_credentials',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: `${V4}/customers/cus_x` });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      status: 'failed',
      error: { type: 'UNAUTHORIZED', code: '10401' },
    });
  });

  it('expires the token after ten minutes, under virtual time', async () => {
    const bearer = await token();
    // Works now.
    expect((await post(`${V4}/customers`, { email: 'a@example.com' }, undefined, bearer)).statusCode).toBe(200);

    await advance('11m');

    // Token expiry is a real failure mode v3 integrations never had, and one
    // a developer should meet under a time advance rather than in production.
    const after = await post(`${V4}/customers`, { email: 'b@example.com' }, undefined, bearer);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.message).toContain('expired');
  });
});

describe('the v4 envelope', () => {
  it('is nothing like v3’s', async () => {
    const body = (await post(`${V4}/customers`, { email: 'ada@example.com' })).json();

    expect(body.status).toBe('success');
    expect(body.message).toBe('Customer created');
    // Prefixed string ids, not v3's integers.
    expect(body.data.id).toMatch(/^cus_[A-Za-z0-9]{10}$/);
    expect(body.data.name).toEqual({ first: null, middle: null, last: null });
    expect(body.data.created_datetime).toMatch(/Z$/);
  });

  it('reports errors as {status:"failed", error:{type,code}}', async () => {
    const response = await post(`${V4}/charges`, {
      reference: 'bad-currency',
      currency: 'ZZZ',
      amount: 100,
      customer_id: 'cus_nope',
    });

    expect(response.json().status).toBe('failed');
    expect(response.json().error).toMatchObject({ type: expect.any(String), code: expect.any(String) });
    // v3 would have answered {status:"error", message, data}.
    expect(response.json()).not.toHaveProperty('data');
  });
});

describe('X-Scenario-Key', () => {
  it('parses scenario and issuer', () => {
    expect(parseScenarioKey('scenario:auth_pin&issuer:insufficient_funds')).toEqual({
      scenario: 'auth_pin',
      issuer: 'insufficient_funds',
      invalid: false,
      transfer: null,
    });
  });

  it('defaults to noauth and approved when absent', () => {
    expect(parseScenarioKey(undefined)).toMatchObject({ scenario: 'noauth', issuer: 'approved' });
  });

  it('flags an unrecognised key rather than guessing', () => {
    expect(parseScenarioKey('scenario:nonsense&issuer:approved').invalid).toBe(true);
    expect(parseScenarioKey('scenario:auth_pin&issuer:made_up').invalid).toBe(true);
  });

  it('maps every published issuer response to an outcome', () => {
    for (const issuer of ISSUER_RESPONSES) {
      expect(typeof outcomeForIssuer(issuer)).toBe('string');
    }
    // Only approved (and partial approval) move money.
    const succeeding = ISSUER_RESPONSES.filter((i) => outcomeForIssuer(i) === 'success');
    expect(succeeding).toEqual(['approved', 'partial_approval']);
  });
});

describe('charges', () => {
  it('settles immediately with no scenario key', async () => {
    const { customerId, methodId } = await customerAndCard();
    const body = (
      await post(`${V4}/charges`, {
        reference: 'v4-noauth',
        currency: 'NGN',
        amount: 2500,
        customer_id: customerId,
        payment_method_id: methodId,
      })
    ).json();

    expect(body.status).toBe('success');
    expect(body.data.status).toBe('successful');
    expect(body.data.next_action).toBeNull();
    expect(body.data.id).toMatch(/^chg_/);
  });

  it('asks for a PIN under scenario:auth_pin', async () => {
    const { customerId, methodId } = await customerAndCard();
    const body = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-pin', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:auth_pin&issuer:approved',
      )
    ).json();

    expect(body.status).toBe('pending');
    expect(body.message).toBe('Charge requires authorization');
    expect(body.data.next_action).toEqual({ type: 'authorize', authorization: { type: 'pin' } });
  });

  it('settles once the PIN is supplied via PUT', async () => {
    const { customerId, methodId } = await customerAndCard();
    const created = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-pin-2', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:auth_pin&issuer:approved',
      )
    ).json();

    const settled = (
      await put(`${V4}/charges/${created.data.id}`, {
        authorization: { type: 'pin', pin: { nonce: 'abc', encrypted_pin: 'xyz' } },
      })
    ).json();

    expect(settled.status).toBe('success');
    expect(settled.data.status).toBe('successful');
  });

  it('steps up twice under auth_pin_3ds, as documented', async () => {
    const { customerId, methodId } = await customerAndCard();
    const created = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-failover', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:auth_pin_3ds&issuer:approved',
      )
    ).json();
    expect(created.data.next_action.type).toBe('authorize');

    const afterPin = (
      await put(`${V4}/charges/${created.data.id}`, {
        authorization: { type: 'pin', pin: { encrypted_pin: 'xyz' } },
      })
    ).json();

    // The documented failover: PIN first, then a redirect to 3-D Secure.
    // Collapsing it would hide the case the scenario exists to test.
    expect(afterPin.status).toBe('pending');
    expect(afterPin.data.next_action.type).toBe('redirect_url');
    expect(afterPin.data.next_action.redirect_url.url).toContain('/flutterwave/v4/redirect/');
  });

  it('returns a redirect under scenario:auth_3ds, and serves it', async () => {
    const { customerId, methodId } = await customerAndCard();
    const created = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-3ds', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:auth_3ds&issuer:approved',
      )
    ).json();

    const url = new URL(created.data.next_action.redirect_url.url);
    const page = await app.inject({ method: 'GET', url: url.pathname });
    expect(page.statusCode).toBe(200);

    const after = (
      await app.inject({
        method: 'GET',
        url: `${V4}/charges/${created.data.id}`,
        headers: { authorization: `Bearer ${await token()}` },
      })
    ).json();
    expect(after.data.status).toBe('successful');
  });

  it('declines according to the issuer response, and echoes it', async () => {
    const { customerId, methodId } = await customerAndCard();
    const body = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-decline', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:noauth&issuer:insufficient_funds',
      )
    ).json();

    // A declined charge is a 200 with status "failed" — not an error envelope.
    expect(body.status).toBe('failed');
    expect(body.data.status).toBe('failed');
    expect(body.data.processor_response.type).toBe('insufficient_funds');
  });

  it('defaults an invalid scenario key to pending, as Flutterwave documents', async () => {
    const { customerId, methodId } = await customerAndCard();
    const body = (
      await post(
        `${V4}/charges`,
        { reference: 'v4-bogus', currency: 'NGN', amount: 2500, customer_id: customerId, payment_method_id: methodId },
        'scenario:not_a_real_scenario&issuer:approved',
      )
    ).json();

    // Silently treating a typo as approved would turn a failure test into a
    // false pass, so an unknown key parks the charge instead.
    expect(body.status).toBe('pending');
  });

  it('refuses a duplicate reference', async () => {
    const { customerId, methodId } = await customerAndCard();
    const body = { reference: 'v4-dup', currency: 'NGN', amount: 100, customer_id: customerId, payment_method_id: methodId };
    await post(`${V4}/charges`, body);
    const again = await post(`${V4}/charges`, body);

    expect(again.statusCode).toBe(409);
    expect(again.json().error.type).toBe('DUPLICATE_REQUEST');
  });
});

describe('payment methods', () => {
  it('stores only masked fragments', async () => {
    const { methodId } = await customerAndCard();
    const body = (
      await app.inject({
        method: 'GET',
        url: `${V4}/payment-methods/${methodId}`,
        headers: { authorization: `Bearer ${await token()}` },
      })
    ).json();

    expect(body.data.card).toMatchObject({
      first6: '553188',
      last4: '2950',
      expiry_month: 9,
      expiry_year: 32,
    });
    const stored = await context.storage.authorizations.list({ provider: 'flutterwave' });
    expect(JSON.stringify(stored)).not.toContain('5531886652142950');
  });
});

describe('refunds and transfers', () => {
  it('refunds a settled charge', async () => {
    const { customerId, methodId } = await customerAndCard();
    const charge = (
      await post(`${V4}/charges`, {
        reference: 'v4-refund',
        currency: 'NGN',
        amount: 2500,
        customer_id: customerId,
        payment_method_id: methodId,
      })
    ).json();

    const refund = (await post(`${V4}/charges/${charge.data.id}/refund`, { amount: 1000 })).json();
    expect(refund.status).toBe('success');
    expect(refund.data.amount).toBe(1000);
    expect(refund.data.id).toMatch(/^rfd_/);
  });

  it('drives a transfer through its scenario key', async () => {
    const success = (
      await post(`${V4}/transfers`, { reference: 'v4-tr-1', amount: 500, currency: 'NGN' }, 'scenario:successful')
    ).json();
    expect(success.data.status).toBe('successful');

    const failed = (
      await post(`${V4}/transfers`, { reference: 'v4-tr-2', amount: 500, currency: 'NGN' }, 'scenario:failed')
    ).json();
    expect(failed.status).toBe('failed');
    expect(failed.data.status).toBe('failed');
  });

  it('refuses a transfer under the below-limit scenario', async () => {
    const response = await post(
      `${V4}/transfers`,
      { reference: 'v4-tr-3', amount: 1, currency: 'NGN' },
      'scenario:transfer_amount_below_limit',
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('below the allowed limit');
  });
});

describe('v3 and v4 side by side', () => {
  it('serve different envelopes from the same provider', async () => {
    const v3 = await app.inject({
      method: 'GET',
      url: '/flutterwave/v3/transactions/nope/verify',
      headers: { authorization: `Bearer ${context.flutterwaveKeys.secretKey}` },
    });
    const v4 = await app.inject({
      method: 'GET',
      url: `${V4}/customers/cus_nope`,
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(v3.json()).toMatchObject({ status: 'error' });
    expect(v3.json()).toHaveProperty('message');
    expect(v4.json()).toMatchObject({ status: 'failed', error: { type: 'NOT_FOUND' } });
  });

  it('do not accept each other’s credentials', async () => {
    // A v3 API key is not a v4 access token.
    const withV3Key = await app.inject({
      method: 'GET',
      url: `${V4}/customers/cus_x`,
      headers: { authorization: `Bearer ${context.flutterwaveKeys.secretKey}` },
    });
    expect(withV3Key.statusCode).toBe(401);

    // And a v4 token is not a v3 API key.
    const withV4Token = await app.inject({
      method: 'GET',
      url: '/flutterwave/v3/transactions',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(withV4Token.statusCode).toBe(401);
  });
});

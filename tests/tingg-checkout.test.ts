import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Tingg Checkout 3.0: OAuth, express checkout, the custom checkout API,
 * acknowledgement and refunds.
 *
 * Shapes transcribed from docs.tingg.africa, read 2026-09-20 — specifically
 * /docs/checkout-v3-express-checkout, /reference/combined-checkout-charge,
 * /reference/authenticate-requests, /reference/acknowledgement-1,
 * /reference/refund and /reference/query-status.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const CHECKOUT = '/tingg/v3/checkout-api';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'tingg';
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

const creds = () => context.tinggKeys;

async function token(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/tingg/v1/oauth/token/request',
    headers: { apiKey: creds().apiKey, 'content-type': 'application/json' },
    payload: {
      client_id: creds().clientId,
      client_secret: creds().clientSecret,
      grant_type: 'client_credentials',
    },
  });
  return response.json().access_token as string;
}

async function authed(): Promise<Record<string, string>> {
  return {
    apiKey: creds().apiKey,
    authorization: `Bearer ${await token()}`,
    'content-type': 'application/json',
  };
}

const post = async (url: string, body: unknown, headers?: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers ?? (await authed()),
    payload: body as object,
  });

const get = async (url: string) => app.inject({ method: 'GET', url, headers: await authed() });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

/**
 * A payload in Tingg's own shape.
 *
 * `request_amount` is a **major-unit** figure, the way every Tingg sample
 * quotes it, so 600 here means KES 600 and the engine must store 60000.
 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_first_name: 'John',
    customer_last_name: 'Doe',
    msisdn: '254700000000',
    account_number: 'ACC_0001',
    request_amount: 600,
    merchant_transaction_id: 'MTX-0001',
    service_code: 'TINGGTEST',
    country_code: 'KEN',
    currency_code: 'KES',
    callback_url: 'https://merchant.example/ipn',
    success_redirect_url: 'https://merchant.example/ok',
    fail_redirect_url: 'https://merchant.example/no',
    customer_email: 'john@example.com',
    payment_option_code: 'SAFKE',
    ...overrides,
  };
}

describe('authentication', () => {
  it('issues a one-hour bearer token for client_credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tingg/v1/oauth/token/request',
      headers: { apiKey: creds().apiKey, 'content-type': 'application/json' },
      payload: {
        client_id: creds().clientId,
        client_secret: creds().clientSecret,
        grant_type: 'client_credentials',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBe(3600);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('refuses a token request with no apiKey header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tingg/v1/oauth/token/request',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'x', client_secret: 'y', grant_type: 'client_credentials' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().status.status_code).toBe(500);
  });

  it('refuses an unsupported grant_type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tingg/v1/oauth/token/request',
      headers: { apiKey: creds().apiKey, 'content-type': 'application/json' },
      payload: {
        client_id: creds().clientId,
        client_secret: creds().clientSecret,
        grant_type: 'authorization_code',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires both the apiKey header and the bearer token', async () => {
    const access = await token();

    const noKey = await post(CHECKOUT + '/checkout/request', payload(), {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
    });
    expect(noKey.statusCode).toBe(401);

    const noToken = await post(CHECKOUT + '/checkout/request', payload(), {
      apiKey: creds().apiKey,
      'content-type': 'application/json',
    });
    expect(noToken.statusCode).toBe(401);
  });

  it('expires the token against virtual time', async () => {
    const headers = await authed();
    const before = await post(CHECKOUT + '/checkout/request', payload(), headers);
    expect(before.statusCode).toBe(200);

    // Tingg tokens live an hour. Moving the clock past it must invalidate one,
    // which is the whole point of modelling a TTL in an emulator.
    await advance('2h');

    const after = await post(
      CHECKOUT + '/checkout/request',
      payload({ merchant_transaction_id: 'MTX-0002' }),
      headers,
    );
    expect(after.statusCode).toBe(401);
    expect(after.json().status.status_description).toMatch(/expired/i);
  });
});

describe('express checkout', () => {
  it('returns a short and a long URL in Tingg\'s envelope', async () => {
    const response = await post(CHECKOUT + '/checkout-request/express-request', payload());
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status.status_code).toBe(200);
    expect(body.status.status_description).toBe('success');
    expect(body.results.short_url).toContain('/tingg/checkout/MTX-0001');
    expect(body.results.long_url).toBe(body.results.short_url);
  });

  it('stores the amount in minor units after converting from Tingg\'s major units', async () => {
    await post(CHECKOUT + '/checkout-request/express-request', payload({ request_amount: 75.5 }));
    const payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.amount).toBe(7550);
    expect(payment?.currency).toBe('KES');
  });

  it('serves a hosted page a payer can complete', async () => {
    await post(CHECKOUT + '/checkout-request/express-request', payload());

    const page = await app.inject({ method: 'GET', url: '/tingg/checkout/MTX-0001' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('KES 600.00');

    const paid = await app.inject({
      method: 'POST',
      url: '/tingg/checkout/MTX-0001',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'msisdn=254700000000&payment_option_code=SAFKE',
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain('Authorisation sent');

    await advance('10s');
    const payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.status).toBe('successful');
  });

  it('refuses a reused merchant_transaction_id', async () => {
    await post(CHECKOUT + '/checkout-request/express-request', payload());
    const again = await post(CHECKOUT + '/checkout-request/express-request', payload());
    expect(again.statusCode).toBe(409);
  });

  it('rejects a currency that is not the country\'s', async () => {
    const response = await post(
      CHECKOUT + '/checkout-request/express-request',
      payload({ currency_code: 'NGN' }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('rejects an account_number with characters Tingg forbids', async () => {
    const response = await post(
      CHECKOUT + '/checkout-request/express-request',
      payload({ account_number: 'ACC-0001' }),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('custom checkout', () => {
  it('logs a checkout request with overall_status 130', async () => {
    const response = await post(CHECKOUT + '/checkout/request', payload());
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status.status_code).toBe(200);
    expect(body.results.overall_status).toBe(130);
    expect(body.results.merchant_transaction_id).toBe('MTX-0001');
    expect(typeof body.results.checkout_request_id).toBe('number');
  });

  it('answers checkout-charge with status_code 1, not 200', async () => {
    const response = await post(CHECKOUT + '/checkout-charge', payload());
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Tingg's own inconsistency: express answers 200, this answers 1.
    expect(body.status.status_code).toBe(1);
    expect(body.status.status_description).toBe('Transaction was saved successfully.');
    expect(body.results.checkout_results.overall_status).toBe(130);
    expect(body.results.charge_results.payment_instructions).toContain('254700000000');
    expect(body.results.charge_results.payment_instructions).toContain('KES 600');
    expect(body.results.charge_results.third_party_response.third_party_reference).toBeDefined();
  });

  it('settles a mobile-money prompt once the clock moves', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    let payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.status).toBe('pending');

    await advance('10s');
    payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.status).toBe('successful');
    // Tingg's status vocabulary is numeric.
    expect(payment?.providerStatus).toBe('183');
  });

  it('declines the number the shared instruments decline', async () => {
    await post(CHECKOUT + '/checkout-charge', payload({ msisdn: '254700000001' }));
    await advance('10s');
    const payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.status).toBe('failed');
    expect(payment?.providerStatus).toBe('180');
  });

  it('charges a checkout that was only logged', async () => {
    await post(CHECKOUT + '/checkout/request', payload());
    const charge = await post(CHECKOUT + '/charge/request', {
      merchant_transaction_id: 'MTX-0001',
      service_code: 'TINGGTEST',
      payment_option_code: 'SAFKE',
    });
    expect(charge.statusCode).toBe(200);
    expect(charge.json().results.charge_request_id).toBeDefined();

    await advance('10s');
    const payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    expect(payment?.status).toBe('successful');
  });

  it('refuses a second charge once the payment has settled', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    await advance('10s');
    const again = await post(CHECKOUT + '/charge/request', {
      merchant_transaction_id: 'MTX-0001',
      service_code: 'TINGGTEST',
      payment_option_code: 'SAFKE',
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('query request status', () => {
  it('reports the request by service code and merchant transaction id', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    await advance('10s');

    const response = await get(`${CHECKOUT}/query/TINGGTEST/MTX-0001`);
    expect(response.statusCode).toBe(200);
    const results = response.json().results;
    expect(results.request_status_code).toBe('183');
    expect(results.amount_paid).toBe(600);
    expect(results.payments).toHaveLength(1);
    expect(results.failed_payments).toHaveLength(0);
    expect(results.country_abbrv).toBe('KE');
    // No FX ever happens, so the original figures equal the request figures.
    expect(results.original_request_amount).toBe(results.request_amount);
    expect(results.original_request_currency_code).toBe(results.request_currency_code);
  });

  it('404s a request under the wrong service code', async () => {
    await post(CHECKOUT + '/checkout/request', payload());
    const response = await get(`${CHECKOUT}/query/OTHERSERVICE/MTX-0001`);
    expect(response.statusCode).toBe(404);
    expect(response.json().status.status_code).toBe(1001);
  });
});

describe('acknowledgement', () => {
  it('accepts a full acknowledgement', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    await advance('10s');

    const response = await post(CHECKOUT + '/acknowledgement/request', {
      acknowledgement_type: 'Full',
      acknowledgment_reference: 'ACK-1',
      acknowledgement_narration: 'Order fulfilled',
      merchant_transaction_id: 'MTX-0001',
      service_code: 'TINGGTEST',
      status_code: '183',
      currency_code: 'KES',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.acknowledgment_reference).toBe('ACK-1');
  });

  it('requires an amount on a partial acknowledgement', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    const response = await post(CHECKOUT + '/acknowledgement/request', {
      acknowledgement_type: 'Partial',
      acknowledgment_reference: 'ACK-2',
      merchant_transaction_id: 'MTX-0001',
      service_code: 'TINGGTEST',
      status_code: '183',
      currency_code: 'KES',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().status.status_code).toBe(1027);
  });
});

describe('refunds', () => {
  it('accepts a full refund and answers Tingg\'s reversal envelope', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    await advance('10s');

    const response = await post(CHECKOUT + '/refund/request', {
      currency_code: 'KES',
      merchant_transaction_id: 'MTX-0001',
      refund_type: 'Full',
      refund_narration: 'Customer changed their mind',
      refund_reference: 'PRF0018',
      service_code: 'TINGGTEST',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status.status_description).toBe('Reversal request was successful.');
    expect(response.json().results.merchant_transaction_id).toBe('MTX-0001');
  });

  it('accepts Tingg\'s own uppercase PARTIAL and requires an amount', async () => {
    await post(CHECKOUT + '/checkout-charge', payload());
    await advance('10s');

    const missing = await post(CHECKOUT + '/refund/request', {
      merchant_transaction_id: 'MTX-0001',
      refund_type: 'PARTIAL',
      refund_narration: 'Half back',
      refund_reference: 'PRF0019',
      service_code: 'TINGGTEST',
    });
    expect(missing.statusCode).toBe(400);

    const ok = await post(CHECKOUT + '/refund/request', {
      merchant_transaction_id: 'MTX-0001',
      refund_type: 'PARTIAL',
      amount: 100,
      refund_narration: 'Half back',
      refund_reference: 'PRF0019',
      service_code: 'TINGGTEST',
    });
    expect(ok.statusCode).toBe(200);

    const payment = await context.engine.resolvePayment('tingg', 'MTX-0001');
    const refunds = await context.storage.refunds.listByPayment(payment!.id);
    expect(refunds.map((refund) => refund.amount)).toContain(10_000);
  });
});

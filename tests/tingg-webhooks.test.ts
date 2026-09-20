import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { TINGG_MAX_ATTEMPTS, TINGG_RETRY_INTERVAL_MS, acknowledgementCode } from '@paybox/tingg';
import type { WebhookDelivery } from '@paybox/core';

/**
 * Tingg's IPN contract -- the reason this adapter is worth having.
 *
 * Every other provider in paybox ends a delivery on any 2xx. Tingg reads an
 * acknowledgement code out of the response **body** and re-posts every thirty
 * seconds for twenty-four hours until it sees one. An integration that answers
 * a bare `200 OK` looks correct against all seven of the others and gets
 * hammered for a day in production.
 *
 * Verified at docs.tingg.africa/docs/callback and
 * /reference/4-implement-webhook-via-callback-url-1, read 2026-09-20.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const CHECKOUT = '/tingg/v3/checkout-api';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'tingg-webhooks';
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

async function authed(): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/tingg/v1/oauth/token/request',
    headers: { apiKey: context.tinggKeys.apiKey, 'content-type': 'application/json' },
    payload: {
      client_id: context.tinggKeys.clientId,
      client_secret: context.tinggKeys.clientSecret,
      grant_type: 'client_credentials',
    },
  });
  return {
    apiKey: context.tinggKeys.apiKey,
    authorization: `Bearer ${response.json().access_token}`,
    'content-type': 'application/json',
  };
}

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_first_name: 'John',
    customer_last_name: 'Doe',
    // ...0000 succeeds, per docs/test-instruments.md.
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
    payment_option_code: 'SAFKE',
    ...overrides,
  };
}

/** Drive a checkout to settlement, which is what produces an IPN. */
async function settleCheckout(overrides: Record<string, unknown> = {}): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `${CHECKOUT}/checkout-charge`,
    headers: await authed(),
    payload: payload(overrides) as object,
  });
  await advance('10s');
}

async function deliveries(): Promise<WebhookDelivery[]> {
  const page = await context.storage.webhooks.listDeliveries({ limit: 100 });
  return page.items.filter((delivery) => delivery.provider === 'tingg');
}

const ack = (code: unknown) => ({
  status: 200,
  body: JSON.stringify({
    status_code: code,
    checkout_request_id: 1,
    receipt_number: 'R-1',
    merchant_transaction_id: 'MTX-0001',
    status_description: 'ok',
  }),
  durationMs: 1,
  error: null,
});

describe('a 2xx is not an acknowledgement', () => {
  it('keeps retrying a bare 200 OK with no code', async () => {
    transport.respondWith(() => ({ status: 200, body: 'OK', durationMs: 1, error: null }));
    await settleCheckout();

    const [delivery] = await deliveries();
    expect(delivery).toBeDefined();
    // The request *was* made and answered 200 -- and it still is not delivered.
    expect(delivery!.responseStatus).toBe(200);
    expect(delivery!.status).toBe('pending');
    expect(delivery!.attempt).toBe(1);
    expect(delivery!.errorMessage).toBe(
      'Endpoint responded 200 but did not acknowledge the webhook.',
    );
  });

  it('keeps retrying a 200 whose body is JSON but carries no code', async () => {
    transport.respondWith(() => ({
      status: 200,
      body: '{"received":true}',
      durationMs: 1,
      error: null,
    }));
    await settleCheckout();

    const [delivery] = await deliveries();
    expect(delivery!.status).toBe('pending');
  });

  it.each([183, 180, 188])('accepts %i and stops retrying', async (code) => {
    transport.respondWith(() => ack(code));
    await settleCheckout();

    const [delivery] = await deliveries();
    expect(delivery!.status).toBe('succeeded');
    expect(delivery!.attempt).toBe(1);
  });

  it('accepts the code as a string, which is how Tingg types it', async () => {
    transport.respondWith(() => ack('183'));
    await settleCheckout();
    expect((await deliveries())[0]!.status).toBe('succeeded');
  });

  it('refuses a code Tingg does not publish', async () => {
    transport.respondWith(() => ack(200));
    await settleCheckout();
    expect((await deliveries())[0]!.status).toBe('pending');
  });

  it('still fails a 500 whatever the body says', async () => {
    // A formatter must never be able to mark a transport failure delivered.
    transport.respondWith(() => ({
      status: 500,
      body: JSON.stringify({ status_code: 183 }),
      durationMs: 1,
      error: null,
    }));
    await settleCheckout();

    const [delivery] = await deliveries();
    expect(delivery!.status).toBe('pending');
    expect(delivery!.errorMessage).toBe('Endpoint responded 500.');
  });

  it('leaves the other providers alone', async () => {
    // The seam is opt-in: a provider with no `interpretResponse` must still
    // treat any 2xx as delivered, or this change would have broken seven
    // adapters to fix one.
    transport.respondWith(() => ({ status: 200, body: 'OK', durationMs: 1, error: null }));

    // Paystack has no per-request callback address, so its subscriber is
    // registered the ordinary way.
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: {
        url: 'https://merchant.example/paystack',
        provider: 'paystack',
        secret: 'whsec_x',
        eventTypes: [],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers: {
        authorization: `Bearer ${context.keys.secretKey}`,
        'content-type': 'application/json',
      },
      payload: { email: 'a@example.com', amount: 5000, reference: 'PS-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/payments/PS-1/simulate',
      payload: { outcome: 'success' },
    });
    await advance('10s');

    const page = await context.storage.webhooks.listDeliveries({ limit: 100 });
    const paystack = page.items.filter((delivery) => delivery.provider === 'paystack');
    expect(paystack.length).toBeGreaterThan(0);
    for (const delivery of paystack) expect(delivery.status).toBe('succeeded');
  });
});

describe('the retry ladder', () => {
  it('is a flat thirty seconds, not exponential', async () => {
    transport.respondWith(() => ({ status: 200, body: 'OK', durationMs: 1, error: null }));
    await settleCheckout();

    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = await deliveries();
      const scheduledFrom = Date.parse(before[0]!.updatedAt);
      const nextAt = Date.parse(before[0]!.nextRetryAt!);
      gaps.push(nextAt - scheduledFrom);
      await advance('30s');
    }

    // Exponential backoff would give 1s, 2s, 4s. Tingg gives 30s every time.
    expect(gaps).toEqual([
      TINGG_RETRY_INTERVAL_MS,
      TINGG_RETRY_INTERVAL_MS,
      TINGG_RETRY_INTERVAL_MS,
    ]);
    expect((await deliveries())[0]!.attempt).toBe(4);
  });

  it('exhausts at the documented cap rather than running for 24 hours', async () => {
    transport.respondWith(() => ({ status: 200, body: 'OK', durationMs: 1, error: null }));
    await settleCheckout();

    const [initial] = await deliveries();
    expect(initial!.maxAttempts).toBe(TINGG_MAX_ATTEMPTS);

    // One advance drains the whole ladder, because every retry is a job due at
    // an instant inside the window.
    await advance('24h');

    const [delivery] = await deliveries();
    expect(delivery!.status).toBe('exhausted');
    expect(delivery!.attempt).toBe(TINGG_MAX_ATTEMPTS);
  });

  it('stops the moment an acknowledgement arrives mid-ladder', async () => {
    let attempts = 0;
    transport.respondWith(() => {
      attempts += 1;
      return attempts < 3
        ? { status: 200, body: 'OK', durationMs: 1, error: null }
        : ack(183);
    });
    await settleCheckout();
    await advance('2m');

    const [delivery] = await deliveries();
    expect(delivery!.status).toBe('succeeded');
    expect(delivery!.attempt).toBe(3);
  });
});

describe('signing', () => {
  it('sends no signature header of any kind', async () => {
    transport.respondWith(() => ack(183));
    await settleCheckout();

    const sent = transport.sent.filter((request) =>
      request.url.startsWith('https://merchant.example/ipn'),
    );
    expect(sent).toHaveLength(1);
    const headers = Object.keys(sent[0]!.headers).map((name) => name.toLowerCase());
    // Tingg signs nothing. Reproduced deliberately -- see signature.ts.
    expect(headers.filter((name) => name.includes('signature'))).toEqual([]);
    expect(headers.filter((name) => name.includes('verif'))).toEqual([]);
    expect(headers).toContain('content-type');
  });
});

describe('per-request callback addresses', () => {
  it('delivers each checkout only to the URL that checkout named', async () => {
    transport.respondWith(() => ack(183));

    await settleCheckout({
      merchant_transaction_id: 'MTX-A',
      callback_url: 'https://merchant.example/ipn-a',
    });
    await settleCheckout({
      merchant_transaction_id: 'MTX-B',
      callback_url: 'https://merchant.example/ipn-b',
    });

    const all = await deliveries();
    expect(all).toHaveLength(2);

    const byUrl = new Map(all.map((delivery) => [delivery.url, JSON.parse(delivery.payload)]));
    expect(byUrl.get('https://merchant.example/ipn-a').merchant_transaction_id).toBe('MTX-A');
    expect(byUrl.get('https://merchant.example/ipn-b').merchant_transaction_id).toBe('MTX-B');
  });

  it('carries the IPN body Tingg documents', async () => {
    transport.respondWith(() => ack(183));
    await settleCheckout();

    const body = JSON.parse((await deliveries())[0]!.payload);
    expect(body.merchant_transaction_id).toBe('MTX-0001');
    expect(body.request_status_code).toBe('183');
    expect(body.request_status_description).toBe('Payment received successfully');
    expect(body.amount_paid).toBe(600);
    expect(body.service_charge_amount).toBe(0);
    expect(body.country_abbrv).toBe('KE');
    expect(body.payments).toHaveLength(1);
    expect(body.failed_payments).toEqual([]);
    expect(body.payments[0].payer_client_name).toBe('SAFKE');
  });

  it('sends nothing while a payment is still pending', async () => {
    transport.respondWith(() => ack(183));
    await app.inject({
      method: 'POST',
      url: `${CHECKOUT}/checkout-charge`,
      headers: await authed(),
      payload: payload() as object,
    });
    // The charge is posted and the prompt is out, but nothing has settled.
    expect(await deliveries()).toHaveLength(0);
  });
});

describe('the payout callback', () => {
  it('goes to extraData.callbackUrl and accepts a nested statusCode', async () => {
    transport.respondWith(() => ({
      status: 200,
      body: JSON.stringify({
        authStatus: { authStatusCode: 131, authStatusDescription: 'no auth needed' },
        results: [{ statusCode: 188, payerTransactionID: 'PAYOUT-1' }],
      }),
      durationMs: 1,
      error: null,
    }));

    await app.inject({
      method: 'POST',
      url: '/tingg/v1/global-api/payments',
      headers: { 'content-type': 'application/json' },
      payload: {
        function: 'BEEP.postPayment',
        countryCode: 'KE',
        payload: {
          credentials: {
            username: context.tinggKeys.payoutsUsername,
            password: context.tinggKeys.payoutsPassword,
          },
          packet: [
            {
              serviceCode: 'KE-RTGS-BANK-PAYOUT',
              MSISDN: '254712345678',
              accountNumber: '01234568765',
              payerTransactionID: 'PAYOUT-1',
              amount: 1000,
              currencyCode: 'KES',
              narration: 'salary',
              extraData: { callbackUrl: 'https://merchant.example/payout-ipn' },
            },
          ],
        },
      },
    });
    await advance('10s');

    const all = await deliveries();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBe('https://merchant.example/payout-ipn');
    expect(all[0]!.status).toBe('succeeded');

    const body = JSON.parse(all[0]!.payload);
    expect(body.authStatus.authStatusCode).toBe(131);
    expect(body.results[0].statusCode).toBe(183);
    expect(body.results[0].payerTransactionID).toBe('PAYOUT-1');
  });
});

describe('acknowledgementCode', () => {
  it('reads both spellings and both types, and nothing else', () => {
    expect(acknowledgementCode('{"status_code":183}')).toBe(183);
    expect(acknowledgementCode('{"status_code":"183"}')).toBe(183);
    expect(acknowledgementCode('{"statusCode":188}')).toBe(188);
    expect(acknowledgementCode('{"results":[{"statusCode":188}]}')).toBe(188);
    expect(acknowledgementCode('{"results":[]}')).toBeNull();
    expect(acknowledgementCode('OK')).toBeNull();
    expect(acknowledgementCode('<html>200</html>')).toBeNull();
    expect(acknowledgementCode(null)).toBeNull();
    expect(acknowledgementCode('[]')).toBeNull();
  });
});

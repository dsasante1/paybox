import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  WISE_DELIVERY_HEADER,
  WISE_SIGNATURE_HEADER,
  WISE_TEST_PUBLIC_KEY,
  verifyWiseSignature,
} from '@paybox/wise';

/**
 * Wise: the quote -> recipient -> transfer -> fund flow, RSA webhooks, and
 * Wise's own simulation endpoints.
 *
 * Shapes transcribed from the Wise Platform API OpenAPI 3.1.0 document,
 * version `2026Q3` (read 2026-08-29). Coverage is documented in docs/wise.md.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'wise';
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

const token = () => context.wiseKeys.apiToken;
const auth = () => ({
  authorization: `Bearer ${token()}`,
  'content-type': 'application/json',
});

const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/wise${url}`, headers: auth(), payload: body as object });

const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/wise${url}`, headers: auth(), payload: body as object });

const put = (url: string) =>
  app.inject({ method: 'PUT', url: `/wise${url}`, headers: auth() });

const del = (url: string) =>
  app.inject({ method: 'DELETE', url: `/wise${url}`, headers: auth() });

const get = (url: string) =>
  app.inject({ method: 'GET', url: `/wise${url}`, headers: { authorization: `Bearer ${token()}` } });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

/* --------------------------- flow helpers --------------------------- */

async function profileId(type: 'PERSONAL' | 'BUSINESS' = 'PERSONAL'): Promise<number> {
  const response = await get('/v2/profiles');
  const found = response.json().find((p: { type: string }) => p.type === type);
  return found.id as number;
}

async function createRecipient(
  currency = 'GBP',
  details: Record<string, unknown> = { sortCode: '040075', accountNumber: '37778842' },
): Promise<number> {
  const response = await post('/v1/accounts', {
    currency,
    type: currency === 'GBP' ? 'sort_code' : 'iban',
    accountHolderName: 'Jane Doe',
    details,
  });
  expect(response.statusCode).toBe(200);
  return response.json().id as number;
}

async function createQuote(
  profile: number,
  body: Record<string, unknown> = {
    sourceCurrency: 'GBP',
    targetCurrency: 'GBP',
    sourceAmount: 100,
  },
): Promise<string> {
  const response = await post(`/v3/profiles/${profile}/quotes`, body);
  expect(response.statusCode).toBe(200);
  return response.json().id as string;
}

let transferCounter = 0;
async function createTransfer(
  quoteId: string,
  targetAccount: number,
  reference = 'invoice 1',
): Promise<Record<string, unknown>> {
  transferCounter += 1;
  const response = await post('/v1/transfers', {
    targetAccount,
    quoteUuid: quoteId,
    customerTransactionId: `ctid-${transferCounter}`,
    details: { reference },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/**
 * paybox opens every platform balance with a configured float (spec §24), so
 * a test that wants exact numbers measures against it rather than assuming
 * zero.
 */
async function balanceOf(profile: number, currency: string): Promise<number> {
  // `total-funds` rather than the balance list: a currency only appears in the
  // list once it has been created or has seen movement, while the opening
  // float applies from the start. This reads the number that actually funds a
  // transfer.
  const response = await get(`/v1/profiles/${profile}/total-funds/${currency}`);
  return response.json().totalWorth as number;
}

async function topUp(profile: number, currency: string, amount: number): Promise<void> {
  const balances = await get(`/v4/profiles/${profile}/balances`);
  const existing = balances.json().find((b: { currency: string }) => b.currency === currency);
  const balanceId =
    existing?.id ??
    (await post(`/v4/profiles/${profile}/balances`, { currency })).json().id;

  const response = await post('/v1/simulation/balance/topup', {
    profileId: profile,
    balanceId,
    currency,
    amount,
  });
  expect(response.statusCode).toBe(200);
}

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

describe('authentication', () => {
  it('accepts the local bearer token', async () => {
    expect((await get('/v2/profiles')).statusCode).toBe(200);
  });

  it('refuses a missing token in Wise’s envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/wise/v2/profiles' });
    expect(response.statusCode).toBe(401);
    expect(response.json().errors[0].code).toBe('UNAUTHORIZED');
    expect(response.json()).toHaveProperty('timestamp');
  });

  it('refuses anything JWT-shaped, which a real Wise token is (spec §29)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/wise/v2/profiles',
      headers: {
        authorization:
          'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().errors[0].message).toContain('real Wise access token');
  });
});

/* ------------------------------------------------------------------ *
 * Profiles and rates
 * ------------------------------------------------------------------ */

describe('profiles', () => {
  it('seeds one personal and one business profile', async () => {
    const response = await get('/v2/profiles');
    const types = response.json().map((p: { type: string }) => p.type).sort();
    expect(types).toEqual(['BUSINESS', 'PERSONAL']);
    // Wise's ids are int64, not strings.
    expect(typeof response.json()[0].id).toBe('number');
  });

  it('returns the same ids on a second call', async () => {
    const first = await get('/v2/profiles');
    const second = await get('/v2/profiles');
    expect(first.json().map((p: { id: number }) => p.id)).toEqual(
      second.json().map((p: { id: number }) => p.id),
    );
  });
});

describe('rates', () => {
  it('returns a bare array, not an envelope', async () => {
    const response = await get('/v1/rates?source=GBP&target=USD');
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
    const [rate] = response.json();
    expect(Object.keys(rate).sort()).toEqual(['rate', 'source', 'target', 'time']);
    // Wise's rate timestamps use +0000, not Z.
    expect(rate.time).toMatch(/\+0000$/);
  });

  it('quotes a single mid rate with no bid or ask', async () => {
    const [rate] = (await get('/v1/rates?source=GBP&target=USD')).json();
    expect(rate).not.toHaveProperty('bid');
    expect(rate).not.toHaveProperty('ask');
  });

  it('is deterministic', async () => {
    const first = await get('/v1/rates?source=GBP&target=USD');
    const second = await get('/v1/rates?source=GBP&target=USD');
    expect(first.json()).toEqual(second.json());
  });
});

/* ------------------------------------------------------------------ *
 * Quotes
 * ------------------------------------------------------------------ */

describe('quotes', () => {
  it('derives the target amount at the quoted rate', async () => {
    const profile = await profileId();
    const response = await post(`/v3/profiles/${profile}/quotes`, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
      sourceAmount: 100,
    });

    expect(response.statusCode).toBe(200);
    const quote = response.json();
    expect(quote.sourceAmount).toBe(100);
    expect(quote.targetAmount).toBeCloseTo(100 * quote.rate, 2);
    expect(quote.providedAmountType).toBe('SOURCE');
    expect(quote.status).toBe('PENDING');
    // Quote ids are UUIDs; transfer ids are integers.
    expect(quote.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    // ISO-8601 with a Z, unlike a transfer's `created`.
    expect(quote.createdTime).toMatch(/T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('derives the source amount when given a target', async () => {
    const profile = await profileId();
    const quote = (
      await post(`/v3/profiles/${profile}/quotes`, {
        sourceCurrency: 'GBP',
        targetCurrency: 'USD',
        targetAmount: 127,
      })
    ).json();
    expect(quote.providedAmountType).toBe('TARGET');
    expect(quote.targetAmount).toBe(127);
    expect(quote.sourceAmount).toBeGreaterThan(0);
  });

  it('refuses both amounts, which the spec forbids', async () => {
    const profile = await profileId();
    const response = await post(`/v3/profiles/${profile}/quotes`, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
      sourceAmount: 100,
      targetAmount: 127,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].message).toContain('exactly one');
  });

  it('refuses neither amount', async () => {
    const profile = await profileId();
    const response = await post(`/v3/profiles/${profile}/quotes`, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
    });
    expect(response.statusCode).toBe(400);
  });

  it('attaches a recipient with PATCH', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile);
    const account = await createRecipient('GBP');

    const patched = await patch(`/v3/profiles/${profile}/quotes/${quoteId}`, {
      targetAccount: account,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().targetAccount).toBe(account);
  });

  it('refuses a recipient in the wrong currency', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
      sourceAmount: 100,
    });
    const gbp = await createRecipient('GBP');

    const patched = await patch(`/v3/profiles/${profile}/quotes/${quoteId}`, {
      targetAccount: gbp,
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().errors[0].path).toBe('targetAccount');
  });

  it('expires after thirty minutes', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile);
    await advance('31m');
    const fetched = await get(`/v3/profiles/${profile}/quotes/${quoteId}`);
    expect(fetched.json().status).toBe('EXPIRED');
  });
});

/* ------------------------------------------------------------------ *
 * Recipients
 * ------------------------------------------------------------------ */

describe('recipients', () => {
  it('composes the display summaries Wise sends', async () => {
    const response = await post('/v1/accounts', {
      currency: 'GBP',
      type: 'sort_code',
      accountHolderName: 'Jane Doe',
      details: { sortCode: '040075', accountNumber: '37778842' },
    });

    const account = response.json();
    expect(account.accountSummary).toBe('(04-00-75) 8842');
    expect(account.longAccountSummary).toBe('GBP account ending in 8842');
    expect(account.name.fullName).toBe('Jane Doe');
    expect(account.active).toBe(true);
    expect(account.displayFields).toEqual(
      expect.arrayContaining([
        { key: 'details/sortCode', label: 'UK sort code', value: '040075' },
      ]),
    );
  });

  it('deactivates rather than deleting', async () => {
    const account = await createRecipient('GBP');
    const deleted = await del(`/v2/accounts/${account}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().active).toBe(false);

    // Still resolvable, so a historical transfer keeps its destination.
    expect((await get(`/v2/accounts/${account}`)).statusCode).toBe(200);
    // But gone from the list.
    const listed = await get('/v2/accounts');
    expect(listed.json().content.map((a: { id: number }) => a.id)).not.toContain(account);
  });

  it('serves the account requirements for a quote’s currency', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile, {
      sourceCurrency: 'GBP',
      targetCurrency: 'EUR',
      sourceAmount: 100,
    });
    const response = await get(`/v1/quotes/${quoteId}/account-requirements`);
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].type).toBe('iban');
  });
});

/* ------------------------------------------------------------------ *
 * Transfers — the flow's rules
 * ------------------------------------------------------------------ */

describe('transfers', () => {
  it('creates one from a quote in Wise’s shape', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(quoteId, account, 'invoice 42');

    expect(typeof transfer.id).toBe('number');
    expect(transfer.status).toBe('incoming_payment_waiting');
    expect(transfer.quoteUuid).toBe(quoteId);
    // The v1 numeric quote id is null; the UUID carries the reference.
    expect(transfer.quote).toBeNull();
    expect(transfer.targetAccount).toBe(account);
    expect(transfer.reference).toBe('invoice 42');
    expect(transfer.sourceValue).toBe(100);
    // Space-separated, no Z — unlike the quote's ISO createdTime.
    expect(transfer.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('refuses a second transfer from the same quote', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile);
    const account = await createRecipient('GBP');
    await createTransfer(quoteId, account);

    const second = await post('/v1/transfers', {
      targetAccount: account,
      quoteUuid: quoteId,
      customerTransactionId: 'ctid-second',
      details: { reference: 'again' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().errors[0].message).toContain('one transfer per quote');
  });

  it('refuses an expired quote', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile);
    const account = await createRecipient('GBP');
    await advance('31m');

    const response = await post('/v1/transfers', {
      targetAccount: account,
      quoteUuid: quoteId,
      customerTransactionId: 'ctid-expired',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors[0].code).toBe('transfer.invalid-state');
  });

  it('is idempotent on customerTransactionId', async () => {
    const profile = await profileId();
    const account = await createRecipient('GBP');
    const body = (quoteId: string) => ({
      targetAccount: account,
      quoteUuid: quoteId,
      customerTransactionId: 'ctid-repeat',
      details: { reference: 'once' },
    });

    const first = await post('/v1/transfers', body(await createQuote(profile)));
    const second = await post('/v1/transfers', body(await createQuote(profile)));

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect((await get('/v1/transfers')).json()).toHaveLength(1);
  });

  it('cancels before the payout leaves, and refuses after', async () => {
    const profile = await profileId();
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);

    const cancelled = await put(`/v1/transfers/${transfer.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');

    const again = await put(`/v1/transfers/${transfer.id}/cancel`);
    expect(again.statusCode).not.toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Funding — where a rejection is a 201
 * ------------------------------------------------------------------ */

describe('funding', () => {
  it('debits the balance and moves the transfer', async () => {
    const profile = await profileId();
    await topUp(profile, 'GBP', 500);
    const opening = await balanceOf(profile, 'GBP');
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);

    const funded = await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, {
      type: 'BALANCE',
    });

    expect(funded.statusCode).toBe(201);
    expect(funded.json().status).toBe('COMPLETED');
    expect(funded.json().errorCode).toBeNull();
    expect(typeof funded.json().balanceTransactionId).toBe('number');

    const after = await get(`/v1/transfers/${transfer.id}`);
    expect(after.json().status).toBe('processing');

    expect(await balanceOf(profile, 'GBP')).toBe(opening - 100);
  });

  it('reports an insufficient balance as a 201 REJECTED, not an HTTP error', async () => {
    const profile = await profileId();
    const account = await createRecipient('GBP');
    // More than the opening float. Creating this is fine — a Wise transfer
    // commits nothing until it is funded, which is the point of the test.
    const quoteId = await createQuote(profile, {
      sourceCurrency: 'GBP',
      targetCurrency: 'GBP',
      sourceAmount: 500_000,
    });
    const transfer = await createTransfer(quoteId, account);

    const funded = await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, {
      type: 'BALANCE',
    });

    // The critical detail: 201, not 4xx. A client branching on the HTTP
    // status alone would read this rejection as a success.
    expect(funded.statusCode).toBe(201);
    expect(funded.json().status).toBe('REJECTED');
    expect(funded.json().errorCode).toBe('balance.payment-option-unavailable');
  });

  it('rejects a second funding of the same transfer', async () => {
    const profile = await profileId();
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);

    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    const again = await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, {
      type: 'BALANCE',
    });

    expect(again.statusCode).toBe(201);
    expect(again.json().status).toBe('REJECTED');
    // Wise's code for a transfer that already has a payment against it.
    expect(again.json().errorCode).toBe('payment.exists');
  });

  it('rejects a pay-in type paybox cannot settle', async () => {
    const profile = await profileId();
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);

    const funded = await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, {
      type: 'BANK_TRANSFER',
    });
    expect(funded.json().errorCode).toBe('payment.option-unavailable');
  });

  it('lists the payment only once funded', async () => {
    const profile = await profileId();
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);

    expect((await get(`/v1/transfers/${transfer.id}/payments`)).json()).toEqual([]);
    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    const payments = await get(`/v1/transfers/${transfer.id}/payments`);
    expect(payments.json()).toHaveLength(1);
    expect(payments.json()[0].method).toBe('BALANCE');
  });
});

/* ------------------------------------------------------------------ *
 * Wise's own simulation endpoints
 * ------------------------------------------------------------------ */

describe('simulation', () => {
  async function fundedTransfer(): Promise<{ profile: number; id: number }> {
    const profile = await profileId();
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);
    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    return { profile, id: transfer.id as number };
  }

  it('drives a transfer to outgoing_payment_sent', async () => {
    const { id } = await fundedTransfer();
    const response = await get(`/v1/simulation/transfers/${id}/outgoing_payment_sent`);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('outgoing_payment_sent');
  });

  it('distinguishes funds_converted from processing', async () => {
    const { id } = await fundedTransfer();
    expect((await get(`/v1/transfers/${id}`)).json().status).toBe('processing');

    const converted = await get(`/v1/simulation/transfers/${id}/funds_converted`);
    expect(converted.json().status).toBe('funds_converted');
    // The canonical status has not moved; only the milestone flag.
    expect((await get(`/v1/transfers/${id}`)).json().status).toBe('funds_converted');
  });

  it('drives bounced_back and funds_refunded', async () => {
    const bounced = await fundedTransfer();
    expect(
      (await get(`/v1/simulation/transfers/${bounced.id}/bounced_back`)).json().status,
    ).toBe('bounced_back');

    const refunded = await fundedTransfer();
    expect(
      (await get(`/v1/simulation/transfers/${refunded.id}/funds_refunded`)).json().status,
    ).toBe('funds_refunded');
  });

  it('refuses a status Wise does not accept', async () => {
    const { id } = await fundedTransfer();
    const response = await get(`/v1/simulation/transfers/${id}/teleported`);
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].path).toBe('status');
  });

  it('tops a balance up, so no emulator-only endpoint is needed', async () => {
    const profile = await profileId();
    const before = await balanceOf(profile, 'GBP');
    await topUp(profile, 'GBP', 250);
    expect(await balanceOf(profile, 'GBP')).toBe(before + 250);
  });
});

/* ------------------------------------------------------------------ *
 * Balances and conversion
 * ------------------------------------------------------------------ */

describe('balances', () => {
  it('nests money as {value, currency}, as Wise does', async () => {
    const profile = await profileId();
    await topUp(profile, 'GBP', 100);
    const balances = await get(`/v4/profiles/${profile}/balances`);
    const gbp = balances.json().find((b: { currency: string }) => b.currency === 'GBP');

    expect(gbp.amount).toEqual({ value: gbp.amount.value, currency: 'GBP' });
    expect(gbp.reservedAmount).toEqual({ value: 0, currency: 'GBP' });
    expect(gbp.cashAmount).toEqual(gbp.amount);
    expect(gbp.type).toBe('STANDARD');
  });

  it('converts between two balances as two integer ledger entries', async () => {
    const profile = await profileId();
    await topUp(profile, 'GBP', 1000);
    const quoteId = await createQuote(profile, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
      sourceAmount: 100,
    });
    const quote = (await get(`/v3/profiles/${profile}/quotes/${quoteId}`)).json();
    const usdBefore = await balanceOf(profile, 'USD');
    const gbpBefore = await balanceOf(profile, 'GBP');

    const moved = await post(`/v2/profiles/${profile}/balance-movements`, { quoteId });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().state).toBe('COMPLETED');

    // The USD side gains exactly the quoted target amount, on top of whatever
    // opening float that currency already carried.
    expect(await balanceOf(profile, 'USD')).toBeCloseTo(usdBefore + quote.targetAmount, 2);
    expect(await balanceOf(profile, 'GBP')).toBeCloseTo(gbpBefore - 100, 2);
  });

  it('refuses a conversion larger than the balance', async () => {
    const profile = await profileId();
    const quoteId = await createQuote(profile, {
      sourceCurrency: 'GBP',
      targetCurrency: 'USD',
      sourceAmount: 500_000,
    });
    const response = await post(`/v2/profiles/${profile}/balance-movements`, { quoteId });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors[0].code).toBe('balance.payment-option-unavailable');
  });
});

/* ------------------------------------------------------------------ *
 * Webhooks — RSA, not HMAC
 * ------------------------------------------------------------------ */

describe('webhooks', () => {
  async function subscribe(profile: number): Promise<Record<string, unknown>> {
    const response = await post(`/v2/profiles/${profile}/subscriptions`, {
      name: 'Webhook Subscription #1',
      trigger_on: 'transfers#state-change',
      delivery: { version: '2.0.0', url: 'https://example.test/hook' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it('creates a subscription in Wise’s snake_case shape', async () => {
    const profile = await profileId();
    const subscription = await subscribe(profile);

    expect(subscription.trigger_on).toBe('transfers#state-change');
    expect(subscription.delivery).toEqual({ version: '2.0.0', url: 'https://example.test/hook' });
    expect(subscription.scope).toEqual({ domain: 'profile', id: String(profile) });
    expect(subscription.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('signs with RSA and verifies against the published public key', async () => {
    const profile = await profileId();
    await subscribe(profile);
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);
    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    await advance('30s');

    const delivery = transport.sent[0];
    expect(delivery, 'a webhook delivery').toBeDefined();

    const headers = delivery!.headers as Record<string, string>;
    expect(headers[WISE_SIGNATURE_HEADER]).toBeTruthy();
    expect(headers[WISE_DELIVERY_HEADER]).toMatch(/^[0-9a-f]{8}-/);

    // The point of an asymmetric scheme: verification needs no secret.
    expect(verifyWiseSignature(headers[WISE_SIGNATURE_HEADER] as string, delivery!.body)).toBe(true);
  });

  it('fails verification when the body is tampered with', async () => {
    const profile = await profileId();
    await subscribe(profile);
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);
    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    await advance('30s');

    const delivery = transport.sent[0]!;
    const signature = (delivery.headers as Record<string, string>)[WISE_SIGNATURE_HEADER] as string;
    expect(verifyWiseSignature(signature, `${delivery.body} `)).toBe(false);
  });

  it('publishes the public key it signs with', async () => {
    const response = await get('/paybox/webhook-public-key');
    expect(response.statusCode).toBe(200);
    expect(response.body.trim()).toBe(WISE_TEST_PUBLIC_KEY.trim());
    expect(response.body).toContain('BEGIN PUBLIC KEY');
  });

  it('sends one trigger and puts the outcome in current_state', async () => {
    const profile = await profileId();
    await subscribe(profile);
    await topUp(profile, 'GBP', 500);
    const account = await createRecipient('GBP');
    const transfer = await createTransfer(await createQuote(profile), account);
    await post(`/v3/profiles/${profile}/transfers/${transfer.id}/payments`, { type: 'BALANCE' });
    await get(`/v1/simulation/transfers/${transfer.id}/outgoing_payment_sent`);
    await advance('30s');

    const bodies = transport.sent.map((call) => JSON.parse(call.body));
    // Wise sends no past-tense event name; every delivery is one trigger.
    expect(new Set(bodies.map((b) => b.event_type))).toEqual(
      new Set(['transfers#state-change']),
    );
    expect(bodies.map((b) => b.data.current_state)).toContain('outgoing_payment_sent');
    expect(bodies[0].schema_version).toBe('2.0.0');
    expect(bodies[0].data.resource.type).toBe('transfer');
    expect(bodies[0].data.resource.id).toBe(transfer.id);
  });

  it('lists and deletes subscriptions', async () => {
    const profile = await profileId();
    const subscription = await subscribe(profile);

    const listed = await get(`/v2/profiles/${profile}/subscriptions`);
    expect(listed.json()).toHaveLength(1);

    const deleted = await del(`/v2/profiles/${profile}/subscriptions/${subscription.id}`);
    expect(deleted.statusCode).toBe(204);
    expect((await get(`/v2/profiles/${profile}/subscriptions`)).json()).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Flutterwave v3 depth: payment plans, tokenized charges, subaccounts,
 * virtual account numbers and banks.
 *
 * Each maps onto a resource paybox already models canonically, which is why
 * none of them needed a new engine concept — a payment plan is a Plan, a card
 * token is an Authorization, a virtual account number is a DedicatedAccount.
 *
 * Shapes verified at developer.flutterwave.com/v3.0.0/docs (payment-plans-1,
 * tokenization, card-on-file, split-payments, ngn-virtual-accounts), read
 * 2026-08-29.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-15T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'flw-depth';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = () => ({
  authorization: `Bearer ${context.flutterwaveKeys.secretKey}`,
  'content-type': 'application/json',
});

const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: body as object });
const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, headers: auth(), payload: body as object });
const get = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${context.flutterwaveKeys.secretKey}` },
  });
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

describe('payment plans', () => {
  it('creates one and reads it back', async () => {
    const created = (
      await post('/flutterwave/v3/payment-plans', {
        amount: 5000,
        name: 'Church collections plan',
        interval: 'monthly',
      })
    ).json();

    expect(created.status).toBe('success');
    expect(created.data).toMatchObject({
      name: 'Church collections plan',
      amount: 5000,
      interval: 'monthly',
      status: 'active',
    });

    const fetched = (await get(`/flutterwave/v3/payment-plans/${created.data.id}`)).json();
    expect(fetched.data.name).toBe('Church collections plan');
  });

  it('refuses an interval the engine cannot represent', async () => {
    const response = await post('/flutterwave/v3/payment-plans', {
      amount: 5000,
      name: 'Quarterly',
      interval: 'quarterly',
    });

    // Rounding quarterly to monthly would bill four times a year instead of
    // once a quarter, so it is refused rather than approximated.
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('does not model');
  });

  it('cancels one', async () => {
    const created = (
      await post('/flutterwave/v3/payment-plans', { amount: 100, name: 'P', interval: 'weekly' })
    ).json();

    const cancelled = (
      await put(`/flutterwave/v3/payment-plans/${created.data.id}`, { status: 'cancelled' })
    ).json();
    expect(cancelled.data.status).toBe('cancelled');
  });

  it('lists them', async () => {
    await post('/flutterwave/v3/payment-plans', { amount: 100, name: 'A', interval: 'daily' });
    await post('/flutterwave/v3/payment-plans', { amount: 200, name: 'B', interval: 'yearly' });

    const body = (await get('/flutterwave/v3/payment-plans')).json();
    expect(body.data).toHaveLength(2);
    // `yearly` maps to the canonical `annually`.
    expect(body.data.map((p: { interval: string }) => p.interval).sort()).toEqual([
      'annually',
      'daily',
    ]);
  });
});

describe('tokenized charges', () => {
  /** Settle a card charge so the engine mints a reusable token. */
  async function tokenFromACharge() {
    await post('/flutterwave/v3/charges?type=card', {
      card_number: '5061460166976054667',
      cvv: '564',
      expiry_month: '10',
      expiry_year: '29',
      currency: 'NGN',
      amount: '7500',
      email: 'ada@example.com',
      tx_ref: 'tok-seed',
    });
    await advance('30s');

    const stored = await context.storage.authorizations.list({ provider: 'flutterwave' });
    return stored.items[0]!;
  }

  it('mints a reusable token from a settled card charge', async () => {
    const authorization = await tokenFromACharge();
    expect(authorization.reusable).toBe(true);
    expect(authorization.last4).toBe('4667');
  });

  it('charges the token without a step-up', async () => {
    const authorization = await tokenFromACharge();
    const body = (
      await post('/flutterwave/v3/tokenized-charges', {
        token: authorization.providerAuthorizationCode,
        currency: 'NGN',
        amount: '3000',
        email: 'ada@example.com',
        tx_ref: 'tok-1',
      })
    ).json();

    // The point of a stored token is that the customer is not there.
    expect(body.message).toBe('Charge successful');
    expect(body.data.status).toBe('successful');
    expect(body.data.amount).toBe(3000);
  });

  it('refuses a deactivated token', async () => {
    const authorization = await tokenFromACharge();
    await context.engine.deactivateAuthorization(authorization.id);

    const response = await post('/flutterwave/v3/tokenized-charges', {
      token: authorization.providerAuthorizationCode,
      currency: 'NGN',
      amount: '3000',
      email: 'ada@example.com',
      tx_ref: 'tok-2',
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for an unknown token', async () => {
    const response = await post('/flutterwave/v3/tokenized-charges', {
      token: 'not-a-token',
      currency: 'NGN',
      amount: '100',
      email: 'ada@example.com',
      tx_ref: 'tok-3',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('subaccounts', () => {
  it('creates one, converting Flutterwave’s fractional split', async () => {
    const body = (
      await post('/flutterwave/v3/subaccounts', {
        account_bank: '044',
        account_number: '0690000032',
        business_name: 'Eternal Blue Sky Limited',
        business_email: 'sky@example.com',
        split_type: 'percentage',
        split_value: 0.2,
      })
    ).json();

    expect(body.data).toMatchObject({
      business_name: 'Eternal Blue Sky Limited',
      account_number: '0690000032',
      account_bank: '044',
    });
    // Flutterwave writes 20% as 0.2; the canonical field is a percentage.
    expect(body.data.split_value).toBe(0.2);
    const stored = await context.storage.subaccounts.list({ provider: 'flutterwave' });
    expect(stored.items[0]?.percentageCharge).toBe(20);
  });

  it('is usable immediately, unlike a Stripe connected account', async () => {
    await post('/flutterwave/v3/subaccounts', {
      account_bank: '044',
      account_number: '0690000033',
      business_name: 'Ada Books',
    });

    const stored = await context.storage.subaccounts.list({ provider: 'flutterwave' });
    // Flutterwave has no onboarding gate; only Stripe Connect does.
    expect(stored.items[0]?.chargesEnabled).toBe(true);
    expect(stored.items[0]?.detailsSubmitted).toBe(true);
  });

  it('lists and fetches them', async () => {
    const created = (
      await post('/flutterwave/v3/subaccounts', {
        account_bank: '058',
        account_number: '0690000034',
        business_name: 'Grace Ltd',
      })
    ).json();

    expect((await get('/flutterwave/v3/subaccounts')).json().data).toHaveLength(1);
    const fetched = (await get(`/flutterwave/v3/subaccounts/${created.data.id}`)).json();
    expect(fetched.data.business_name).toBe('Grace Ltd');
  });
});

describe('virtual account numbers', () => {
  it('mints a synthetic account bound to a customer', async () => {
    const body = (
      await post('/flutterwave/v3/virtual-account-numbers', {
        email: 'ada@example.com',
        is_permanent: true,
        firstname: 'Ada',
        lastname: 'Lovelace',
      })
    ).json();

    expect(body.data.account_number).toMatch(/^\d{10}$/);
    expect(body.data.bank_name).toBe('PAYBOX TEST BANK');
    expect(body.data.frequency).toBe('N/A');
    expect(body.data.flw_ref).toMatch(/^VAN/);
  });

  it('reads one back by account number', async () => {
    const created = (
      await post('/flutterwave/v3/virtual-account-numbers', { email: 'grace@example.com' })
    ).json();

    const fetched = (
      await get(`/flutterwave/v3/virtual-account-numbers/${created.data.account_number}`)
    ).json();
    expect(fetched.data.account_number).toBe(created.data.account_number);
  });

  it('gives one customer one account, not a growing pile', async () => {
    await post('/flutterwave/v3/virtual-account-numbers', { email: 'ada@example.com' });
    await post('/flutterwave/v3/virtual-account-numbers', { email: 'ada@example.com' });

    const stored = await context.storage.dedicatedAccounts.list({ provider: 'flutterwave' });
    expect(stored.total).toBe(1);
  });
});

describe('banks', () => {
  it('lists real Nigerian bank codes', async () => {
    const body = (await get('/flutterwave/v3/banks/NG')).json();
    expect(body.status).toBe('success');
    // Real codes, so a transfer payload copied from a developer's own code
    // works here unchanged.
    expect(body.data.map((b: { code: string }) => b.code)).toContain('044');
    expect(body.data.map((b: { name: string }) => b.name)).toContain('Access Bank');
  });

  it('says which countries it has rather than returning nothing', async () => {
    const response = await get('/flutterwave/v3/banks/ZZ');
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('Available:');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Connect: connected accounts and onboarding.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` schema
 * `account` (API version 2026-08-26.dahlia, read 2026-08-28); event names
 * against the same spec's webhook list.
 *
 * The load-bearing assertion is the *first* one: a freshly created account
 * cannot charge anything. Every other Connect test in this repo would pass
 * against an emulator that got that wrong, and every integration built on one
 * would break the day it met real Stripe.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-02-01T09:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'connect';
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

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  return params.toString();
}

const post = (url: string, fields: Record<string, string | number> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });

const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: auth });

async function account(fields: Record<string, string | number> = {}) {
  return (
    await post('/stripe/v1/accounts', {
      type: 'express',
      country: 'US',
      email: 'seller@example.com',
      'capabilities[card_payments][requested]': 'true',
      'capabilities[transfers][requested]': 'true',
      ...fields,
    })
  ).json();
}

/** Walk the account through the hosted onboarding page. */
async function onboard(accountId: string, outcome = 'complete') {
  const link = (await post('/stripe/v1/account_links', { account: accountId })).json();
  const path = new URL(link.url).pathname;
  await app.inject({
    method: 'POST',
    url: `${path}/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ outcome }),
  });
  return (await get(`/stripe/v1/accounts/${accountId}`)).json();
}

async function endpoint() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: {
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_x',
      eventTypes: [],
    },
  });
}

async function deliveredTypes(): Promise<string[]> {
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });
  return transport.sent.map((request) => JSON.parse(request.body).type as string);
}

describe('creating a connected account', () => {
  it('cannot charge anything yet', async () => {
    const created = await account();

    expect(created).toMatchObject({
      object: 'account',
      type: 'express',
      country: 'US',
      email: 'seller@example.com',
      // The whole point. A new Stripe account is not usable.
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    });
    expect(created.id).toMatch(/^acct_/);
  });

  it('says what it is waiting for', async () => {
    const created = await account();

    expect(created.requirements.currently_due).toContain('external_account');
    expect(created.requirements.currently_due).toContain('tos_acceptance.date');
    expect(created.requirements.disabled_reason).toBe('requirements.past_due');
    // The full shape, so a client reading any of these fields does not crash.
    expect(created.requirements).toMatchObject({
      alternatives: [],
      current_deadline: null,
      errors: [],
      past_due: [],
      pending_verification: [],
    });
  });

  it('leaves requested capabilities inactive until onboarding', async () => {
    const created = await account();
    expect(created.capabilities).toEqual({
      card_payments: 'inactive',
      transfers: 'inactive',
    });
  });

  it('defaults to a standard account', async () => {
    const created = (await post('/stripe/v1/accounts', { email: 'x@example.com' })).json();
    expect(created.type).toBe('standard');
    expect(created.country).toBe('US');
    expect(created.default_currency).toBe('usd');
  });

  it('never accepts real bank details', async () => {
    const created = await account();
    const bank = created.external_accounts.data[0];
    // Generated, not supplied: no real account number may enter (spec §29).
    expect(bank.bank_name).toBe('TEST BANK');
    expect(bank.last4).toMatch(/^\d{4}$/);
  });

  it('rejects an unsupported currency', async () => {
    const response = await post('/stripe/v1/accounts', { default_currency: 'zzz' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('currency_not_supported');
  });
});

describe('onboarding', () => {
  it('hands back a short-lived link', async () => {
    const created = await account();
    const link = (await post('/stripe/v1/account_links', { account: created.id })).json();

    expect(link.object).toBe('account_link');
    expect(link.url).toContain(`/stripe/connect/onboard/${created.id}`);
    // An hour, in virtual time.
    expect(link.expires_at - link.created).toBe(3_600);
  });

  it('serves a real page at that link', async () => {
    const created = await account();
    const link = (await post('/stripe/v1/account_links', { account: created.id })).json();

    const page = await app.inject({ method: 'GET', url: new URL(link.url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('paybox emulator');
    expect(page.body).toContain('external_account');
  });

  it('enables charges and payouts once completed', async () => {
    const created = await account();
    const done = await onboard(created.id);

    expect(done).toMatchObject({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    expect(done.requirements.currently_due).toEqual([]);
    expect(done.requirements.disabled_reason).toBeNull();
    expect(done.capabilities).toEqual({ card_payments: 'active', transfers: 'active' });
    expect(done.tos_acceptance.date).not.toBeNull();
  });

  it('leaves the account unusable if abandoned', async () => {
    const created = await account();
    const abandoned = await onboard(created.id, 'abandon');

    expect(abandoned.charges_enabled).toBe(false);
    expect(abandoned.details_submitted).toBe(false);
    expect(abandoned.requirements.currently_due.length).toBeGreaterThan(0);
  });

  it('redirects back where the platform asked', async () => {
    const created = await account();
    const link = (
      await post('/stripe/v1/account_links', {
        account: created.id,
        return_url: 'https://platform.example/done',
      })
    ).json();

    const url = new URL(link.url);
    const page = await app.inject({
      method: 'POST',
      url: `${url.pathname}/complete${url.search}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=complete',
    });
    expect(page.body).toContain('https://platform.example/done');
  });

  it('shows the outcome rather than the form once already onboarded', async () => {
    const created = await account();
    await onboard(created.id);
    const link = (await post('/stripe/v1/account_links', { account: created.id })).json();

    const page = await app.inject({ method: 'GET', url: new URL(link.url).pathname });
    expect(page.body).toContain('Onboarding complete');
  });
});

describe('updating and rejecting', () => {
  it('updates the profile', async () => {
    const created = await account();
    const updated = (
      await post(`/stripe/v1/accounts/${created.id}`, {
        'business_profile[name]': 'Ada Books',
        'business_profile[url]': 'https://ada.example',
        'metadata[tier]': 'gold',
      })
    ).json();

    expect(updated.business_profile.name).toBe('Ada Books');
    expect(updated.business_profile.url).toBe('https://ada.example');
    expect(updated.metadata.tier).toBe('gold');
  });

  it('rejects an account and disables it', async () => {
    const created = await account();
    await onboard(created.id);

    const rejected = (
      await post(`/stripe/v1/accounts/${created.id}/reject`, { reason: 'fraud' })
    ).json();

    expect(rejected.charges_enabled).toBe(false);
    expect(rejected.payouts_enabled).toBe(false);
    expect(rejected.requirements.disabled_reason).toBe('rejected.fraud');
    expect(rejected.capabilities).toEqual({
      card_payments: 'inactive',
      transfers: 'inactive',
    });
  });

  it('requires a documented rejection reason', async () => {
    const created = await account();
    const response = await post(`/stripe/v1/accounts/${created.id}/reject`, { reason: 'because' });

    // A malformed request is a 400, not a 500 -- the emulator did not break.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: 'invalid_request_error',
      code: 'parameter_invalid',
      param: 'reason',
    });
  });

  it('deletes by rejecting, keeping the audit trail', async () => {
    const created = await account();
    const deleted = (await del(`/stripe/v1/accounts/${created.id}`)).json();

    expect(deleted).toMatchObject({ id: created.id, deleted: true });
    // Still readable: charges it took must not point at nothing.
    const read = (await get(`/stripe/v1/accounts/${created.id}`)).json();
    expect(read.charges_enabled).toBe(false);
  });
});

describe('reading accounts', () => {
  it('lists them', async () => {
    await account({ email: 'one@example.com' });
    await account({ email: 'two@example.com' });

    const listed = (await get('/stripe/v1/accounts')).json();
    expect(listed.object).toBe('list');
    expect(listed.data).toHaveLength(2);
    expect(listed.url).toBe('/v1/accounts');
  });

  it('404s on an unknown account', async () => {
    const response = await get('/stripe/v1/accounts/acct_nope');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource_missing');
  });
});

describe('webhooks', () => {
  it('reports account.updated, and never account.created', async () => {
    await endpoint();
    const created = await account();
    await onboard(created.id);

    const types = await deliveredTypes();
    expect(types).toContain('account.updated');
    // Stripe sends no account.created: the platform made it and already knows.
    expect(types).not.toContain('account.created');
  });
});

describe('Paystack subaccounts are unaffected', () => {
  it('are usable the moment they are created', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/paystack/subaccount',
      headers: { authorization: 'Bearer sk_test_local_suite', 'content-type': 'application/json' },
      payload: {
        business_name: 'Ada Books',
        settlement_bank: '058',
        account_number: '0123456789',
        percentage_charge: 20,
      },
    });

    expect(response.statusCode).toBe(201);
    // Paystack has no onboarding lifecycle; nothing about it changed.
    const stored = await context.storage.subaccounts.list({ provider: 'paystack' });
    expect(stored.items[0]?.chargesEnabled).toBe(true);
    expect(stored.items[0]?.detailsSubmitted).toBe(true);
  });
});

describe('malformed requests', () => {
  it('are 400 with the offending field, not 500', async () => {
    // Regression: every zod rejection in this adapter used to fall through to
    // the generic handler and answer 500 `api_error`, which sends a developer
    // to debug the emulator instead of their own payload.
    const response = await post('/stripe/v1/payment_intents', { currency: 'usd' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: 'invalid_request_error',
      code: 'parameter_missing',
      param: 'amount',
    });
  });

  it('name a nested field by its path', async () => {
    const response = await post('/stripe/v1/prices', {
      currency: 'usd',
      unit_amount: 500,
      'recurring[interval]': 'fortnight',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe('recurring.interval');
  });

  it('do the same on the Paystack side', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers: { authorization: 'Bearer sk_test_local_suite', 'content-type': 'application/json' },
      payload: { email: 'ada@example.com' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().status).toBe(false);
    expect(response.json().message).toContain('amount');
  });
});

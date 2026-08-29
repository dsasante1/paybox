import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Connect: direct charges, application fees and scoped balances.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28).
 *
 * These assert where the *money* ends up, not just what the JSON says. A
 * marketplace emulator that reports the right fields while putting the funds
 * in the wrong pot is worse than useless: it would confirm a broken
 * integration.
 */
let app: FastifyInstance;
let context: PayboxContext;
/**
 * The platform's opening test float.
 *
 * A fresh emulator can pay out before it has collected anything, so the
 * platform pot does not start at zero. Connected accounts do -- see the last
 * test in this file -- so platform assertions are deltas against this.
 */
let float: number;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-02-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'connect-charges';
  const { config } = loadConfig();
  context = await buildContext({ config, transport: new RecordingTransport(), logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
  float = await context.engine.getBalance('stripe', 'USD', null);
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

const post = (
  url: string,
  fields: Record<string, string | number> = {},
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: form(fields),
  });

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...auth, ...headers } });

const VISA = '4242424242424242';

/** An onboarded connected account, ready to take charges. */
async function connectedAccount() {
  const created = (
    await post('/stripe/v1/accounts', {
      type: 'express',
      country: 'US',
      email: 'seller@example.com',
      default_currency: 'usd',
      'capabilities[card_payments][requested]': 'true',
    })
  ).json();

  const link = (await post('/stripe/v1/account_links', { account: created.id })).json();
  await app.inject({
    method: 'POST',
    url: `${new URL(link.url).pathname}/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'outcome=complete',
  });
  return created.id as string;
}

/** The canonical id behind an `acct_` handle, for reading the ledger. */
const canonical = (accountId: string) => accountId.replace(/^acct_/, 'sac_');

async function balanceOf(accountId: string | null, currency = 'USD') {
  return context.engine.getBalance('stripe', currency, accountId ? canonical(accountId) : null);
}

describe('a direct charge', () => {
  it('puts the money on the connected account, less the platform fee', async () => {
    const acct = await connectedAccount();
    const platformBefore = await balanceOf(null);

    const charge = (
      await post(
        '/stripe/v1/charges',
        { amount: 10_000, currency: 'usd', application_fee_amount: 1_500, 'card[number]': VISA },
        { 'stripe-account': acct },
      )
    ).json();

    expect(charge.status).toBe('succeeded');
    expect(charge.amount).toBe(10_000);
    expect(charge.application_fee_amount).toBe(1_500);
    expect(charge.application_fee).toMatch(/^fee_/);

    // The seller keeps 8500; the platform keeps 1500.
    expect(await balanceOf(acct)).toBe(8_500);
    expect(await balanceOf(null)).toBe(platformBefore + 1_500);
  });

  it('gives the whole amount to the account when there is no fee', async () => {
    const acct = await connectedAccount();
    const platformBefore = await balanceOf(null);

    await post(
      '/stripe/v1/charges',
      { amount: 4_000, currency: 'usd', 'card[number]': VISA },
      { 'stripe-account': acct },
    );

    expect(await balanceOf(acct)).toBe(4_000);
    expect(await balanceOf(null)).toBe(platformBefore);
  });

  it('is refused for an account that has not onboarded', async () => {
    const pending = (
      await post('/stripe/v1/accounts', { type: 'express', default_currency: 'usd' })
    ).json();

    const response = await post(
      '/stripe/v1/charges',
      { amount: 1_000, currency: 'usd', 'card[number]': VISA },
      { 'stripe-account': pending.id },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('onboarding is incomplete');
    // Named by the handle the caller sent, not an internal code they have
    // never seen.
    expect(response.json().error.message).toContain(pending.id);
    // No money moved.
    expect(await balanceOf(pending.id)).toBe(0);
  });

  it('is refused for a rejected account', async () => {
    const acct = await connectedAccount();
    await post(`/stripe/v1/accounts/${acct}/reject`, { reason: 'fraud' });

    const response = await post(
      '/stripe/v1/charges',
      { amount: 1_000, currency: 'usd', 'card[number]': VISA },
      { 'stripe-account': acct },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('rejected');
  });

  it('refuses a fee larger than the charge', async () => {
    const acct = await connectedAccount();
    const response = await post(
      '/stripe/v1/charges',
      { amount: 500, currency: 'usd', application_fee_amount: 900, 'card[number]': VISA },
      { 'stripe-account': acct },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('exceeds the charge amount');
  });

  it('errors on an unknown account rather than silently charging the platform', async () => {
    const response = await post(
      '/stripe/v1/charges',
      { amount: 1_000, currency: 'usd', 'card[number]': VISA },
      { 'stripe-account': 'acct_nonexistent' },
    );

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource_missing');
  });

  it('works through PaymentIntents too', async () => {
    const acct = await connectedAccount();
    const intent = (
      await post(
        '/stripe/v1/payment_intents',
        {
          amount: 6_000,
          currency: 'usd',
          application_fee_amount: 600,
          confirm: 'true',
          'payment_method_data[type]': 'card',
          'payment_method_data[card][number]': VISA,
        },
        { 'stripe-account': acct },
      )
    ).json();

    expect(intent.application_fee_amount).toBe(600);
    expect(intent.on_behalf_of).toBe(acct);

    await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });
    expect(await balanceOf(acct)).toBe(5_400);
  });
});

describe('a destination charge', () => {
  it('takes the payment on the platform and forwards the share', async () => {
    const acct = await connectedAccount();
    const platformBefore = await balanceOf(null);

    const charge = (
      await post('/stripe/v1/charges', {
        amount: 9_000,
        currency: 'usd',
        application_fee_amount: 900,
        'transfer_data[destination]': acct,
        'card[number]': VISA,
      })
    ).json();

    expect(charge.transfer_data.destination).toBe(acct);
    // The platform collected 9000 and passed on 8100, keeping its 900 fee.
    expect(await balanceOf(null)).toBe(platformBefore + 900);
    expect(await balanceOf(acct)).toBe(8_100);
  });

  it('forwards as a real transfer, not a bare ledger entry', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/charges', {
      amount: 5_000,
      currency: 'usd',
      application_fee_amount: 500,
      'transfer_data[destination]': acct,
      'card[number]': VISA,
    });

    // So it shows up in the transfer list and can be reversed like any other.
    const transfers = await context.storage.transfers.list({});
    const forwarded = transfers.items.find((t) => t.destinationSubaccountId !== null);
    expect(forwarded).toMatchObject({ amount: 4_500, status: 'successful' });
    expect(forwarded?.sourcePaymentId).toBeTruthy();
  });

  it('refuses to be a direct charge as well', async () => {
    const acct = await connectedAccount();
    const response = await post(
      '/stripe/v1/charges',
      { amount: 1_000, currency: 'usd', 'transfer_data[destination]': acct, 'card[number]': VISA },
      { 'stripe-account': acct },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('not both');
  });
});

describe('application fees', () => {
  async function directCharge(amount = 10_000, fee = 2_000) {
    const acct = await connectedAccount();
    const charge = (
      await post(
        '/stripe/v1/charges',
        { amount, currency: 'usd', application_fee_amount: fee, 'card[number]': VISA },
        { 'stripe-account': acct },
      )
    ).json();
    return { acct, charge };
  }

  it('can be read back', async () => {
    const { acct, charge } = await directCharge();
    const fee = (await get(`/stripe/v1/application_fees/${charge.application_fee}`)).json();

    expect(fee).toMatchObject({
      object: 'application_fee',
      amount: 2_000,
      amount_refunded: 0,
      refunded: false,
      account: acct,
      charge: charge.id,
      currency: 'usd',
    });
  });

  it('lists only charges that carried one', async () => {
    const { acct } = await directCharge();
    // A charge with no fee must not appear.
    await post(
      '/stripe/v1/charges',
      { amount: 500, currency: 'usd', 'card[number]': VISA },
      { 'stripe-account': acct },
    );

    const fees = (await get('/stripe/v1/application_fees')).json();
    expect(fees.data).toHaveLength(1);
    expect(fees.data[0].amount).toBe(2_000);
  });

  it('refunds in part, moving the money back to the account', async () => {
    const { acct, charge } = await directCharge();
    const before = await balanceOf(acct);

    const refund = (
      await post(`/stripe/v1/application_fees/${charge.application_fee}/refunds`, { amount: 500 })
    ).json();

    expect(refund).toMatchObject({ object: 'fee_refund', amount: 500, currency: 'usd' });
    expect(await balanceOf(acct)).toBe(before + 500);
    expect(await balanceOf(null)).toBe(float + 1_500);
  });

  it('refunds the whole fee by default', async () => {
    const { charge } = await directCharge();
    await post(`/stripe/v1/application_fees/${charge.application_fee}/refunds`);

    const fee = (await get(`/stripe/v1/application_fees/${charge.application_fee}`)).json();
    expect(fee.amount_refunded).toBe(2_000);
    expect(fee.refunded).toBe(true);
    expect(await balanceOf(null)).toBe(float);
  });

  it('refuses to refund more than was taken', async () => {
    const { charge } = await directCharge();
    await post(`/stripe/v1/application_fees/${charge.application_fee}/refunds`, { amount: 1_800 });
    const again = await post(`/stripe/v1/application_fees/${charge.application_fee}/refunds`, {
      amount: 500,
    });

    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('exceeds the 200 still refundable');
  });

  it('404s for a charge that carried no fee', async () => {
    const acct = await connectedAccount();
    const charge = (
      await post(
        '/stripe/v1/charges',
        { amount: 700, currency: 'usd', 'card[number]': VISA },
        { 'stripe-account': acct },
      )
    ).json();

    const response = await get(`/stripe/v1/application_fees/${charge.id.replace('ch_', 'fee_')}`);
    expect(response.statusCode).toBe(404);
  });
});

describe('refunding a direct charge', () => {
  it('comes out of the connected account, not the platform', async () => {
    const acct = await connectedAccount();
    const charge = (
      await post(
        '/stripe/v1/charges',
        { amount: 10_000, currency: 'usd', application_fee_amount: 1_000, 'card[number]': VISA },
        { 'stripe-account': acct },
      )
    ).json();

    await post('/stripe/v1/refunds', { charge: charge.id, amount: 4_000 });

    expect(await balanceOf(acct)).toBe(5_000);
    // The platform keeps its fee: refunding a customer does not oblige it to.
    expect(await balanceOf(null)).toBe(float + 1_000);
  });

  it('can push a connected account negative, as it really does', async () => {
    const acct = await connectedAccount();
    const charge = (
      await post(
        '/stripe/v1/charges',
        { amount: 1_000, currency: 'usd', application_fee_amount: 300, 'card[number]': VISA },
        { 'stripe-account': acct },
      )
    ).json();

    // The account received 700 but owes the full 1000 back.
    await post('/stripe/v1/refunds', { charge: charge.id });

    expect(await balanceOf(acct)).toBe(-300);
  });
});

describe('GET /v1/balance', () => {
  it('reports the platform balance by default', async () => {
    const balance = (await get('/stripe/v1/balance')).json();
    expect(balance.object).toBe('balance');
    expect(balance.available[0].currency).toBe('usd');
    expect(balance.available[0].amount).toBe(float);
    expect(balance.pending).toEqual([{ amount: 0, currency: 'usd', source_types: { card: 0 } }]);
  });

  it('reports the connected account balance under Stripe-Account', async () => {
    const acct = await connectedAccount();
    await post(
      '/stripe/v1/charges',
      { amount: 7_000, currency: 'usd', application_fee_amount: 700, 'card[number]': VISA },
      { 'stripe-account': acct },
    );

    const scoped = (await get('/stripe/v1/balance', { 'stripe-account': acct })).json();
    expect(scoped.available).toEqual([
      { amount: 6_300, currency: 'usd', source_types: { card: 6_300 } },
    ]);
  });

  it('starts a connected account at zero, with no opening float', async () => {
    const acct = await connectedAccount();
    const scoped = (await get('/stripe/v1/balance', { 'stripe-account': acct })).json();

    // The test float belongs to the platform. Handing every connected account
    // one would let a marketplace pay out money nobody paid in.
    expect(scoped.available[0].amount).toBe(0);
  });
});

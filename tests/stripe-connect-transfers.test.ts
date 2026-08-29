import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Connect: transfers between balances, reversals and payouts.
 *
 * Shapes verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28); event names against the same spec's
 * webhook list.
 *
 * Stripe has two words for money leaving a balance -- Transfer (to a connected
 * account) and Payout (to a bank) -- and paybox has one mechanism, because
 * they are the same shape of problem. These pin that the two still behave as
 * two distinct objects at the API boundary.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;
let float: number;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-02-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'connect-transfers';
  transport = new RecordingTransport();
  const { config } = loadConfig();
  context = await buildContext({ config, transport, logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
  float = await context.engine.getBalance('stripe', 'USD', null);
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

function form(fields: Record<string, string | number> = {}): string {
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
const canonical = (id: string) => id.replace(/^acct_/, 'sac_');

const balanceOf = (accountId: string | null, currency = 'USD') =>
  context.engine.getBalance('stripe', currency, accountId ? canonical(accountId) : null);

async function connectedAccount(onboarded = true) {
  const created = (
    await post('/stripe/v1/accounts', {
      type: 'express',
      country: 'US',
      email: 'seller@example.com',
      default_currency: 'usd',
    })
  ).json();
  if (!onboarded) return created.id as string;

  const link = (await post('/stripe/v1/account_links', { account: created.id })).json();
  await app.inject({
    method: 'POST',
    url: `${new URL(link.url).pathname}/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'outcome=complete',
  });
  return created.id as string;
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

describe('POST /v1/transfers', () => {
  it('moves money from the platform to a connected account', async () => {
    const acct = await connectedAccount();
    const transfer = (
      await post('/stripe/v1/transfers', {
        amount: 3_000,
        currency: 'usd',
        destination: acct,
      })
    ).json();

    expect(transfer).toMatchObject({
      object: 'transfer',
      amount: 3_000,
      amount_reversed: 0,
      reversed: false,
      destination: acct,
      currency: 'usd',
    });
    expect(transfer.id).toMatch(/^tr_/);

    // Two entries, one movement: the pair always balances.
    expect(await balanceOf(acct)).toBe(3_000);
    expect(await balanceOf(null)).toBe(float - 3_000);
  });

  it('refuses more than the platform holds', async () => {
    const acct = await connectedAccount();
    const response = await post('/stripe/v1/transfers', {
      amount: float + 1,
      currency: 'usd',
      destination: acct,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('exceeds the');
    expect(await balanceOf(acct)).toBe(0);
  });

  it('refuses an account that cannot receive payouts yet', async () => {
    const pending = await connectedAccount(false);
    const response = await post('/stripe/v1/transfers', {
      amount: 100,
      currency: 'usd',
      destination: pending,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('onboarding is incomplete');
  });

  it('ties a transfer to the charge that funded it', async () => {
    const acct = await connectedAccount();
    const charge = (
      await post('/stripe/v1/charges', { amount: 5_000, currency: 'usd', 'card[number]': VISA })
    ).json();

    const transfer = (
      await post('/stripe/v1/transfers', {
        amount: 4_000,
        currency: 'usd',
        destination: acct,
        source_transaction: charge.id,
        transfer_group: 'ORDER-99',
      })
    ).json();

    expect(transfer.source_transaction).toBe(charge.id);
    expect(transfer.transfer_group).toBe('ORDER-99');
  });

  it('lists transfers but not payouts', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/transfers', { amount: 1_000, currency: 'usd', destination: acct });
    await post('/stripe/v1/payouts', { amount: 500, currency: 'usd' });

    const listed = (await get('/stripe/v1/transfers')).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].object).toBe('transfer');
  });

  it('404s when asked for a payout by transfer id', async () => {
    const payout = (await post('/stripe/v1/payouts', { amount: 500, currency: 'usd' })).json();
    const response = await get(`/stripe/v1/transfers/${payout.id.replace('po_', 'tr_')}`);
    expect(response.statusCode).toBe(404);
  });
});

describe('reversing a transfer', () => {
  async function transferred(amount = 4_000) {
    const acct = await connectedAccount();
    const transfer = (
      await post('/stripe/v1/transfers', { amount, currency: 'usd', destination: acct })
    ).json();
    return { acct, transfer };
  }

  it('sends part of it back', async () => {
    const { acct, transfer } = await transferred();
    const reversal = (
      await post(`/stripe/v1/transfers/${transfer.id}/reversals`, { amount: 1_500 })
    ).json();

    expect(reversal).toMatchObject({
      object: 'transfer_reversal',
      amount: 1_500,
      transfer: transfer.id,
    });
    expect(await balanceOf(acct)).toBe(2_500);
    expect(await balanceOf(null)).toBe(float - 2_500);
  });

  it('sends all of it back by default and marks it reversed', async () => {
    const { acct, transfer } = await transferred();
    await post(`/stripe/v1/transfers/${transfer.id}/reversals`);

    const read = (await get(`/stripe/v1/transfers/${transfer.id}`)).json();
    expect(read.amount_reversed).toBe(4_000);
    expect(read.reversed).toBe(true);
    expect(await balanceOf(acct)).toBe(0);
    expect(await balanceOf(null)).toBe(float);
  });

  it('refuses to reverse more than was sent', async () => {
    const { transfer } = await transferred();
    await post(`/stripe/v1/transfers/${transfer.id}/reversals`, { amount: 3_500 });
    const again = await post(`/stripe/v1/transfers/${transfer.id}/reversals`, { amount: 1_000 });

    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('still reversible');
  });

  it('refuses when the account has already spent it', async () => {
    const { acct, transfer } = await transferred(2_000);
    // The account pays itself out, so the money is gone.
    await post('/stripe/v1/payouts', { amount: 2_000, currency: 'usd' }, { 'stripe-account': acct });

    const response = await post(`/stripe/v1/transfers/${transfer.id}/reversals`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('exceeds the destination balance');
  });

  it('cannot reverse a payout, because money at a bank is gone', async () => {
    const payout = (await post('/stripe/v1/payouts', { amount: 500, currency: 'usd' })).json();
    const response = await post(`/stripe/v1/transfers/${payout.id}/reversals`);
    expect(response.statusCode).toBe(404);
  });

  it('gives the platform fee back with refund_application_fee', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/charges', {
      amount: 10_000,
      currency: 'usd',
      application_fee_amount: 1_000,
      'transfer_data[destination]': acct,
      'card[number]': VISA,
    });

    const transfers = (await get('/stripe/v1/transfers')).json();
    const forwarded = transfers.data[0];
    expect(forwarded.amount).toBe(9_000);

    await post(`/stripe/v1/transfers/${forwarded.id}/reversals`, {
      refund_application_fee: 'true',
    });

    // Everything comes back: the 9000 forwarded and the 1000 fee.
    expect(await balanceOf(acct)).toBe(0);
    expect(await balanceOf(null)).toBe(float + 10_000);
  });
});

describe('payouts', () => {
  it('take money out of the platform balance', async () => {
    const payout = (
      await post('/stripe/v1/payouts', { amount: 2_500, currency: 'usd', description: 'Weekly' })
    ).json();

    expect(payout).toMatchObject({
      object: 'payout',
      amount: 2_500,
      currency: 'usd',
      status: 'pending',
      description: 'Weekly',
      method: 'standard',
    });
    expect(payout.id).toMatch(/^po_/);
    // Reserved at once, so a second payout cannot spend the same money.
    expect(await balanceOf(null)).toBe(float - 2_500);
  });

  it('take money out of a connected account under Stripe-Account', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/transfers', { amount: 6_000, currency: 'usd', destination: acct });

    const payout = (
      await post('/stripe/v1/payouts', { amount: 4_000, currency: 'usd' }, { 'stripe-account': acct })
    ).json();

    expect(payout.status).toBe('pending');
    expect(await balanceOf(acct)).toBe(2_000);
    // The platform's balance is untouched by the account's own payout.
    expect(await balanceOf(null)).toBe(float - 6_000);
  });

  it('refuse more than that account holds', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/transfers', { amount: 1_000, currency: 'usd', destination: acct });

    const response = await post(
      '/stripe/v1/payouts',
      { amount: 5_000, currency: 'usd' },
      { 'stripe-account': acct },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('exceeds the');
    expect(await balanceOf(acct)).toBe(1_000);
  });

  it('refuse for an account that has not onboarded', async () => {
    const pending = await connectedAccount(false);
    const response = await post(
      '/stripe/v1/payouts',
      { amount: 100, currency: 'usd' },
      { 'stripe-account': pending },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('onboarding is incomplete');
  });

  it('can be cancelled while still pending, releasing the money', async () => {
    const payout = (await post('/stripe/v1/payouts', { amount: 3_000, currency: 'usd' })).json();
    expect(await balanceOf(null)).toBe(float - 3_000);

    const cancelled = (await post(`/stripe/v1/payouts/${payout.id}/cancel`)).json();

    expect(cancelled.status).toBe('canceled');
    expect(await balanceOf(null)).toBe(float);
  });

  it('cannot be cancelled once on its way', async () => {
    const payout = (await post('/stripe/v1/payouts', { amount: 1_000, currency: 'usd' })).json();
    await context.engine.transitionTransfer(payout.id.replace('po_', 'trf_'), 'processing');

    const response = await post(`/stripe/v1/payouts/${payout.id}/cancel`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('no longer be canceled');
  });

  it('report the Stripe status vocabulary', async () => {
    const payout = (await post('/stripe/v1/payouts', { amount: 1_000, currency: 'usd' })).json();
    const id = payout.id.replace('po_', 'trf_');

    await context.engine.transitionTransfer(id, 'processing');
    expect((await get(`/stripe/v1/payouts/${payout.id}`)).json().status).toBe('in_transit');

    await context.engine.transitionTransfer(id, 'successful');
    expect((await get(`/stripe/v1/payouts/${payout.id}`)).json().status).toBe('paid');
  });

  it('list only the acting account own payouts', async () => {
    const acct = await connectedAccount();
    await post('/stripe/v1/transfers', { amount: 2_000, currency: 'usd', destination: acct });
    await post('/stripe/v1/payouts', { amount: 500, currency: 'usd' });
    await post('/stripe/v1/payouts', { amount: 700, currency: 'usd' }, { 'stripe-account': acct });

    expect((await get('/stripe/v1/payouts')).json().data).toHaveLength(1);
    const scoped = (await get('/stripe/v1/payouts', { 'stripe-account': acct })).json();
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0].amount).toBe(700);
  });
});

describe('webhooks', () => {
  it('tell a transfer and a payout apart', async () => {
    await endpoint();
    const acct = await connectedAccount();
    await post('/stripe/v1/transfers', { amount: 1_000, currency: 'usd', destination: acct });
    await post('/stripe/v1/payouts', { amount: 500, currency: 'usd' });

    const types = await deliveredTypes();
    expect(types).toContain('transfer.created');
    expect(types).toContain('payout.created');
    // One canonical resource, but an endpoint subscribed to payouts must not
    // receive transfer events and vice versa.
    const transfers = types.filter((t) => t.startsWith('transfer.'));
    const payouts = types.filter((t) => t.startsWith('payout.'));
    expect(transfers).toEqual(['transfer.created']);
    expect(payouts).toEqual(['payout.created']);
  });

  it('report a cancelled payout', async () => {
    await endpoint();
    const payout = (await post('/stripe/v1/payouts', { amount: 400, currency: 'usd' })).json();
    await post(`/stripe/v1/payouts/${payout.id}/cancel`);

    expect(await deliveredTypes()).toContain('payout.canceled');
  });

  it('report a reversal', async () => {
    await endpoint();
    const acct = await connectedAccount();
    const transfer = (
      await post('/stripe/v1/transfers', { amount: 800, currency: 'usd', destination: acct })
    ).json();
    await post(`/stripe/v1/transfers/${transfer.id}/reversals`);

    expect(await deliveredTypes()).toContain('transfer.reversed');
  });
});

describe('Paystack transfers are unaffected', () => {
  it('still come out of the platform balance', async () => {
    const before = await context.engine.getBalance('paystack', 'NGN', null);
    const recipient = await app.inject({
      method: 'POST',
      url: '/paystack/transferrecipient',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { type: 'nuban', name: 'Ada', account_number: '0123456789', bank_code: '058' },
    });
    const code = recipient.json().data.recipient_code;

    await app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { source: 'balance', amount: 50_000, recipient: code },
    });

    expect(await context.engine.getBalance('paystack', 'NGN', null)).toBeLessThan(before);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs money out through the HTTP surface: settlement into held balances,
 * payout destinations, quotes, payouts, conversions, schedules, the virtual
 * account and the reference lists.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document, guides/payouts/*,
 * connect/{payouts, testing, balances}, for-you/{fees, supported-currencies},
 * guides/virtual-accounts/overview and the payout and conversion event pages.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;
const OPENING = 10_000_000; // the default opening float, per held currency

beforeEach(async () => {
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
  delete process.env.PAYBOX_OPENING_BALANCE;
});

const cents = (decimal: string) => Math.round(Number(decimal) * 100);

async function balances() {
  const response = await api.get('/v1/balances');
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    balances: Array<{ currency: string; available_balance: string; pending_balance: string }>;
    total_balance_usd: string;
  };
}
const available = async (currency: string) =>
  cents((await balances()).balances.find((entry) => entry.currency === currency)?.available_balance ?? 'NaN');

/** A GHS mobile-money collection of `amount`, paid through the hosted page. */
async function collectGhs(amount: string) {
  const session = await api.checkout({ pricing: { currency: 'GHS', amount }, customer: { email: 'ama@example.com' } });
  await api.pagePost(`${session.path}/pay`, { corridor: 'MOMO_GHS', phone_number: '+233241234567', provider: 'MTN' });
  await api.pagePost(`${session.path}/simulate`, { action: 'succeed' });
  await api.advance('1s');
  return session;
}

async function destination(body: Record<string, unknown>) {
  const response = await api.post('/v1/payouts/destinations', body);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, any>;
}

const ngnBank = (accountNumber = '0001112223', bankCode = '999') =>
  destination({ currency: 'NGN', name: 'Payouts', bank_code: bankCode, account_number: accountNumber });

describe('balances held in USD and NGN', () => {
  it('settles a GHS collection into USD at the fixed rate, and shows no GHS balance', async () => {
    const before = await available('USD');
    await collectGhs('150.00');
    const after = await balances();
    expect(after.balances.map((entry) => entry.currency)).toEqual(['NGN', 'USD']);
    // GHS 150.00 less the 3.5% fee is GHS 144.75, $9.65 at 15 to the dollar
    // (the sandbox settles at once).
    expect(await available('USD')).toBe(before + 965);
    const [succeeded] = await sent(env, 'collection.succeeded');
    // The fee is 3.5% of GHS 150.00 = GHS 5.25; the rest settles as USD.
    expect(succeeded?.data).toMatchObject({ processing_fee: '5.25', settlement_currency: 'USD', settlement_amount: '9.65' });
  });

  it("settles a GHS refund back out of USD, whichever path made it", async () => {
    const session = await collectGhs('150.00');
    const charge = (await api.get(`/v1/checkout-sessions/${session.id}`)).json().charge.payment_id;
    const settled = await available('USD');
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', charge);
    // paybox's own refund, not Bachs' route.
    const refunded = await env.app.inject({ method: 'POST', url: `/api/payments/${payment!.id}/refund`, payload: {} });
    expect(refunded.statusCode, refunded.body).toBeLessThan(300);
    // The full GHS 150.00 goes back; the fee does not.
    expect(await available('USD')).toBe(settled - 1000);
    expect((await balances()).balances.map((entry) => entry.currency)).toEqual(['NGN', 'USD']);
  });

  it('reports money no sweep has moved yet, without writing anything', async () => {
    const before = await available('USD');
    // As a crash between a charge and its sweep would leave it.
    await env.context.engine.creditBalance({ provider: 'bachs', currency: 'KES', amount: 130_000, reason: 'charge' });
    const ledger = (await env.context.storage.ledger.list({ provider: 'bachs', limit: 100, offset: 0 })).items.length;
    expect(await available('USD')).toBe(before + 1000);
    expect((await env.context.storage.ledger.list({ provider: 'bachs', limit: 100, offset: 0 })).items.length).toBe(ledger);
  });

  it('lists both held balances, and counts NGN in total_balance_usd', async () => {
    expect((await balances()).balances.map((entry) => entry.currency)).toEqual(['NGN', 'USD']);
    const account = (await api.post('/v1/virtual-accounts', { currency: 'NGN' })).json();
    await api.post(`/v1/virtual-accounts/${account.id}/deposits`, { amount: '150000.00' });
    const now = await balances();
    expect(now.balances.map((entry) => entry.currency)).toEqual(['NGN', 'USD']);
    const ngn = cents(now.balances[0]!.available_balance);
    const usd = cents(now.balances[1]!.available_balance);
    expect(cents(now.total_balance_usd)).toBe(usd + Math.round(ngn / 1500));
  });
});

describe('payout destinations', () => {
  it('approves at once, resolves an NGN name, and makes the first one the default', async () => {
    const first = await ngnBank('0123456789', '058');
    expect(first).toMatchObject({
      type: 'bank_account',
      currency: 'NGN',
      status: 'approved',
      is_usable: true,
      is_default: true,
      bank_name: 'Guaranty Trust Bank',
    });
    expect(first.id).toMatch(/^pd_[0-9a-f]{16}$/);
    expect(first.account_name).toMatch(/^[A-Z]+ [A-Z]+$/);
    const second = await ngnBank();
    expect(second.is_default).toBe(false);

    const promoted = await api.patch(`/v1/payouts/destinations/${second.id}`, { is_default: true });
    expect(promoted.json().is_default).toBe(true);
    expect((await api.get(`/v1/payouts/destinations/${first.id}`)).json().is_default).toBe(false);

    const list = (await api.get('/v1/payouts/destinations?currency=NGN')).json();
    expect(list).toMatchObject({ total: 2, limit: 20, offset: 0 });
    expect(list.destinations.map((entry: { id: string }) => entry.id)).toEqual([second.id, first.id]);
  });

  it('infers the type where it can and refuses what it cannot route', async () => {
    const expectError = async (body: Record<string, unknown>, code: string) => {
      const response = await api.post('/v1/payouts/destinations', body);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error_code).toBe(code);
    };
    await expectError({ currency: 'GHS', phone_number: '233240000000', mobile_provider: 'MTN' }, 'DESTINATION_TYPE_REQUIRED');
    await expectError({ currency: 'JPY', type: 'bank_account' }, 'CURRENCY_NOT_SUPPORTED');
    await expectError({ currency: 'GBP', account_name: 'Jo', bank_name: 'Lloyds', sort_code: '12-34', account_number: '1' }, 'BANK_ROUTING_DETAILS_INVALID');
    const momo = await destination({ currency: 'GHS', type: 'mobile_money', phone_number: '233240000000', mobile_provider: 'MTN' });
    expect(momo.type).toBe('mobile_money');
    const wallet = await destination({ currency: 'USDT_TRC20', wallet_address: '0x1111111111111111111111111111111111111111' });
    expect(wallet).toMatchObject({ type: 'crypto_wallet', network: 'TRC20' });
  });

  it('deactivates on DELETE: still readable, unusable, and gone for payouts', async () => {
    const pd = await ngnBank();
    const removed = await api.del(`/v1/payouts/destinations/${pd.id}`);
    expect(removed.json()).toEqual({ id: pd.id, deleted: true });
    expect((await api.get(`/v1/payouts/destinations/${pd.id}`)).json()).toMatchObject({ is_usable: false, is_default: false });
    expect((await api.del(`/v1/payouts/destinations/${pd.id}`)).statusCode).toBe(404);
    const payout = await api.post('/v1/payouts', { destination: pd.id, amount: '5000.00' });
    expect(payout.statusCode).toBe(404);
    expect(payout.json().error_code).toBe('DESTINATION_NOT_FOUND');
  });
});

describe('payouts', () => {
  it('debits amount and fee at once, then completes a second and a second later', async () => {
    const pd = await ngnBank();
    // NGN is listed once it has moved; until then it is the opening float.
    const before = OPENING;
    const created = await api.post('/v1/payouts', { destination: pd.id, amount: '5000.00', reference: 'payout-001' });
    expect(created.statusCode, created.body).toBe(200);
    const payout = created.json();
    expect(payout).toMatchObject({
      status: 'pending',
      amount: '5000.00',
      currency: 'NGN',
      source_currency: 'NGN',
      fee: '50.00',
      total_debited: '5050.00',
      destination: pd.id,
      reference: 'payout-001',
      failure_reason: null,
      completed_at: null,
    });
    expect(payout.id).toMatch(/^pay_[0-9a-f]{16}$/);
    expect(await available('NGN')).toBe(before - 505_000);

    await api.advance('1s');
    expect((await api.get(`/v1/payouts/${payout.id}`)).json().status).toBe('processing');
    await api.advance('1s');
    expect((await api.get(`/v1/payouts/${payout.id}`)).json()).toMatchObject({ status: 'completed', completed_at: '2026-06-14T12:00:02.000Z' });

    expect((await sent(env, 'payout.created'))[0]?.data).toEqual({
      withdrawal_id: payout.id,
      reference: 'payout-001',
      status: 'pending',
      amount: '5050.00',
      currency: 'NGN',
      from_currency: 'NGN',
      to_currency: 'NGN',
      exchange_rate: null,
      to_amount: '5000.00',
      withdrawal_fee: '50.00',
      net_from_amount: '5000.00',
    });
    expect((await sent(env, 'payout.paid'))[0]?.data.status).toBe('completed');

    const dup = await api.post('/v1/payouts', { destination: pd.id, amount: '10.00', reference: 'payout-001' });
    expect(dup.statusCode).toBe(409);
  });

  it("fails at Bachs' failing test account and gives everything back", async () => {
    const pd = await ngnBank('0001112224', '998');
    const before = OPENING;
    const payout = (await api.post('/v1/payouts', { destination: pd.id, amount: '5000.00' })).json();
    await api.advance('2s');
    expect((await api.get(`/v1/payouts/${payout.id}`)).json()).toMatchObject({
      status: 'failed',
      failure_reason: 'The destination bank rejected the payout.',
    });
    expect(await available('NGN')).toBe(before);
    expect((await sent(env, 'payout.failed'))[0]?.data).not.toHaveProperty('failure_reason');
  });

  it('pays out cross-currency through a single-use 30-second quote, the fee taken before converting', async () => {
    const pd = await destination({ currency: 'GHS', type: 'mobile_money', phone_number: '233240000000', mobile_provider: 'MTN' });
    const quote = (
      await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '100.00', payout_method: 'MOBILE_MONEY' })
    ).json();
    // A $1.00 fee (1%, minimum $1) leaves $99.00, at 15 GHS to the dollar.
    expect(quote).toMatchObject({ from_amount: '100.00', to_amount: '1485.00', exchange_rate: '15.00', expires_at: '2026-06-14T12:00:30.000Z' });
    const before = await available('USD');
    const payout = await api.post('/v1/payouts', { destination: pd.id, quote_id: quote.quote_id });
    expect(payout.json()).toMatchObject({ amount: '1485.00', currency: 'GHS', source_currency: 'USD', fee: '1.00', total_debited: '100.00' });
    expect(await available('USD')).toBe(before - 10_000);

    const again = await api.post('/v1/payouts', { destination: pd.id, quote_id: quote.quote_id });
    expect(again.json().error_code).toBe('QUOTE_NOT_FOUND');
    const stale = (
      await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '20.00', payout_method: 'MOBILE_MONEY' })
    ).json();
    await api.advance('31s');
    expect((await api.post('/v1/payouts', { destination: pd.id, quote_id: stale.quote_id })).json().error_code).toBe('QUOTE_EXPIRED');
  });

  it('refuses the payout shapes Bachs refuses', async () => {
    const ghs = await destination({ currency: 'GHS', type: 'mobile_money', phone_number: '233240000000', mobile_provider: 'MTN' });
    const usd = await destination({
      currency: 'USD',
      scheme: 'ach',
      account_name: 'Jo Doe',
      bank_name: 'Chase',
      routing_number: '021000021',
      account_number: '123456789',
      bank_address: { line1: '1 Main St', city: 'New York', country: 'US' },
    });
    const kes = (await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'KES', amount: '50.00' })).json();
    const expectError = async (body: Record<string, unknown>, code: string) => {
      const response = await api.post('/v1/payouts', body);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error_code).toBe(code);
    };
    await expectError({ destination: ghs.id, amount: '50.00' }, 'QUOTE_REQUIRED');
    await expectError({ destination: usd.id }, 'AMOUNT_REQUIRED');
    await expectError({ destination: usd.id, quote_id: kes.quote_id }, 'QUOTE_NOT_APPLICABLE');
    await expectError({ destination: ghs.id, quote_id: kes.quote_id }, 'QUOTE_DESTINATION_MISMATCH');
    await expectError({ destination: ghs.id, quote_id: kes.quote_id, amount: '1.00' }, 'AMOUNT_NOT_ALLOWED_WITH_QUOTE');
    await expectError({ destination: usd.id, amount: '999999999.00' }, 'INSUFFICIENT_BALANCE');
    const ngnQuote = await api.post('/v1/payouts/quotes', { from_currency: 'NGN', to_currency: 'GHS', amount: '5000.00' });
    expect(ngnQuote.json().error_code).toBe('PAYOUT_SOURCE_CURRENCY_UNSUPPORTED');
  });

  it('sends stablecoins one to one from USD, fee on top, and fails at the failing wallet', async () => {
    const good = await destination({ currency: 'USDT_TRC20', wallet_address: '0x1111111111111111111111111111111111111111' });
    const bad = await destination({ currency: 'USDT_TRC20', wallet_address: '0x2222222222222222222222222222222222222222' });
    // "$80 as USDT: fee $1 (the minimum), so $80.00 is converted and sent and $81.00 is debited."
    const ok = (await api.post('/v1/payouts', { destination: good.id, amount: '80.00' })).json();
    expect(ok).toMatchObject({ amount: '80.00', currency: 'USDT_TRC20', source_currency: 'USD', fee: '1.00', total_debited: '81.00' });
    const failing = (await api.post('/v1/payouts', { destination: bad.id, amount: '10.00' })).json();
    await api.advance('2s');
    expect((await api.get(`/v1/payouts/${ok.id}`)).json().status).toBe('completed');
    expect((await api.get(`/v1/payouts/${failing.id}`)).json().status).toBe('failed');
  });

  it('lets only one of two payouts racing for the last of a balance through', async () => {
    await env.close();
    process.env.PAYBOX_OPENING_BALANCE = '10000';
    env = await startBachs();
    api = client(env);
    const pd = await ngnBank();
    // NGN 100.00 opening float; each payout is 60.00 + 50.00 fee.
    const [a, b] = await Promise.all([
      api.post('/v1/payouts', { destination: pd.id, amount: '50.00' }),
      api.post('/v1/payouts', { destination: pd.id, amount: '50.00' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect(await available('NGN')).toBe(0);
  });

  it('lists newest first with a status filter, and serves the reference lists', async () => {
    const pd = await ngnBank();
    const first = (await api.post('/v1/payouts', { destination: pd.id, amount: '10.00' })).json();
    await api.advance('2s');
    const second = (await api.post('/v1/payouts', { destination: pd.id, amount: '20.00' })).json();
    const all = (await api.get('/v1/payouts')).json();
    expect(all.items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    expect(all.total).toBe(2);
    expect((await api.get('/v1/payouts?status_filter=completed')).json().items.map((item: { id: string }) => item.id)).toEqual([first.id]);

    expect((await api.get('/v1/currencies/payout-supported')).json()).toMatchObject({ fiat: expect.arrayContaining(['NGN', 'USD', 'GHS']) });
    const banks = (await api.get('/v1/reference/banks?country=NG')).json();
    expect(banks.banks).toEqual(expect.arrayContaining([{ name: 'Sandbox Test Bank (payouts complete)', code: '999' }]));
    expect((await api.get('/v1/payouts/mobile-money-providers?country_code=GH')).json().providers).toContainEqual({ name: 'MTN', country: 'GH' });
    expect((await api.get('/v1/reference/momo?country=KE')).json().providers).toContainEqual({ name: 'SAFARICOM', country: 'KE' });
    const resolved = (await api.post('/v1/misc/bank-accounts/resolve', { account_number: '0123456789', bank_code: '058' })).json();
    expect(resolved).toMatchObject({ resolved: true, account_number: '0123456789', message: null });
    const unresolved = await api.post('/v1/misc/bank-accounts/resolve', { account_number: '12', bank_code: '058' });
    expect(unresolved.statusCode).toBe(200);
    expect(unresolved.json().resolved).toBe(false);
  });
});

describe('conversions', () => {
  it('quotes and converts USD to NGN and back, synchronously, with conversion.completed', async () => {
    const usd = await available('USD');
    const quote = (await api.post('/v1/conversions/quotes', { from_currency: 'USD', to_currency: 'NGN', amount: '10.00' })).json();
    expect(quote).toMatchObject({ from_amount: '10.00', to_amount: '15000.00', exchange_rate: '1500.00' });
    expect(quote.quote_id).toMatch(/^cqt_/);
    const conversion = await api.post('/v1/conversions', { from_currency: 'USD', to_currency: 'NGN', amount: '10.00', quote_id: quote.quote_id });
    expect(conversion.statusCode, conversion.body).toBe(201);
    expect(conversion.json()).toMatchObject({ status: 'completed', from_amount: '10.00', to_amount: '15000.00', quote_id: quote.quote_id });
    expect(await available('USD')).toBe(usd - 1000);
    expect(await available('NGN')).toBe(OPENING + 1_500_000);
    expect((await sent(env, 'conversion.completed'))[0]?.data).toMatchObject({ conversion_id: conversion.json().conversion_id, to_amount: '15000.00' });

    const back = (await api.post('/v1/conversions/quotes', { from_currency: 'NGN', to_currency: 'USD', amount: '15000.00' })).json();
    expect(back).toMatchObject({ to_amount: '10.00', exchange_rate: '0.000667' });
    await api.post('/v1/conversions', { from_currency: 'NGN', to_currency: 'USD', amount: '15000.00', quote_id: back.quote_id });
    expect(await available('USD')).toBe(usd);

    const list = (await api.get('/v1/conversions')).json();
    expect(list).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect((await api.get(`/v1/conversions/${conversion.json().conversion_id}`)).json().status).toBe('completed');
  });

  it('refuses a used, mismatched, unfunded or non-settlement conversion', async () => {
    const quote = (await api.post('/v1/conversions/quotes', { from_currency: 'USD', to_currency: 'NGN', amount: '10.00' })).json();
    const mismatch = await api.post('/v1/conversions', { from_currency: 'USD', to_currency: 'NGN', amount: '11.00', quote_id: quote.quote_id });
    expect(mismatch.json().error_code).toBe('QUOTE_ERROR');
    await api.post('/v1/conversions', { from_currency: 'USD', to_currency: 'NGN', amount: '10.00', quote_id: quote.quote_id });
    const reused = await api.post('/v1/conversions', { from_currency: 'USD', to_currency: 'NGN', amount: '10.00', quote_id: quote.quote_id });
    expect(reused.json().error_code).toBe('QUOTE_NOT_FOUND');
    const big = (await api.post('/v1/conversions/quotes', { from_currency: 'USD', to_currency: 'NGN', amount: '999999.00' })).json();
    const unfunded = await api.post('/v1/conversions', { from_currency: 'USD', to_currency: 'NGN', amount: '999999.00', quote_id: big.quote_id });
    expect(unfunded.json().error_code).toBe('INSUFFICIENT_BALANCE');
    expect((await api.post('/v1/conversions/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '1.00' })).json().error_code).toBe('QUOTE_ERROR');
  });
});

describe('payout schedules', () => {
  it('stores a schedule per currency, keeps the others, and validates what Bachs validates', async () => {
    let response = await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'daily', anchor_hour_utc: 9 } } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().schedule_by_currency.NGN).toMatchObject({
      currency: 'NGN',
      payout_currency: 'NGN',
      interval: 'daily',
      anchor_hour_utc: 9,
      next_run_at: '2026-06-15T09:00:00.000Z',
      weekly_payout_days: null,
    });
    // "Days 29, 30 and 31 land on the last day of a shorter month."
    response = await api.post('/v1/balance_settings', { schedule_by_currency: { USD: { interval: 'monthly', monthly_payout_days: [31] } } });
    expect(response.json().schedule_by_currency).toMatchObject({
      NGN: { interval: 'daily' },
      USD: { next_run_at: '2026-06-30T10:00:00.000Z', monthly_payout_days: [31], anchor_hour_utc: 10 },
    });
    const instant = (await api.post('/v1/balance_settings', { schedule_by_currency: { USD: { interval: 'instant' } } })).json();
    expect(instant.schedule_by_currency.USD).toMatchObject({ anchor_hour_utc: null, next_run_at: null });

    const expect400 = async (body: Record<string, unknown>) => {
      const bad = await api.post('/v1/balance_settings', { schedule_by_currency: body });
      expect(bad.statusCode, bad.body).toBe(400);
    };
    await expect400({ NGN: { interval: 'daily', weekly_payout_days: ['monday'] } });
    await expect400({ NGN: { interval: 'weekly', cadence: 'weekly' } });
    await expect400({ GHS: { interval: 'daily' } });
    await expect400({ NGN: { interval: 'daily', payout_currency: 'USD' } });
  });

  it('pays settled collections out on schedule, with an auto_ reference', async () => {
    const pd = await ngnBank();
    const account = (await api.post('/v1/virtual-accounts', { currency: 'NGN' })).json();
    await api.post(`/v1/virtual-accounts/${account.id}/deposits`, { amount: '20000.00' });
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'daily' } } });
    await api.advance('1d');
    const payouts = (await api.get('/v1/payouts')).json().items;
    expect(payouts).toHaveLength(1);
    // NGN 20,000 less the 1% virtual-account fee.
    expect(payouts[0]).toMatchObject({ amount: '19800.00', currency: 'NGN', destination: pd.id, status: 'completed' });
    expect(payouts[0].reference).toMatch(/^auto_/);
    const schedule = (await api.get('/v1/balance_settings')).json().schedule_by_currency.NGN;
    expect(schedule).toMatchObject({ last_withdrawal_id: payouts[0].id, last_run_at: '2026-06-15T10:00:00.000Z' });
    // Taken once: the next run has nothing new to pay.
    await api.advance('1d');
    expect((await api.get('/v1/payouts')).json().items).toHaveLength(1);
  });

  it('returns to manual after three runs that cannot pay', async () => {
    // Money to pay, and nowhere to pay it: an empty run is not a failure.
    const account = (await api.post('/v1/virtual-accounts', { currency: 'NGN' })).json();
    await api.post(`/v1/virtual-accounts/${account.id}/deposits`, { amount: '20000.00' });
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'daily' } } });
    await api.advance('3d');
    expect((await api.get('/v1/balance_settings')).json().schedule_by_currency.NGN).toMatchObject({
      interval: 'manual',
      next_run_at: null,
      disabled_reason: 'Auto-payout paused after 3 consecutive failures. Last error: no approved default destination for NGN',
    });
  });
});

describe('the virtual account', () => {
  it('is created once, read back, and refuses other currencies', async () => {
    expect((await api.get('/v1/virtual-accounts')).statusCode).toBe(404);
    const first = await api.post('/v1/virtual-accounts', { currency: 'NGN' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ currency: 'NGN', bank_name: 'Sandbox Test Bank', status: 'active' });
    expect(first.json().account_number).toMatch(/^90\d{8}$/);
    const again = await api.post('/v1/virtual-accounts', { currency: 'NGN' });
    expect(again.json()).toEqual(first.json());
    expect((await api.get('/v1/virtual-accounts?currency=NGN')).json()).toEqual(first.json());
    const ghs = await api.post('/v1/virtual-accounts', { currency: 'GHS' });
    expect(ghs.json().error_code).toBe('VIRTUAL_ACCOUNT_CURRENCY_NOT_SUPPORTED');
  });

  it('turns a deposit into a collection with the virtual-account fee', async () => {
    const account = (await api.post('/v1/virtual-accounts', { currency: 'NGN' })).json();
    const deposit = await api.post(`/v1/virtual-accounts/${account.id}/deposits`, { amount: '250000.00', sender_name: 'ADA OKAFOR' });
    expect(deposit.statusCode, deposit.body).toBe(201);
    expect(deposit.json()).toMatchObject({ status: 'succeeded', amount: '250000.00', checkout_id: null, fees: { amount: '300.00' } });
    const [succeeded] = await sent(env, 'collection.succeeded');
    // "a 250,000 deposit settles 249,700".
    expect(succeeded?.data).toMatchObject({
      checkout_id: null,
      reference: null,
      settlement_amount: '249700.00',
      settlement_currency: 'NGN',
      payment_method_details: { type: 'bank_transfer' },
    });
    expect(succeeded?.data.payment_method_details.bank_transfer.virtual_account).toMatchObject({
      id: account.id,
      type: 'permanent',
      expires_at: null,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Defects found by review of Bachs money out before it shipped, one test
 * each. Every one of these failed against the first version of the code.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  // An empty float, so every balance is exactly what moved.
  process.env.PAYBOX_OPENING_BALANCE = '0';
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
  delete process.env.PAYBOX_OPENING_BALANCE;
});

const cents = (decimal: string) => Math.round(Number(decimal) * 100);
const available = async (currency: string) =>
  cents(
    ((await api.get('/v1/balances')).json().balances as Array<{ currency: string; available_balance: string }>).find(
      (entry) => entry.currency === currency,
    )!.available_balance,
  );

async function collectGhs(amount: string) {
  const session = await api.checkout({ pricing: { currency: 'GHS', amount }, customer: { email: 'ama@example.com' } });
  await api.pagePost(`${session.path}/pay`, { corridor: 'MOMO_GHS', phone_number: '+233241234567', provider: 'MTN' });
  await api.pagePost(`${session.path}/simulate`, { action: 'succeed' });
  await api.advance('1s');
  return (await api.get(`/v1/checkout-sessions/${session.id}`)).json().charge.payment_id as string;
}

async function collectCard(amount: string, currency = 'USD') {
  const session = await api.checkout({ pricing: { currency, amount }, customer: { email: 'jo@example.com' } });
  await api.pagePost(`${session.path}/pay`, { corridor: `${currency}_CARD`, card_number: '4242424242424242' });
  await api.advance('1s');
  return (await api.get(`/v1/checkout-sessions/${session.id}`)).json().charge.payment_id as string;
}

/** NGN to cover payout fees, credited as a top-up: not a collection, so no schedule pays it out. */
async function feeFloat() {
  await env.context.engine.creditBalance({ provider: 'bachs', currency: 'NGN', amount: 100_000, reason: 'top_up' });
}

async function wallet() {
  const response = await api.post('/v1/payouts/destinations', {
    currency: 'USDT_TRC20',
    wallet_address: '0x1111111111111111111111111111111111111111',
  });
  return response.json().id as string;
}

async function ngnBank(account = '0001112223', bank = '999') {
  return (await api.post('/v1/payouts/destinations', { currency: 'NGN', bank_code: bank, account_number: account })).json().id as string;
}

describe('Bachs money-out regressions', () => {
  it('holds a refund the moment it is made, so a payout cannot spend the same money', async () => {
    const charge = await collectGhs('150.00'); // $9.65 settles
    const refund = await api.post('/v1/refunds', { charge_id: charge, reference: 'RF-hold', amount: '100.00' });
    expect(refund.statusCode, refund.body).toBe(201);
    // GHS 100.00 ($6.67) is held at once, leaving $2.98: not enough for a
    // $5.00 payout and its $1.00 fee.
    const payout = await api.post('/v1/payouts', { destination: await wallet(), amount: '5.00' });
    expect(payout.statusCode).toBe(400);
    expect(payout.json().error_code).toBe('INSUFFICIENT_BALANCE');
    await api.advance('2s');
    expect(await available('USD')).toBe(965 - 667);
  });

  it('blocks payouts while a balance is in debt', async () => {
    const charge = await collectGhs('150.00');
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', charge);
    // paybox's own refund, which no balance check stands in front of.
    await env.app.inject({ method: 'POST', url: `/api/payments/${payment!.id}/refund`, payload: {} });
    expect(await available('USD')).toBe(-35);
    await collectCard('100.00', 'NGN');
    const payout = await api.post('/v1/payouts', { destination: await ngnBank(), amount: '10.00' });
    expect(payout.statusCode).toBe(400);
    expect(payout.json().error_code).toBe('ORGANIZATION_IN_DEBT');
  });

  it('schedules each collection for what it actually left, refunds and underpayments included', async () => {
    const pd = await ngnBank();
    const full = await collectCard('10000.00', 'NGN'); // NGN 9,800 after the 2% fee
    const partial = await collectCard('5000.00', 'NGN'); // NGN 4,900 after the fee
    await api.post('/v1/refunds', { charge_id: partial, reference: 'RF-part', amount: '1000.00' });
    await api.advance('1s');
    void full;
    await feeFloat();
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'daily' } } });
    await api.advance('1d');
    const [payout] = (await api.get('/v1/payouts')).json().items;
    // 9,800 + (4,900 - 1,000), the NGN 50 fee on top.
    expect(payout).toMatchObject({ destination: pd, amount: '13700.00', total_debited: '13750.00' });
    expect(await available('NGN')).toBe(100_000 - 5_000);
  });

  it('frees the collections of a scheduled payout that paybox tooling failed', async () => {
    await ngnBank();
    await collectCard('10000.00', 'NGN');
    await feeFloat();
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'daily' } } });
    // To the run at 10:00 and no further: paybox's settle tool takes a
    // payout that is still pending.
    await api.advance('79199s');
    const [first] = (await api.get('/v1/payouts')).json().items;
    const engineId = (await env.context.storage.providerState.get('bachs', `payout-id:${first.id}`))!;
    const transfer = JSON.parse(engineId).engineId as string;
    const settled = await env.app.inject({ method: 'POST', url: `/api/transfers/${transfer}/settle`, payload: { status: 'failed' } });
    expect(settled.statusCode, settled.body).toBeLessThan(300);
    await api.advance('1d');
    await api.advance('2s');
    const payouts = (await api.get('/v1/payouts')).json().items;
    expect(payouts).toHaveLength(2);
    expect(payouts[0]).toMatchObject({ amount: '9800.00', status: 'completed' });
  });

  it('runs an instant schedule for what had already settled, and again after a failed payout', async () => {
    const failing = await ngnBank('0001112224', '998');
    await collectCard('10000.00', 'NGN');
    await feeFloat();
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'instant' } } });
    await api.advance('2m');
    let payouts = (await api.get('/v1/payouts')).json().items;
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ destination: failing, status: 'failed' });
    // Fixed: a working default, and the failure triggers another look.
    const working = await ngnBank();
    await api.patch(`/v1/payouts/destinations/${working}`, { is_default: true });
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'instant' } } });
    await api.advance('2m');
    payouts = (await api.get('/v1/payouts')).json().items;
    expect(payouts[0]).toMatchObject({ destination: working, status: 'completed', amount: '9800.00' });
  });

  it("refuses a quote priced for one rail on a destination of another", async () => {
    await collectCard('6000.00');
    const momo = (
      await api.post('/v1/payouts/destinations', { currency: 'GHS', type: 'mobile_money', phone_number: '233240000000', mobile_provider: 'MTN' })
    ).json().id;
    const bankQuote = (await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '5000.00' })).json();
    const refused = await api.post('/v1/payouts', { destination: momo, quote_id: bankQuote.quote_id });
    expect(refused.json().error_code).toBe('QUOTE_DESTINATION_MISMATCH');
    const momoQuote = (
      await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '5000.00', payout_method: 'MOBILE_MONEY' })
    ).json();
    // Mobile money from USD: 1%, no cap.
    expect((await api.post('/v1/payouts', { destination: momo, quote_id: momoQuote.quote_id })).json().fee).toBe('50.00');
  });

  it('refuses a quote too small to convert, and a schedule paying out where nothing can be paid', async () => {
    const tiny = await api.post('/v1/conversions/quotes', { from_currency: 'NGN', to_currency: 'USD', amount: '1.00' });
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json().error_code).toBe('QUOTE_ERROR');
    const xaf = await api.post('/v1/balance_settings', { schedule_by_currency: { USD: { interval: 'daily', payout_currency: 'XAF' } } });
    expect(xaf.statusCode).toBe(400);
  });

  it('keeps what a destination is on PATCH, and lets its name be cleared', async () => {
    const pd = await ngnBank();
    const moved = await api.patch(`/v1/payouts/destinations/${pd}`, { currency: 'GHS', type: 'mobile_money', phone_number: '233240000000' });
    expect(moved.statusCode).toBe(400);
    const cleared = await api.patch(`/v1/payouts/destinations/${pd}`, { name: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().name).toBeNull();
  });

  it('settles many small collections to what their sum is worth', async () => {
    for (let i = 0; i < 6; i++) await collectGhs('1.00');
    // Six GHS 1.00 collections, less a GHS 0.04 fee each, are GHS 5.76:
    // $0.384, so $0.38. Rounding each sweep alone would have made it
    // 6 x $0.06 = $0.36.
    expect(await available('USD')).toBe(38);
    expect((await sent(env, 'collection.succeeded')).length).toBe(6);
  });

  it('keeps a quote usable when the payout it was for is refused', async () => {
    const momo = (
      await api.post('/v1/payouts/destinations', { currency: 'GHS', type: 'mobile_money', phone_number: '233240000000', mobile_provider: 'MTN' })
    ).json().id;
    const quote = (
      await api.post('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'GHS', amount: '20.00', payout_method: 'MOBILE_MONEY' })
    ).json();
    const refused = await api.post('/v1/payouts', { destination: momo, quote_id: quote.quote_id });
    expect(refused.json().error_code).toBe('INSUFFICIENT_BALANCE');
    await collectCard('30.00');
    const paid = await api.post('/v1/payouts', { destination: momo, quote_id: quote.quote_id });
    expect(paid.statusCode, paid.body).toBe(200);
    await api.advance('2s');
    expect((await api.get(`/v1/payouts/${paid.json().id}`)).json().status).toBe('completed');
  });

  it('pays out everything in a ledger longer than one storage page, charging each fee once', async () => {
    process.env.PAYBOX_OPENING_BALANCE = '0';
    await collectCard('10000.00', 'NGN'); // NGN 9,800 after the 2% fee
    for (let i = 0; i < 600; i++) {
      await env.context.engine.creditBalance({ provider: 'bachs', currency: 'NGN', amount: 1, reason: 'top_up' });
    }
    expect(await available('NGN')).toBe(980_000 + 600);
    await collectCard('100.00', 'NGN'); // NGN 98 after the fee
    expect(await available('NGN')).toBe(980_000 + 600 + 9_800);
  });

  it('runs an instant schedule once per settlement, not every minute', async () => {
    await ngnBank();
    await feeFloat();
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'instant' } } });
    await collectCard('10000.00', 'NGN');
    await api.advance('1d');
    expect((await api.get('/v1/payouts')).json().items).toHaveLength(1);
    const schedule = (await api.get('/v1/balance_settings')).json().schedule_by_currency.NGN;
    expect(schedule).toMatchObject({ interval: 'instant', disabled_reason: null });
  });

  it('releases a refund hold even if the refund event never reached the treasury', async () => {
    const charge = await collectCard('100.00');
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', charge);
    const before = await available('USD');
    // The refund's success event is lost, as a crash would lose it.
    const bus = env.context.bus;
    const emit = bus.emit.bind(bus);
    bus.emit = async (event) => (event.type === 'refund.successful' ? undefined : emit(event));
    const refund = await api.post('/v1/refunds', { charge_id: charge, reference: 'RF-lost', amount: '10.00' });
    expect(refund.statusCode, refund.body).toBe(201);
    await api.advance('2s');
    bus.emit = emit;
    void payment;
    // Held, then refunded: $10 out, once.
    expect(await available('USD')).toBe(before - 1000);
    await collectCard('1.00'); // any later movement sweeps the stale hold away for good
    expect(await available('USD')).toBe(before - 1000 + 100 - 45);
  });

  it('accepts a PATCH of metadata alone, within the metadata limits', async () => {
    const pd = await ngnBank();
    expect((await api.patch(`/v1/payouts/destinations/${pd}`, { metadata: { team: 'ops' } })).statusCode).toBe(200);
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect((await api.patch(`/v1/payouts/destinations/${pd}`, { metadata: tooMany })).json().error_code).toBe('METADATA_LIMIT_EXCEEDED');
  });
});

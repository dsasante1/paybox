import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs Connect, phase two: split payments (direct and destination charges,
 * fee-first and share-first), platform fees, and transfers between a
 * platform and its accounts.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document
 * (CreateCheckoutSessionRequest, PaymentResponse, createTransfer,
 * listTransfers, getTransfer, listPlatformFees, getPlatformFee) and
 * connect/{split-payments/*, platform-fees, processing-fees, transfers,
 * refunds}, with the transfer-created event page.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
});

function as(account: string) {
  const headers = () => ({
    authorization: `Bearer ${env.context.bachsKeys.secretKey}`,
    'content-type': 'application/json',
    'x-account-id': account,
  });
  return {
    get: (url: string) => env.app.inject({ method: 'GET', url: `/bachs${url}`, headers: headers() }),
    post: (url: string, body: unknown = {}) =>
      env.app.inject({ method: 'POST', url: `/bachs${url}`, headers: headers(), payload: body as object }),
  };
}

let sellers = 0;
async function createAccount(body: Record<string, unknown> = {}) {
  sellers += 1;
  const response = await api.post('/v1/accounts', {
    contact_email: `seller${sellers}@example.com`,
    configuration: { merchant: {}, recipient: {} },
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, any>;
}

const cents = (decimal: string) => Math.round(Number(decimal) * 100);
const usd = async (who: { get: (url: string) => Promise<{ json(): any }> }) =>
  cents((await who.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);

/** Create a checkout as `who`, pay it by card, and return the payment. */
async function sell(who: { post: (url: string, body?: unknown) => Promise<any> }, body: Record<string, unknown>) {
  const created = await who.post('/v1/checkout-sessions', {
    pricing: { currency: 'USD', amount: '100.00' },
    customer: { email: 'buyer@example.com' },
    ...body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const session = created.json();
  await api.pagePost(`${new URL(session.checkout_url).pathname}/pay`, {
    corridor: 'USD_CARD',
    card_number: '4242424242424242',
  });
  await api.advance('1s');
  return session as Record<string, any>;
}

// A USD card is 5% + $0.40: $5.40 on $100.
const FEE = 540;

describe('direct charges with a platform fee', () => {
  it('pays the account the sale less the platform’s cut and the processing fee, and records the fee', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const session = await sell(as(account.id), { platform_fee: '20.00' });
    expect(session).toMatchObject({ platform_fee: '20.00', destination_amount: null });

    expect(await usd(as(account.id))).toBe(10_000 - 2_000 - FEE);
    expect(await usd(api)).toBe(platformBefore + 2_000);

    const payment = (await as(account.id).get('/v1/payments')).json().items[0];
    expect(payment).toMatchObject({ platform_fee: '20.00', destination_amount: null, fee_paid_by: 'merchant' });

    const fees = (await api.get('/v1/platform_fees')).json();
    expect(fees.items).toEqual([
      {
        id: expect.stringMatching(/^pf_[0-9a-f]{20}$/),
        charge: payment.id,
        collected_from: account.id,
        earned_by: env.context.bachsKeys.organizationId,
        amount: '20.00',
        currency: 'USD',
        amount_refunded: '0.00',
        refunded: false,
        created_at: expect.any(String),
      },
    ]);
    // Readable by either party.
    expect((await as(account.id).get(`/v1/platform_fees/${fees.items[0].id}`)).statusCode).toBe(200);
  });

  it('lets the platform pay the fee when it collects fees, so the account settles gross', async () => {
    const account = await createAccount({ responsibilities: { fees: { collector: 'platform' } } });
    await sell(as(account.id), { platform_fee: '20.00' });
    expect(await usd(as(account.id))).toBe(10_000 - 2_000);
    const payment = (await as(account.id).get('/v1/payments')).json().items[0];
    expect(payment).toMatchObject({ fee_paid_by: 'platform', settlement_amount: '100.00' });
  });
});

describe('destination charges', () => {
  it('fee-first: forwards the rest to the seller as a payout transfer showing the gross', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const session = await sell(api, { transfer_data: { destination: account.id }, platform_fee: '20.00' });
    expect(session).toMatchObject({ platform_fee: '20.00', destination_amount: null });

    expect(await usd(as(account.id))).toBe(8_000);
    expect(await usd(api)).toBe(platformBefore + 2_000 - FEE);

    const payment = (await api.get('/v1/payments')).json().items[0];
    expect(payment).toMatchObject({ platform_fee: '20.00', fee_paid_by: 'merchant' });
    const transfers = (await api.get('/v1/transfers')).json();
    expect(transfers.items).toEqual([
      {
        id: expect.stringMatching(/^tr_[0-9a-f]{20}$/),
        source: env.context.bachsKeys.organizationId,
        destination: account.id,
        amount: '100.00',
        currency: 'USD',
        status: 'paid',
        description: null,
        metadata: {},
        transfer_group: null,
        kind: 'payout',
        source_charge_id: payment.id,
        created_at: expect.any(String),
      },
    ]);
    const [created] = await sent(env, 'transfer.created');
    expect(created).toMatchObject({
      organization_id: account.id,
      account: account.id,
      data: { transfer_id: transfers.items[0].id, kind: 'payout', amount: '100.00', source_charge_id: payment.id },
    });
    expect((await api.get('/v1/platform_fees')).json().items[0]).toMatchObject({ collected_from: account.id, amount: '20.00' });
  });

  it('share-first: sends exactly the share, and strikes no platform fee', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const session = await sell(api, { transfer_data: { destination: account.id, amount: '70.00' } });
    expect(session).toMatchObject({ platform_fee: null, destination_amount: '70.00' });
    expect(await usd(as(account.id))).toBe(7_000);
    expect(await usd(api)).toBe(platformBefore + 3_000 - FEE);
    expect((await api.get('/v1/transfers')).json().items[0].amount).toBe('70.00');
    expect((await api.get('/v1/platform_fees')).json().items).toEqual([]);
  });

  it('is the platform’s to refund, and the seller keeps its share', async () => {
    const account = await createAccount();
    await sell(api, { transfer_data: { destination: account.id }, platform_fee: '20.00' });
    const charge = (await api.get('/v1/payments')).json().items[0].id;
    const platformBefore = await usd(api);
    const refund = await api.post('/v1/refunds', { charge_id: charge, reference: 'dest-refund' });
    expect(refund.statusCode, refund.body).toBe(201);
    await api.advance('1h');
    expect(await usd(api)).toBe(platformBefore - 10_000);
    expect(await usd(as(account.id))).toBe(8_000);
    // The seller cannot refund the platform's sale.
    expect((await as(account.id).post('/v1/refunds', { charge_id: charge, reference: 'x' })).statusCode).toBe(404);
  });

  it('refuses the documented bad splits', async () => {
    const account = await createAccount();
    const other = await createAccount();
    const pricing = { pricing: { currency: 'USD', amount: '100.00' } };
    const cases: Array<[unknown, Record<string, unknown>, number, string]> = [
      [as(account.id), { transfer_data: { destination: other.id }, platform_fee: '1.00' }, 400, 'CONTRADICTORY_CHARGE_TYPE'],
      [api, { transfer_data: { destination: account.id, amount: '10.00' }, platform_fee: '1.00' }, 400, 'VALIDATION_ERROR'],
      [api, { transfer_data: { destination: account.id } }, 400, 'INVALID_PLATFORM_FEE'],
      [api, { transfer_data: { destination: account.id }, platform_fee: '100.00' }, 400, 'INVALID_PLATFORM_FEE'],
      [api, { transfer_data: { destination: account.id }, platform_fee: '0.001' }, 400, 'INVALID_PLATFORM_FEE'],
      [api, { transfer_data: { destination: account.id, platform_fee: '1.00' } }, 400, 'VALIDATION_ERROR'],
      [api, { transfer_data: { destination: 'acct_0000000000000000' }, platform_fee: '1.00' }, 404, 'NOT_FOUND'],
    ];
    for (const [who, body, status, code] of cases) {
      const response = await (who as typeof api).post('/v1/checkout-sessions', { ...pricing, ...body });
      expect([response.statusCode, response.json().error_code], JSON.stringify(body)).toEqual([status, code]);
    }
  });

  it('rounds a split amount half-up to the minor unit, and echoes what was kept', async () => {
    const account = await createAccount();
    const created = await api.post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', amount: '100.00' },
      transfer_data: { destination: account.id },
      platform_fee: '33.337',
    });
    expect(created.json().platform_fee).toBe('33.34');
  });
});

describe('manual transfers', () => {
  it('moves money from the platform to an account and back, paid at once', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const out = await api.post('/v1/transfers', {
      destination: account.id,
      amount: '50.00',
      currency: 'USD',
      description: 'Seller share',
      metadata: { order: '4471' },
      transfer_group: 'ORDER-4471',
    });
    expect(out.statusCode, out.body).toBe(201);
    expect(out.json()).toMatchObject({
      source: env.context.bachsKeys.organizationId,
      destination: account.id,
      amount: '50.00',
      status: 'paid',
      kind: 'manual',
      description: 'Seller share',
      metadata: { order: '4471' },
      transfer_group: 'ORDER-4471',
      source_charge_id: null,
    });
    expect(await usd(as(account.id))).toBe(5_000);
    expect(await usd(api)).toBe(platformBefore - 5_000);

    // "Recovery = second transfer: X-Account-Id + destination: self."
    const back = await as(account.id).post('/v1/transfers', { destination: 'self', amount: '20.00', currency: 'USD' });
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json()).toMatchObject({ source: account.id, destination: env.context.bachsKeys.organizationId });
    expect(await usd(as(account.id))).toBe(3_000);
    expect(await usd(api)).toBe(platformBefore - 3_000);

    const events = await sent(env, 'transfer.created');
    expect(events.map((event) => [event.account, event.data.source, event.data.destination])).toEqual([
      [account.id, env.context.bachsKeys.organizationId, account.id],
      [account.id, account.id, env.context.bachsKeys.organizationId],
    ]);
  });

  it('refuses what the transfer rules forbid', async () => {
    const account = await createAccount();
    const other = await createAccount();
    const usdTransfer = (destination: string, amount = '1.00') => ({ destination, amount, currency: 'USD' });

    const between = await as(account.id).post('/v1/transfers', usdTransfer(other.id));
    expect(between.json().error_code).toBe('BAD_REQUEST');
    const selfAsPlatform = await api.post('/v1/transfers', usdTransfer('self'));
    expect(selfAsPlatform.json().error_code).toBe('BAD_REQUEST');
    const unknown = await api.post('/v1/transfers', usdTransfer('acct_0000000000000000'));
    expect(unknown.statusCode).toBe(404);
    const short = await as(account.id).post('/v1/transfers', usdTransfer('self', '5.00'));
    expect(short.json().error_code).toBe('INSUFFICIENT_BALANCE');
    const converting = await api.post('/v1/transfers', { destination: account.id, amount: '1.00', currency: 'GHS' });
    expect(converting.json().error_code).toBe('VALIDATION_ERROR');

    await api.post(`/v1/accounts/${account.id}/capabilities/transfers`, { status: 'restricted' });
    const restricted = await api.post('/v1/transfers', usdTransfer(account.id));
    expect(restricted.statusCode).toBe(403);
  });

  it('lists the transfers a party is in, filtered, and hides the rest', async () => {
    const one = await createAccount();
    const two = await createAccount();
    await api.post('/v1/transfers', { destination: one.id, amount: '5.00', currency: 'USD' });
    await api.post('/v1/transfers', { destination: two.id, amount: '6.00', currency: 'USD' });
    const all = (await api.get('/v1/transfers')).json();
    expect(all.items.map((item: any) => item.amount)).toEqual(['6.00', '5.00']);
    expect((await api.get(`/v1/transfers?connected_account_id=${one.id}`)).json().items).toHaveLength(1);
    expect((await api.get('/v1/transfers?kind=payout')).json().items).toEqual([]);
    expect((await api.get('/v1/transfers?kind=platform_fee')).statusCode).toBe(400);

    const mine = (await as(one.id).get('/v1/transfers')).json().items;
    expect(mine.map((item: any) => item.amount)).toEqual(['5.00']);
    const theirs = all.items[0].id;
    expect((await as(one.id).get(`/v1/transfers/${theirs}`)).statusCode).toBe(404);
    expect((await api.get(`/v1/transfers/${theirs}`)).statusCode).toBe(200);
  });
});

describe('review findings', () => {
  it('settles a destination charge even while the platform is in debt', async () => {
    process.env.PAYBOX_OPENING_BALANCE = '0';
    await env.close();
    env = await startBachs();
    api = client(env);
    delete process.env.PAYBOX_OPENING_BALANCE;
    // A lost dispute leaves the platform negative.
    await sell(api, {});
    const charge = (await api.get('/v1/payments')).json().items[0].id;
    const dispute = (await api.post('/v1/disputes', { charge_id: charge })).json();
    await api.post(`/v1/disputes/${dispute.dispute_id}/network`, { status: 'lost' });
    expect(await usd(api)).toBeLessThan(0);

    const account = await createAccount();
    await sell(api, { transfer_data: { destination: account.id }, platform_fee: '1.00' });
    // Settled and forwarded. The fee comes out of the $1 cut first; the
    // platform's balance is negative, so only "the remainder" comes from the
    // seller's share.
    expect(await usd(as(account.id))).toBe(9_900 - (FEE - 100));
  });

  it('takes an accepted shortfall on a fee-first destination charge from the seller’s share', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const created = (
      await api.post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
        transfer_data: { destination: account.id },
        platform_fee: '20.00',
      })
    ).json();
    const path = new URL(created.checkout_url).pathname;
    await api.pagePost(`${path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    await api.pagePost(`${path}/simulate`, { action: 'underpaid' });
    await api.pagePost(`${path}/simulate`, { action: 'accept_underpayment' });
    await api.advance('1s');
    const paid = cents((await api.get('/v1/payments')).json().items[0].amount_paid);
    const fee = cents((await api.get('/v1/payments')).json().items[0].fee);
    // The platform keeps its cut less the fee; the seller gets the rest of what arrived.
    expect(await usd(as(account.id))).toBe(paid - 2_000);
    expect(await usd(api)).toBe(platformBefore + 2_000 - fee);
  });

  it('takes an accepted shortfall on a direct split from the account’s rest, the cut kept', async () => {
    const account = await createAccount();
    const platformBefore = await usd(api);
    const created = (
      await as(account.id).post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
        platform_fee: '20.00',
      })
    ).json();
    const path = new URL(created.checkout_url).pathname;
    await api.pagePost(`${path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    await api.pagePost(`${path}/simulate`, { action: 'underpaid' });
    await api.pagePost(`${path}/simulate`, { action: 'accept_underpayment' });
    await api.advance('1s');
    const payment = (await as(account.id).get('/v1/payments')).json().items[0];
    expect(await usd(as(account.id))).toBe(cents(payment.amount_paid) - 2_000 - cents(payment.fee));
    expect(await usd(api)).toBe(platformBefore + 2_000);
  });

  it('checks a split against every price the payer can pay', async () => {
    const account = await createAccount();
    const options = await api.post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', amount: '100.00', currency_options: { NGN: '1000.00' } },
      transfer_data: { destination: account.id, amount: '70.00' },
    });
    expect(options.json().error_code).toBe('INVALID_PLATFORM_FEE');
    const custom = await api.post('/v1/checkout-sessions', {
      pricing: { currency: 'USD', price_type: 'custom' },
      transfer_data: { destination: account.id, amount: '70.00' },
    });
    expect(custom.json().error_code).toBe('INVALID_PLATFORM_FEE');
  });

  it('refuses a direct cut that leaves less than the processing fee', async () => {
    const account = await createAccount();
    const created = (
      await as(account.id).post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
        platform_fee: '99.00',
      })
    ).json();
    const paid = await api.pagePost(`${new URL(created.checkout_url).pathname}/pay`, {
      corridor: 'USD_CARD',
      card_number: '4242424242424242',
    });
    expect(paid.body).toContain('processing fee together exceed this sale');
    expect(await usd(as(account.id))).toBe(0);
  });

  it('lists transfers newest first, in the order they were made', async () => {
    const account = await createAccount();
    for (const amount of ['1.00', '2.00', '3.00', '4.00', '5.00']) {
      await api.post('/v1/transfers', { destination: account.id, amount, currency: 'USD' });
    }
    const listed = (await api.get('/v1/transfers')).json().items.map((item: any) => item.amount);
    expect(listed).toEqual(['5.00', '4.00', '3.00', '2.00', '1.00']);
  });

  it('pays a platform schedule only the cut a destination charge left it', async () => {
    const account = await createAccount();
    await api.post('/v1/payouts/destinations', { currency: 'NGN', bank_code: '999', account_number: '0001112223' });
    await api.post('/v1/balance_settings', { schedule_by_currency: { NGN: { interval: 'instant' } } });
    const created = (
      await api.post('/v1/checkout-sessions', {
        pricing: { currency: 'NGN', amount: '10000.00' },
        customer: { email: 'buyer@example.com' },
        transfer_data: { destination: account.id },
        platform_fee: '2000.00',
      })
    ).json();
    await api.pagePost(`${new URL(created.checkout_url).pathname}/pay`, { corridor: 'NGN_CARD', card_number: '4242424242424242' });
    await api.advance('1s');
    const fee = cents((await api.get('/v1/payments')).json().items[0].fee);
    await api.advance('2m');
    const payout = (await api.get('/v1/payouts')).json().items[0];
    expect(cents(payout.amount)).toBe(200_000 - fee);
  });
});

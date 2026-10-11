import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs checkout settings (who bears the processing fee, which methods a
 * checkout offers) and the collection listings.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document
 * (getCheckoutSettings, updateCheckoutSettings, listPaymentMethods,
 * listPaymentRails, listSupportedCurrencies, createCharge) and
 * connect/processing-fees, for-you/supported-currencies.
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
    put: (url: string, body: unknown) =>
      env.app.inject({ method: 'PUT', url: `/bachs${url}`, headers: headers(), payload: body as object }),
  };
}

const put = (url: string, body: unknown) =>
  env.app.inject({
    method: 'PUT',
    url: `/bachs${url}`,
    headers: { authorization: `Bearer ${env.context.bachsKeys.secretKey}`, 'content-type': 'application/json' },
    payload: body as object,
  });

const cents = (decimal: string) => Math.round(Number(decimal) * 100);

describe('checkout settings', () => {
  it('starts with every method on and the merchant bearing the fee', async () => {
    const settings = (await api.get('/v1/accounts/checkout/settings')).json();
    expect(settings).toMatchObject({
      organization_id: env.context.bachsKeys.organizationId,
      fee_preference: 'org_pays',
      enabled_payment_methods: { USD_CARD: { enabled: true }, NGN_BANK_TRANSFER: { enabled: true } },
    });
    expect(settings.enabled_payment_methods.CRYPTO).toMatchObject({ enabled: true, currencies: { USDT_TRC20: true } });
    expect(settings.available_currencies.USD_CARD).toEqual(['USD']);
    expect(settings.available_currencies.CRYPTO).toEqual([
      'BNB_BEP20',
      'ETH_ETH',
      'SOL_SOL',
      'USDC_BEP20',
      'USDT_BEP20',
      'USDT_ERC20',
      'USDT_SOL',
      'USDT_TRC20',
    ]);
  });

  it('replaces the methods wholesale, and a checkout offers only what is on', async () => {
    const updated = await put('/v1/accounts/checkout/settings', {
      enabled_payment_methods: { USD_CARD: { enabled: true }, CRYPTO: { enabled: true, currencies: { USDT_TRC20: false } } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toEqual({
      organization_id: env.context.bachsKeys.organizationId,
      enabled_payment_methods: { USD_CARD: { enabled: true }, CRYPTO: { enabled: true, currencies: { USDT_TRC20: false } } },
      fee_preference: 'org_pays',
      message: 'Checkout settings updated successfully',
    });
    const session = (
      await api.post('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '10.00' }, customer: { email: 'a@example.com' } })
    ).json();
    const path = new URL(session.checkout_url).pathname;
    // NGN bank transfer was left out, so it is off; one asset is off too.
    const page = await api.pageGet(path);
    expect(page.body).not.toContain('NGN_BANK_TRANSFER');
    const refused = await api.pagePost(`${path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    expect(refused.body).toContain('Choose an asset and network');

    // Nothing left that charges NGN.
    const ngn = await api.post('/v1/checkout-sessions', { pricing: { currency: 'NGN', amount: '1000.00' } });
    expect(ngn.json().error_code).toBe('CHECKOUT_HAS_NO_PAYMENT_METHOD');
  });

  it('refuses an empty or malformed update', async () => {
    expect((await put('/v1/accounts/checkout/settings', {})).statusCode).toBe(400);
    expect((await put('/v1/accounts/checkout/settings', { enabled_payment_methods: { WIRE: { enabled: true } } })).statusCode).toBe(400);
    expect((await put('/v1/accounts/checkout/settings', { enabled_payment_methods: { USD_CARD: {} } })).statusCode).toBe(400);
    expect(
      (await put('/v1/accounts/checkout/settings', { enabled_payment_methods: { USD_CARD: { enabled: true, currencies: { USD: true } } } }))
        .statusCode,
    ).toBe(400);
  });

  it('keeps each account’s settings its own, and shows them as its fee_handling', async () => {
    const account = (
      await api.post('/v1/accounts', { contact_email: 'seller@example.com', configuration: { merchant: {}, recipient: {} } })
    ).json();
    await as(account.id).put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    expect((await api.get('/v1/accounts/checkout/settings')).json().fee_preference).toBe('org_pays');
    expect((await as(account.id).get('/v1/accounts/checkout/settings')).json()).toMatchObject({
      organization_id: account.id,
      fee_preference: 'customer_pays',
    });
    expect((await api.get(`/v1/accounts/${account.id}`)).json().fee_handling).toBe('customer_pays_fee');
    expect((await api.get('/v1/accounts/me')).json().fee_handling).toBe('account_pays_fee');
  });
});

describe('the customer paying the fee', () => {
  it('charges 30.85 for a 29.00 off-session charge on a USD card, and settles 29.00', async () => {
    await put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const customer = await api.customer();
    await api.saveCard(customer);
    const balanceBefore = cents(
      (await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance,
    );
    const charged = await api.post('/v1/charges', { customer, amount: '29.00', currency: 'USD' });
    expect(charged.statusCode, charged.body).toBe(201);
    expect(charged.json()).toMatchObject({
      amount: '30.85',
      amount_remaining: '30.85',
      fees: { amount: '1.85', currency: 'USD' },
      merchant_bears_cost: false,
    });
    await api.advance('2s');
    const balanceAfter = cents(
      (await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance,
    );
    expect(balanceAfter - balanceBefore).toBe(2_900);
    const [collected] = (await sent(env, 'collection.succeeded')).slice(-1);
    expect(collected?.data).toMatchObject({ amount: '30.85', processing_fee: '1.85', fee_bearer: 'customer', settlement_amount: '29.00' });
  });

  it('adds the fee on top at the hosted page, and leaves a destination split as struck', async () => {
    const account = (
      await api.post('/v1/accounts', { contact_email: 'dest@example.com', configuration: { merchant: {}, recipient: {} } })
    ).json();
    await put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const before = cents((await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);
    const session = (
      await api.post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
        transfer_data: { destination: account.id },
        platform_fee: '20.00',
      })
    ).json();
    await api.pagePost(`${new URL(session.checkout_url).pathname}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await api.advance('1s');
    const payment = (await api.get('/v1/payments')).json().items[0];
    expect(payment).toMatchObject({ amount: '105.40', fee: '5.40' });
    const seller = cents(
      (await as(account.id).get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance,
    );
    expect(seller).toBe(8_000);
    const after = cents((await api.get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD').available_balance);
    expect(after - before).toBe(2_000);
    // The payout row's gross is the sale, not the fee the customer added.
    expect((await api.get('/v1/transfers')).json().items[0].amount).toBe('100.00');
  });

  it('keeps the total the first method set: a method with another fee is refused', async () => {
    await put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const session = (
      await api.post('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '29.00' }, customer: { email: 'a@example.com' } })
    ).json();
    const path = new URL(session.checkout_url).pathname;
    await api.pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: '4000000000000002' });
    const switched = await api.pagePost(`${path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    expect(switched.body).toContain('choose a method with the same fee');
    const again = await api.pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(again.statusCode).toBe(200);
    await api.advance('1s');
    expect((await api.get('/v1/payments')).json().items[0]).toMatchObject({ amount: '30.85', fee: '1.85' });
  });

  it('lets a direct cut leave the account only the sale, when the customer pays the fee on top', async () => {
    const account = (
      await api.post('/v1/accounts', { contact_email: 'thin@example.com', configuration: { merchant: {}, recipient: {} } })
    ).json();
    await as(account.id).put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const session = (
      await as(account.id).post('/v1/checkout-sessions', {
        pricing: { currency: 'USD', amount: '100.00' },
        customer: { email: 'buyer@example.com' },
        platform_fee: '96.00',
      })
    ).json();
    await api.pagePost(`${new URL(session.checkout_url).pathname}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await api.advance('1s');
    const balance = (await as(account.id).get('/v1/balances')).json().balances.find((b: any) => b.currency === 'USD');
    expect(cents(balance.available_balance)).toBe(400);
  });

  it('charges a fee worked out in the card’s own currency', async () => {
    await put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const customer = await api.customer();
    await api.saveCard(customer);
    const charged = await api.post('/v1/charges', { customer, amount: '1000.00', currency: 'NGN' });
    // In dollars: NGN 1,000 is $0.67, 5% of it $0.03, plus $0.40 -- $0.43, NGN 645 at 1,500.
    expect(charged.json()).toMatchObject({ amount: '1645.00', fees: { amount: '645.00', currency: 'NGN' } });
  });

  it('leaves a subscription checkout’s price as it is', async () => {
    await put('/v1/accounts/checkout/settings', { fee_preference: 'customer_pays' });
    const product = await api.product({ currency: 'USD', amount: '29.00' });
    const customer = await api.customer();
    const { subscription } = await api.subscribe(product, customer);
    expect(subscription).toBeDefined();
    const payment = (await api.get('/v1/payments')).json().items[0];
    expect(payment.amount).toBe('29.00');
  });
});

describe('settings changed after a checkout was made', () => {
  it('offers only what is on now', async () => {
    const session = (
      await api.post('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '10.00' }, customer: { email: 'a@example.com' } })
    ).json();
    const path = new URL(session.checkout_url).pathname;
    await put('/v1/accounts/checkout/settings', {
      enabled_payment_methods: { USD_CARD: { enabled: false }, CRYPTO: { enabled: true, currencies: { USDT_TRC20: false } } },
    });
    const page = await api.pageGet(path);
    expect(page.body).not.toContain('value="USD_CARD"');
    expect(page.body).not.toContain('value="USDT_TRC20"');
    expect(page.body).toContain('value="USDT_BEP20"');
    const card = await api.pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(card.body).toContain('Choose one of the payment methods this checkout offers');
  });

  it('refuses prototype keys and a malformed asset map', async () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect((await put('/v1/accounts/checkout/settings', { enabled_payment_methods: { [key]: { enabled: true } } })).statusCode).toBe(400);
    }
    for (const currencies of [null, []]) {
      expect(
        (await put('/v1/accounts/checkout/settings', { enabled_payment_methods: { CRYPTO: { enabled: true, currencies } } })).statusCode,
      ).toBe(400);
    }
  });
});

describe('listings', () => {
  it('lists the payment methods, the published rail, and the collection currencies', async () => {
    const methods = (await api.get('/v1/payment-methods')).json().payment_methods;
    expect(methods.map((method: any) => method.id)).toEqual(['CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CRYPTO']);
    expect(methods[1]).toEqual({
      id: 'BANK_TRANSFER',
      display_name: 'Bank Transfer',
      icon: 'bank',
      description: 'Pay via bank transfer',
      type: 'fiat',
      enabled_by_default: true,
      currencies: ['NGN'],
    });

    const rails = (await api.get('/v1/payment-methods/rails?payment_method=BANK_TRANSFER&currency=NGN&country_code=NG')).json();
    expect(rails).toEqual({
      payment_method: 'BANK_TRANSFER',
      currency: 'NGN',
      country_code: 'NG',
      rails: [{ id: 'bank_transfer_ng', name: 'Bank Transfer Nigeria', active: true }],
    });
    expect((await api.get('/v1/payment-methods/rails?payment_method=CARD&currency=USD')).json().rails).toEqual([]);
    expect((await api.get('/v1/payment-methods/rails?currency=NGN')).statusCode).toBe(400);

    const currencies = (await api.get('/v1/currencies/supported')).json();
    expect(currencies.fiat).toContain('XOF');
    expect(currencies.crypto).toContain('USDT_TRC20');
  });
});

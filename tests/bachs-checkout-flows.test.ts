import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  BACHS_SIGNATURE_HEADER,
  BACHS_SIGNATURE_V2_HEADER,
  BACHS_TIMESTAMP_HEADER,
} from '@paybox/bachs';

/**
 * Bachs: every hosted-checkout rail and session lifecycle, driven the way a
 * payer's browser and a merchant's server drive them.
 *
 * Behaviour from docs.bachs.io, read 2026-10-10: integrate/sandbox (test cards,
 * "finalizes on its own, about a second after the customer pays", test
 * controls for other rails), guides/checkout/checkout-sessions (guest
 * checkout, customer_creation), and the event pages under
 * guides/webhooks/events/ (collection.failed "once per payment, for the first
 * failure"; collection.underpaid crypto-only; checkout.expired "Expiry is not
 * always final"; checkout.completed for free checkouts). REST shapes from the
 * pinned OpenAPI document (sha256 9c2265585c2b…4810).
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-06-14T12:00:00.000Z';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = 'bachs';
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

const auth = () => ({
  authorization: `Bearer ${context.bachsKeys.secretKey}`,
  'content-type': 'application/json',
});
/**
 * Webhook deliveries are scheduler jobs, so each write drains the queue the way
 * a running server would before the test looks at what was sent.
 */
const flush = () => context.scheduler.drain();
const post = async (url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await app.inject({ method: 'POST', url: `/bachs${url}`, headers: { ...auth(), ...headers }, payload: (body ?? {}) as object });
  await flush();
  return response;
};
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
/** The hosted page: no key, form-encoded, like a payer's browser. */
const pageGet = (path: string) => app.inject({ method: 'GET', url: path });
const pagePost = async (path: string, form: Record<string, string>) => {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
  await flush();
  return response;
};
const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function endpoint(types: string[] = ['checkout.completed', 'collection.succeeded', 'collection.failed', 'checkout.expired', 'refund.created', 'refund.paid', 'refund.failed', 'collection.underpaid', 'customer.created', 'customer.updated']) {
  const response = await post('/v1/webhooks/endpoints', {
    name: 'Local receiver',
    url: 'https://merchant.example.com/webhooks/bachs',
    event_types: types,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { endpoint_id: string; signing_secret: string };
}

async function product(price: Record<string, unknown> = { currency: 'USD', amount: '29.00' }) {
  const response = await post('/v1/products', { name: 'Pro plan', price });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

/** The path part of a checkout_url. */
const pathOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

function sent(type: string) {
  return transport.sent
    .map((request) => ({ request, body: JSON.parse(request.body) as { id: string; type: string; data: Record<string, unknown> } }))
    .filter(({ body }) => body.type === type);
}

/** Every Bachs event type delivered so far, in delivery order. */
const sentTypes = (options: { customers?: boolean } = {}) =>
  transport.sent
    .map((request) => (JSON.parse(request.body) as { type: string }).type)
    .filter((type) => options.customers || !type.startsWith('customer.'));

const JANE = { email: 'jane@example.com', name: 'Jane Doe' };

/** Create a session and return it with the hosted page's path. */
async function checkout(body: Record<string, unknown>) {
  const response = await post('/v1/checkout-sessions', body);
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as { checkout_id: string; checkout_url: string; expires_at: string };
  return { ...session, path: pathOf(session.checkout_url) };
}

/** A one-product cart checkout with a known customer. */
async function cartCheckout(
  price: Record<string, unknown> = { currency: 'USD', amount: '29.00' },
  extra: Record<string, unknown> = {},
) {
  const { id } = await product(price);
  return checkout({ product_cart: [{ product_id: id, quantity: 1 }], customer: JANE, ...extra });
}

const read = async (checkoutId: string) => {
  const response = await get(`/v1/checkout-sessions/${checkoutId}`);
  expect(response.statusCode).toBe(200);
  return response.json();
};

/* ---------------------------------- cards --------------------------------- */

describe('sandbox test cards', () => {
  it.each([
    ['4000000000000002', 'declined'],
    ['4000000000009995', 'insufficient funds'],
    ['4000000000000069', 'expired card'],
    ['4000000000000119', 'processing error'],
  ])('%s (%s) fails the attempt, sends one collection.failed, and a good card then pays the same charge', async (card) => {
    await endpoint();
    const session = await cartCheckout();

    const first = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: card });
    expect(first.statusCode).toBe(200);

    const failed = await read(session.checkout_id);
    expect(failed.status).toBe('open');
    expect(failed.payment_status).toBe('failed');
    expect(failed.charge.status).toBe('failed');
    expect(failed.charge.payment_id).toMatch(/^ch_[0-9a-f]{32}$/);
    const chargeId = failed.charge.payment_id as string;

    expect(sent('collection.failed')).toHaveLength(1);
    expect(sent('collection.failed')[0]!.body.data).toMatchObject({
      charge_id: chargeId,
      checkout_id: session.checkout_id,
      status: 'FAILED',
      amount: '29.00',
      currency: 'USD',
      processing_fee: null,
      processing_fee_currency: null,
      payment_method_details: null,
    });

    // A second failure on the same payment: still exactly one event.
    const second = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: card });
    expect(second.statusCode).toBe(200);
    expect((await read(session.checkout_id)).status).toBe('open');
    expect(sent('collection.failed')).toHaveLength(1);

    // Then a good card on the same checkout.
    const good = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(good.statusCode).toBe(200);
    expect((await read(session.checkout_id)).payment_status).toBe('processing');
    await advance('1s');

    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.payment_status).toBe('succeeded');
    expect(done.charge.payment_id).toBe(chargeId);
    expect(done.charge.status).toBe('succeeded');
    expect(done.completed_at).toBe('2026-06-14T12:00:01.000Z');

    expect(sent('collection.succeeded')).toHaveLength(1);
    expect(sent('collection.succeeded')[0]!.body.data).toMatchObject({ charge_id: chargeId, status: 'SUCCEEDED' });
    expect(sent('checkout.completed')).toHaveLength(1);
    expect(sent('checkout.completed')[0]!.body.data).toMatchObject({
      checkout_id: session.checkout_id,
      payment_status: 'paid',
    });
    expect(sent('collection.failed')).toHaveLength(1);

    // Still one charge behind the checkout.
    const list = (await get('/v1/payments')).json();
    expect(list.pagination.total).toBe(1);
  });
});

/* ------------------------------ bank transfer ------------------------------ */

describe('NGN bank transfer', () => {
  it('shows a one-time sandbox account, settles on the test control, and reports the sender and a 1.5% fee', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'NGN', amount: '75000.00' }, { reference: 'ORD-NGN-1' });

    const paid = await pagePost(`${session.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain('Sandbox Test Bank');

    const waiting = await read(session.checkout_id);
    expect(waiting.status).toBe('open');
    expect(waiting.charge.status).toBe('created');
    expect(waiting.charge.payment_method).toBe('NGN_BANK_TRANSFER');
    expect(waiting.charge.payment_method_details.type).toBe('bank_transfer');
    const account = waiting.charge.payment_method_details.bank_transfer.virtual_account;
    // guides/virtual-accounts/overview: "It starts with `90` and its bank is **Sandbox Test Bank**."
    expect(account.account_number).toMatch(/^90\d{8}$/);
    expect(account).toMatchObject({ id: null, bank_name: 'Sandbox Test Bank', type: 'one_time', expires_at: session.expires_at });
    expect(paid.body).toContain(account.account_number);
    expect(sentTypes()).toEqual([]);

    await pagePost(`${session.path}/simulate`, { action: 'succeed' });
    expect((await read(session.checkout_id)).charge.status).toBe('processing');
    await advance('1s');

    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge).toMatchObject({
      status: 'succeeded',
      amount: '75000.00',
      currency: 'NGN',
      fees: { amount: '1125.00', currency: 'NGN' },
      is_refundable: false,
    });

    const [succeeded] = sent('collection.succeeded');
    expect(succeeded?.body.data).toMatchObject({
      status: 'SUCCEEDED',
      amount: '75000.00',
      currency: 'NGN',
      settlement_amount: '73875.00',
      settlement_currency: 'NGN',
      processing_fee: '1125.00',
      processing_fee_currency: 'NGN',
      reference: 'ORD-NGN-1',
    });
    const details = succeeded!.body.data.payment_method_details as { type: string; bank_transfer: Record<string, unknown> };
    expect(details.type).toBe('bank_transfer');
    expect(details.bank_transfer).toMatchObject({
      sender_name: 'PAYBOX TEST PAYER',
      sender_bank: 'Sandbox Test Bank',
      sender_bank_code: '000',
      narration: 'ORD-NGN-1',
      virtual_account: account,
    });
    expect(details.bank_transfer.sender_account_number).toMatch(/^\d{10}$/);
    expect(details.bank_transfer.session_id).toMatch(/^\d{30}$/);
    expect(sent('checkout.completed')).toHaveLength(1);
  });

  it('a short transfer leaves the payment underpaid and the checkout open, with no collection.underpaid', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'NGN', amount: '75000.00' });
    await pagePost(`${session.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });
    const short = await pagePost(`${session.path}/simulate`, { action: 'short_transfer' });
    expect(short.statusCode).toBe(200);

    const after = await read(session.checkout_id);
    expect(after.status).toBe('open');
    expect(after.charge).toMatchObject({ status: 'underpaid', amount_paid: '37500.00', amount_remaining: '37500.00' });
    // collection.underpaid: "A bank transfer that arrives short does not send this event".
    expect(sent('collection.underpaid')).toHaveLength(0);
    expect(sent('collection.succeeded')).toHaveLength(0);
    expect(sent('checkout.completed')).toHaveLength(0);

    await advance('1s');
    expect((await read(session.checkout_id)).status).toBe('open');
  });
});

/* ------------------------------- mobile money ------------------------------ */

describe('mobile money', () => {
  it('waits for the payer to approve the prompt, then settles', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'GHS', amount: '100.00' });
    const paid = await pagePost(`${session.path}/pay`, { corridor: 'MOMO_GHS', phone_number: '+233241234567', provider: 'MTN' });
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain('+233241234567');

    const waiting = await read(session.checkout_id);
    expect(waiting.status).toBe('open');
    expect(waiting.payment_status).toBe('requires_action');
    expect(waiting.charge.status).toBe('created');
    expect(waiting.charge.payment_method_details).toEqual({
      type: 'mobile_money',
      mobile_money: { phone_number: '+233241234567', provider: 'MTN' },
    });

    await pagePost(`${session.path}/simulate`, { action: 'succeed' });
    await advance('1s');
    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge).toMatchObject({ status: 'succeeded', currency: 'GHS', fees: { amount: '3.50', currency: 'GHS' } });
    expect(sent('collection.succeeded')[0]?.body.data).toMatchObject({ status: 'SUCCEEDED', processing_fee: '3.50' });
  });

  it('a declined prompt fails the attempt and sends collection.failed', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'GHS', amount: '100.00' });
    await pagePost(`${session.path}/pay`, { corridor: 'MOMO_GHS', phone_number: '+233241234567' });
    const declined = await pagePost(`${session.path}/simulate`, { action: 'fail' });
    expect(declined.statusCode).toBe(200);

    const after = await read(session.checkout_id);
    expect(after.status).toBe('open');
    expect(after.charge.status).toBe('failed');
    expect(sent('collection.failed')).toHaveLength(1);
    expect(sent('collection.failed')[0]!.body.data).toMatchObject({ status: 'FAILED', currency: 'GHS', amount: '100.00' });
  });
});

/* ---------------------------------- crypto --------------------------------- */

describe('crypto', () => {
  async function cryptoCheckout() {
    await endpoint();
    const session = await cartCheckout({ currency: 'USD', amount: '29.00' });
    const paid = await pagePost(`${session.path}/pay`, { corridor: 'CRYPTO', asset: 'USDT_TRC20' });
    expect(paid.statusCode).toBe(200);
    const waiting = await read(session.checkout_id);
    expect(waiting.charge.status).toBe('created');
    expect(waiting.charge.payment_method_details.type).toBe('crypto');
    expect(waiting.charge.payment_method_details.crypto.asset).toBe('USDT_TRC20');
    expect(waiting.charge.payment_method_details.crypto.address).toMatch(/^T[0-9a-f]{33}$/);
    return session;
  }

  it('an underpayment sends collection.underpaid, and sending the rest settles it', async () => {
    const session = await cryptoCheckout();
    await pagePost(`${session.path}/simulate`, { action: 'underpaid' });

    const short = await read(session.checkout_id);
    expect(short.status).toBe('open');
    expect(short.charge.status).toBe('underpaid');
    expect(sent('collection.underpaid')).toHaveLength(1);
    expect(sent('collection.underpaid')[0]!.body.data).toEqual({
      charge_id: short.charge.payment_id,
      reference: null,
      checkout_id: session.checkout_id,
      amount_paid: '14.50',
      amount_expected: '29.00',
      amount_remaining: '14.50',
      currency: 'USD',
      status: 'UNDERPAID',
      metadata: {},
    });

    await pagePost(`${session.path}/simulate`, { action: 'send_rest' });
    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge).toMatchObject({ status: 'succeeded', amount_paid: '29.00', amount_remaining: '0.00' });
    expect(sent('collection.succeeded')[0]?.body.data).toMatchObject({ status: 'SUCCEEDED', processing_fee: '0.44' });
    expect(sent('checkout.completed')).toHaveLength(1);
  });

  it('an overpayment succeeds as OVERPAID with the overpayment fields', async () => {
    const session = await cryptoCheckout();
    await pagePost(`${session.path}/simulate`, { action: 'overpaid' });

    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge.status).toBe('overpaid');
    const [succeeded] = sent('collection.succeeded');
    expect(succeeded?.body.data).toMatchObject({
      status: 'OVERPAID',
      amount: '29.00',
      expected_amount: '29.00',
      received_amount: '31.90',
      overpaid_amount: '2.90',
    });
    expect(sent('checkout.completed')).toHaveLength(1);
  });

  it('the merchant accepting an underpayment completes it as ACCEPTED', async () => {
    const session = await cryptoCheckout();
    await pagePost(`${session.path}/simulate`, { action: 'underpaid' });
    await pagePost(`${session.path}/simulate`, { action: 'accept_underpayment' });

    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge.status).toBe('accepted');
    const [succeeded] = sent('collection.succeeded');
    expect(succeeded?.body.data.status).toBe('ACCEPTED');
    expect(succeeded?.body.data).not.toHaveProperty('overpaid_amount');
  });
});

/* ---------------------------------- expiry --------------------------------- */

describe('expiry', () => {
  it('an unattempted checkout sends checkout.expired only', async () => {
    await endpoint();
    const session = await cartCheckout(undefined, { expires_in_minutes: 1, reference: 'ORD-EXP' });
    expect(session.expires_at).toBe('2026-06-14T12:01:00.000Z');
    await advance('1m');

    expect(sentTypes()).toEqual(['checkout.expired']);
    expect(sent('checkout.expired')[0]!.body.data).toMatchObject({
      checkout_id: session.checkout_id,
      status: 'expired',
      payment_status: null,
      amount: '29.00',
      currency: 'USD',
      reference: 'ORD-EXP',
      charge: null,
      completed_at: null,
      expires_at: '2026-06-14T12:01:00.000000+00:00',
    });

    const after = await read(session.checkout_id);
    expect(after.status).toBe('expired');
    expect(after.payment_status).toBeNull();
    expect(after.charge).toBeNull();

    // The page refuses to take a payment now.
    const page = await pageGet(session.path);
    expect(page.body).toContain('This checkout has expired.');
  });

  it('a bank transfer still in flight expires with collection.failed EXPIRED and checkout.expired', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'NGN', amount: '75000.00' }, { expires_in_minutes: 1 });
    await pagePost(`${session.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });
    await advance('1m');

    expect(sent('collection.failed')).toHaveLength(1);
    expect(sent('collection.failed')[0]!.body.data).toMatchObject({
      status: 'EXPIRED',
      reason: 'Payment window expired before payment was received',
    });
    expect(sent('checkout.expired')).toHaveLength(1);
    const after = await read(session.checkout_id);
    expect(after.status).toBe('expired');
    expect(after.payment_status).toBeNull();
  });

  it('a failed card then expiry sends checkout.expired but no second collection.failed', async () => {
    await endpoint();
    const session = await cartCheckout(undefined, { expires_in_minutes: 1 });
    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4000000000000002' });
    expect(sent('collection.failed')).toHaveLength(1);
    await advance('1m');

    expect(sent('collection.failed')).toHaveLength(1);
    expect(sent('collection.failed')[0]!.body.data.status).toBe('FAILED');
    expect(sent('checkout.expired')).toHaveLength(1);
    expect((await read(session.checkout_id)).status).toBe('expired');
  });

  it('a late bank transfer completes an expired checkout, checkout.completed following checkout.expired', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'NGN', amount: '75000.00' }, { expires_in_minutes: 1 });
    await pagePost(`${session.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });
    await advance('1m');
    expect((await read(session.checkout_id)).status).toBe('expired');

    const expiredPage = await pageGet(session.path);
    expect(expiredPage.body).toContain('late_transfer');

    const late = await pagePost(`${session.path}/simulate`, { action: 'late_transfer' });
    expect(late.statusCode).toBe(200);
    const after = await read(session.checkout_id);
    expect(after.status).toBe('completed');
    expect(after.charge.status).toBe('succeeded');

    const types = sentTypes();
    expect(types.indexOf('checkout.expired')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('checkout.completed')).toBeGreaterThan(types.indexOf('checkout.expired'));
    expect(sent('collection.succeeded')).toHaveLength(1);
    expect(sent('checkout.completed')[0]!.body.data).toMatchObject({ status: 'completed', payment_status: 'paid' });
  });
});

/* ------------------------------ free and custom ----------------------------- */

describe('free checkout', () => {
  it('completes with checkout.completed only: no_payment_required, amount "0", no charge', async () => {
    await endpoint();
    const session = await checkout({ pricing: { currency: 'USD', price_type: 'free' } });

    const page = await pageGet(session.path);
    expect(page.body).toContain('/identify');

    const identified = await pagePost(`${session.path}/identify`, { email: 'guest@example.com', name: 'Guest Buyer' });
    expect(identified.body).toContain('/complete');
    const completed = await pagePost(`${session.path}/complete`, {});
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toContain('Order complete. Nothing was due.');

    expect(sentTypes()).toEqual(['checkout.completed']);
    expect(sent('checkout.completed')[0]!.body.data).toMatchObject({
      checkout_id: session.checkout_id,
      status: 'completed',
      payment_status: 'no_payment_required',
      amount: '0',
      currency: 'USD',
      customer: null,
      customer_details: { email: 'guest@example.com', name: 'Guest Buyer' },
      charge: null,
      completed_at: '2026-06-14T12:00:00.000000+00:00',
    });

    const after = await read(session.checkout_id);
    expect(after.status).toBe('completed');
    expect(after.charge).toBeNull();
    expect(after.completed_at).toBe(START);
    expect((await get('/v1/payments')).json().pagination.total).toBe(0);
  });

  it('a free catalog product completes the same way', async () => {
    await endpoint();
    const { id } = await product({ currency: 'USD', price_type: 'free' });
    const session = await checkout({ product_cart: [{ product_id: id }], customer: JANE });
    await pagePost(`${session.path}/complete`, {});
    expect(sentTypes().filter((type) => type.startsWith('collection.'))).toEqual([]);
    expect(sent('checkout.completed')).toHaveLength(1);
    expect(sent('checkout.completed')[0]!.body.data).toMatchObject({ payment_status: 'no_payment_required', amount: '0', charge: null });
    expect(sent('collection.succeeded')).toHaveLength(0);
    expect((await read(session.checkout_id)).status).toBe('completed');
  });
});

describe('pay what you want', () => {
  it('refuses an amount outside the bounds and charges one inside them', async () => {
    await endpoint();
    const session = await checkout({
      pricing: { currency: 'USD', price_type: 'custom', minimum_amount: '5.00', maximum_amount: '100.00' },
      customer: JANE,
    });

    const page = await pageGet(session.path);
    expect(page.body).toContain('/amount');

    const low = await pagePost(`${session.path}/amount`, { amount: '1.00' });
    expect(low.statusCode).toBe(200);
    expect(low.body).toContain('Choose an amount between 5.00 and 100.00.');
    const high = await pagePost(`${session.path}/amount`, { amount: '150.00' });
    expect(high.body).toContain('Choose an amount between 5.00 and 100.00.');

    // Paying before an amount is chosen is refused.
    const early = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(early.body).toContain('Choose an amount first.');

    const ok = await pagePost(`${session.path}/amount`, { amount: '20.00' });
    expect(ok.body).toContain('/pay');
    expect((await read(session.checkout_id)).amount).toBe('20.00');

    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await advance('1s');
    const done = await read(session.checkout_id);
    expect(done.status).toBe('completed');
    expect(done.charge).toMatchObject({ status: 'succeeded', amount: '20.00', fees: { amount: '1.40', currency: 'USD' } });
    expect(sent('collection.succeeded')[0]?.body.data).toMatchObject({ amount: '20.00', product_cart: null });
  });
});

/* ------------------------------- guest checkout ----------------------------- */

describe('guest checkout', () => {
  it('asks a guest for their identity before taking payment', async () => {
    const session = await cartCheckout(undefined, { customer: undefined });
    const page = await pageGet(session.path);
    expect(page.body).toContain('/identify');
    const early = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(early.body).toContain('Enter your email address first.');
    expect((await read(session.checkout_id)).charge).toBeNull();
  });

  it("customer_creation 'always' turns the guest into a customer and sends customer.created", async () => {
    await endpoint();
    const { id } = await product();
    const session = await checkout({ product_cart: [{ product_id: id }], customer_creation: 'always' });
    await pagePost(`${session.path}/identify`, { email: 'guest@example.com', name: 'Guest Buyer' });

    expect(sent('customer.created')).toHaveLength(1);
    const customerId = (sent('customer.created')[0]!.body.data as { customer_id: string }).customer_id;
    expect(customerId).toMatch(/^cust_/);
    const after = await read(session.checkout_id);
    expect(after.customer).toEqual({ id: customerId, email: 'guest@example.com', name: 'Guest Buyer' });
    expect(after.customer_details).toEqual({ email: 'guest@example.com', name: 'Guest Buyer' });

    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await advance('1s');
    expect(sent('collection.succeeded')[0]?.body.data.customer).toEqual({
      id: customerId,
      email: 'guest@example.com',
      name: 'Guest Buyer',
    });
    expect((sent('checkout.completed')[0]?.body.data.customer as { customer_id: string }).customer_id).toBe(customerId);
  });

  it("the default 'if_required' keeps the guest on customer_details and sends no customer.* event", async () => {
    await endpoint();
    const { id } = await product();
    const session = await checkout({ product_cart: [{ product_id: id }] });
    await pagePost(`${session.path}/identify`, { email: 'guest@example.com', name: 'Guest Buyer' });

    const after = await read(session.checkout_id);
    expect(after.customer.id).toBeNull();
    expect(after.customer_details).toEqual({ email: 'guest@example.com', name: 'Guest Buyer' });

    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    await advance('1s');
    expect(sent('customer.created')).toHaveLength(0);
    expect(sent('customer.updated')).toHaveLength(0);
    expect(sent('collection.succeeded')[0]?.body.data.customer).toEqual({
      id: null,
      email: 'guest@example.com',
      name: 'Guest Buyer',
    });
    expect(sent('checkout.completed')[0]?.body.data).toMatchObject({
      customer: null,
      customer_details: { email: 'guest@example.com', name: 'Guest Buyer' },
    });
    expect((await get('/v1/customers')).json().pagination.total).toBe(0);
  });
});

/* ------------------------------- double submit ------------------------------ */

describe('double submit', () => {
  it('refuses a second payment while the first card attempt is processing; one charge results', async () => {
    await endpoint();
    const session = await cartCheckout();
    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    const again = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('A payment attempt is already in progress.');

    await advance('1s');
    expect((await read(session.checkout_id)).status).toBe('completed');
    expect((await get('/v1/payments')).json().pagination.total).toBe(1);
    expect((await context.storage.payments.list({ provider: 'bachs', limit: 10, offset: 0 })).items).toHaveLength(1);
    expect(sent('collection.succeeded')).toHaveLength(1);
    expect(sent('checkout.completed')).toHaveLength(1);
  });
});

/* ------------------------------ paybox tooling ------------------------------ */

describe('generic paybox tooling', () => {
  it('a payment settled through the control API reads as a completed checkout', async () => {
    await endpoint();
    const session = await cartCheckout({ currency: 'NGN', amount: '75000.00' });
    await pagePost(`${session.path}/pay`, { corridor: 'NGN_BANK_TRANSFER' });

    const list = await app.inject({ method: 'GET', url: '/api/payments?provider=bachs' });
    const items = list.json().items as Array<{ id: string; reference: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.reference).toBe(session.checkout_id);

    const simulated = await app.inject({
      method: 'POST',
      url: `/api/payments/${items[0]!.id}/simulate`,
      payload: { outcome: 'success' },
    });
    expect(simulated.statusCode).toBe(200);
    await flush();

    const after = await read(session.checkout_id);
    expect(after.status).toBe('completed');
    expect(after.payment_status).toBe('succeeded');
    expect(after.charge.status).toBe('succeeded');
    expect(sent('collection.succeeded')).toHaveLength(1);
    expect(sent('collection.succeeded')[0]!.body.data).toMatchObject({ status: 'SUCCEEDED', charge_id: after.charge.payment_id });
    expect(sent('checkout.completed')).toHaveLength(1);
  });
});

/* -------------------------------- determinism ------------------------------- */

describe('determinism', () => {
  /** One card checkout in a context of its own; returns what reached the endpoint. */
  async function run(options: { extraRead?: boolean } = {}) {
    const ownTransport = new RecordingTransport();
    const { config } = loadConfig();
    const ownContext = await buildContext({ config, transport: ownTransport, logSink: () => {} });
    const ownApp = await buildApp(ownContext);
    await ownApp.ready();
    try {
      const headers = { authorization: `Bearer ${ownContext.bachsKeys.secretKey}`, 'content-type': 'application/json' };
      const call = (method: 'GET' | 'POST', url: string, body?: unknown) =>
        ownApp.inject({ method, url: `/bachs${url}`, headers, ...(body ? { payload: body as object } : {}) });
      await call('POST', '/v1/webhooks/endpoints', {
        name: 'Local receiver',
        url: 'https://merchant.example.com/webhooks/bachs',
        event_types: ['checkout.completed', 'collection.succeeded'],
      });
      const prod = (await call('POST', '/v1/products', { name: 'Pro plan', price: { currency: 'USD', amount: '29.00' } })).json();
      const session = (
        await call('POST', '/v1/checkout-sessions', { product_cart: [{ product_id: prod.id }], customer: JANE, reference: 'det-1' })
      ).json();
      // A client polling its own checkout is a read; it must not move anything.
      if (options.extraRead) await call('GET', `/v1/checkout-sessions/${session.checkout_id}`);
      await ownApp.inject({
        method: 'POST',
        url: `${pathOf(session.checkout_url)}/pay`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ corridor: 'USD_CARD', card_number: '4242424242424242' }).toString(),
      });
      await ownApp.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1s' } });
      const done = (await call('GET', `/v1/checkout-sessions/${session.checkout_id}`)).json();
      return {
        checkoutId: session.checkout_id as string,
        chargeId: done.charge.payment_id as string,
        deliveries: ownTransport.sent.map((request) => ({
          body: request.body,
          timestamp: request.headers[BACHS_TIMESTAMP_HEADER],
          signature: request.headers[BACHS_SIGNATURE_HEADER],
          signatureV2: request.headers[BACHS_SIGNATURE_V2_HEADER],
        })),
      };
    } finally {
      await ownApp.close();
      await ownContext.shutdown();
    }
  }

  it('the same seed and flow produce byte-identical webhook bodies and signatures', async () => {
    const first = await run();
    const second = await run();
    expect(first.deliveries).toHaveLength(2);
    expect(second).toEqual(first);
    for (const delivery of first.deliveries) {
      expect(delivery.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(delivery.timestamp).toBe(String(Date.parse('2026-06-14T12:00:01.000Z') / 1000));
    }
  });

  it('an extra read between steps does not shift the ids that follow', async () => {
    // CLAUDE.md, "Time and determinism": each subsystem takes its own labelled
    // stream so unrelated activity cannot shift the id stream.
    const quiet = await run();
    const polled = await run({ extraRead: true });
    expect(polled.checkoutId).toBe(quiet.checkoutId);
    expect(polled.chargeId).toBe(quiet.chargeId);
  });
});

/* ----------------------------------- reset ---------------------------------- */

describe('paybox reset', () => {
  it('a reset mid-session removes the checkout; reading it is a Bachs 404', async () => {
    await endpoint();
    const session = await cartCheckout();
    await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: '4242424242424242' });

    const reset = await app.inject({ method: 'POST', url: '/api/reset' });
    expect(reset.statusCode).toBe(200);

    const gone = await get(`/v1/checkout-sessions/${session.checkout_id}`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({
      detail: 'Checkout session not found',
      error_code: 'NOT_FOUND',
      doc_url: 'https://docs.bachs.io/api-reference/error-reference#general',
    });
    const page = await pageGet(session.path);
    expect(page.statusCode).toBe(404);

    // The settle job queued before the reset went with it.
    await advance('1s');
    expect(sent('collection.succeeded')).toHaveLength(0);
  });
});

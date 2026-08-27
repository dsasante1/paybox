import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Charge channels and dedicated virtual accounts.
 *
 * Request shapes verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27 (`ChargeCreate`
 * with its `USSD`/`EFT` variants, `DedicatedVirtualAccountCreate`,
 * `DedicatedVirtualAccountAssign`).
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'channels';
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

async function charge(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: { email: 'dev@example.com', amount: 40_000, currency: 'NGN', ...payload },
  });
}

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function verify(reference: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${reference}`,
    headers: auth,
  });
  return res.json().data;
}

/** Register a webhook sink and return the event names it received. */
async function withWebhooks() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: { url: 'http://localhost:9999/hook' },
  });
  return () =>
    transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
}

describe('USSD', () => {
  it('parks the charge and returns a dial code', async () => {
    const res = await charge({ ussd: { type: '737' } });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe('pay_offline');
    expect(data.ussd_code).toContain('737');
    // Awaiting a customer action out of band, not processing.
    expect((await verify(data.reference)).status).toBe('ongoing');
    expect((await verify(data.reference)).channel).toBe('ussd');
  });

  it('settles when virtual time advances', async () => {
    const reference = (await charge({ ussd: { type: '919' } })).json().data.reference;
    await advance('30s');
    expect((await verify(reference)).status).toBe('success');
  });

  it('rejects a USSD code outside the documented enum', async () => {
    const res = await charge({ ussd: { type: '999' } });
    expect(res.json().status).toBe(false);
  });

  it('honours the paybox_outcome metadata escape hatch', async () => {
    // USSD carries no digits to select an outcome from, so the outcome is
    // named directly. This is emulator-specific, not Paystack behaviour.
    const reference = (
      await charge({
        ussd: { type: '737' },
        metadata: { paybox_outcome: 'insufficient_funds' },
      })
    ).json().data.reference;

    await advance('30s');
    const transaction = await verify(reference);
    expect(transaction.status).toBe('failed');
    expect(transaction.gateway_response).toBe('Insufficient funds');
  });

  it('ignores an unrecognised paybox_outcome rather than failing the charge', async () => {
    const reference = (
      await charge({ ussd: { type: '737' }, metadata: { paybox_outcome: 'nonsense' } })
    ).json().data.reference;

    await advance('30s');
    expect((await verify(reference)).status).toBe('success');
  });
});

describe('EFT', () => {
  it('parks the charge awaiting the customer', async () => {
    const res = await charge({ eft: { provider: 'ozow' }, currency: 'ZAR' });

    expect(res.json().data.status).toBe('pay_offline');
    const transaction = await verify(res.json().data.reference);
    expect(transaction.status).toBe('ongoing');
    expect(transaction.channel).toBe('eft');
  });
});

describe('channel validation', () => {
  it('rejects a charge with no channel', async () => {
    const res = await charge({});
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/mobile_money, card, bank, ussd or eft/);
  });

  it('rejects two channels at once rather than silently picking one', async () => {
    const res = await charge({
      ussd: { type: '737' },
      card: { number: '4000000000000000' },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/exactly one channel/);
  });
});

describe('dedicated virtual accounts', () => {
  async function createCustomer() {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/customer',
      headers: auth,
      payload: { email: 'dva@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    });
    return res.json().data.customer_code as string;
  }

  it('mints an account for an existing customer', async () => {
    const events = await withWebhooks();
    const customerCode = await createCustomer();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload: { customer: customerCode, preferred_bank: 'titan-paystack' },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.account_number).toMatch(/^\d{10}$/);
    expect(data.account_name).toBe('Ada Lovelace');
    expect(data.bank.slug).toBe('titan-paystack');
    expect(data.assigned).toBe(true);

    await advance('1s');
    expect(events()).toContain('dedicatedaccount.assign.success');
  });

  it('assign creates the customer and the account in one call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account/assign',
      headers: auth,
      payload: {
        email: 'assigned@example.com',
        first_name: 'Grace',
        last_name: 'Hopper',
        phone: '+2348100000000',
        preferred_bank: 'wema-bank',
        country: 'NG',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.bank.slug).toBe('wema-bank');
    const customer = await context.storage.customers.byEmail('paystack', 'assigned@example.com');
    expect(customer).not.toBeNull();
  });

  it('emits assign.failed for an unavailable bank', async () => {
    const events = await withWebhooks();
    const customerCode = await createCustomer();

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload: { customer: customerCode, preferred_bank: 'not-a-bank' },
    });

    expect(res.json().status).toBe(false);
    await advance('1s');
    expect(events()).toContain('dedicatedaccount.assign.failed');
  });

  it('returns one account per customer rather than minting duplicates', async () => {
    const customerCode = await createCustomer();
    const payload = { customer: customerCode, preferred_bank: 'titan-paystack' };

    const first = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload,
    });

    expect(second.json().data.account_number).toBe(first.json().data.account_number);
    expect((await context.storage.dedicatedAccounts.list()).total).toBe(1);
  });

  it('lists the available providers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/paystack/dedicated_account/available_providers',
      headers: auth,
    });
    expect(res.json().data.map((p: { provider_slug: string }) => p.provider_slug)).toContain(
      'titan-paystack',
    );
  });

  it('credits an inbound transfer and fires charge.success', async () => {
    const events = await withWebhooks();
    const customerCode = await createCustomer();
    const created = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload: { customer: customerCode },
    });
    const accountNumber = created.json().data.account_number as string;

    const credit = await app.inject({
      method: 'POST',
      url: `/api/dedicated-accounts/${accountNumber}/credit`,
      payload: { amount: 250_000 },
    });

    expect(credit.statusCode).toBe(201);
    expect(credit.json().status).toBe('successful');
    expect(credit.json().paymentMethod).toBe('bank_transfer');

    await advance('1s');
    expect(events()).toContain('charge.success');
  });

  it('refuses a credit with a non-positive amount', async () => {
    const customerCode = await createCustomer();
    const created = await app.inject({
      method: 'POST',
      url: '/paystack/dedicated_account',
      headers: auth,
      payload: { customer: customerCode },
    });

    // Address it by account number: the serialised `id` is Paystack's numeric
    // form, not the canonical id, so using that would 404 before ever
    // reaching the amount check this test is about.
    const res = await app.inject({
      method: 'POST',
      url: `/api/dedicated-accounts/${created.json().data.account_number}/credit`,
      payload: { amount: 0 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().message).toMatch(/positive integer amount/);
  });
});

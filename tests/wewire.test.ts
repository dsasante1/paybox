import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  isValidIban,
  isValidRoutingNumber,
  verifyWewireSignature,
  wewireSignatureHeaders,
  WEWIRE_SIGNATURE_HEADER,
  WEWIRE_TIMESTAMP_HEADER,
} from '@paybox/wewire';

/**
 * WeWire: payouts, the Ghana corridor, beneficiary validation and Standard
 * Webhooks.
 *
 * Shapes transcribed from docs.wewire.com, read 2026-08-29. Coverage is
 * documented in docs/wewire.md.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-05-01T00:00:00.000Z';
  process.env.PAYBOX_SEED = 'wewire';
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

const key = () => context.wewireKeys.secretKey;

/** The key goes in `ww-api-key`, verbatim, with no `Bearer` prefix. */
const auth = () => ({ 'ww-api-key': key(), 'content-type': 'application/json' });

const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/wewire${url}`, headers: auth(), payload: body as object });

const patch = (url: string, body: unknown) =>
  app.inject({ method: 'PATCH', url: `/wewire${url}`, headers: auth(), payload: body as object });

const get = (url: string) =>
  app.inject({ method: 'GET', url: `/wewire${url}`, headers: { 'ww-api-key': key() } });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

/** A valid SEPA beneficiary. The IBAN passes a real mod-97 check. */
const SEPA_BENEFICIARY = {
  type: 'INDIVIDUAL',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  country: 'DEU',
  accountDetails: {
    settlementRail: 'SEPA',
    currency: 'EUR',
    iban: 'DE89370400440532013000',
  },
};

/**
 * paybox opens every platform balance with a configured float (spec §24), so
 * a test that wants exact numbers has to measure against it rather than
 * assume zero.
 */
async function walletBalance(currency: string, subCustomerId?: string): Promise<number> {
  const response = await get(
    subCustomerId ? `/v1/subcustomers/${subCustomerId}/wallets` : '/v1/wallets',
  );
  const wallet = response
    .json()
    .data.find((row: { currency: string }) => row.currency === currency);
  return wallet ? (wallet.balance as number) : 0;
}

async function fundWallet(currency: string, amount: number): Promise<number> {
  const response = await post('/paybox/wallets/credit', { currency, amount });
  expect(response.statusCode).toBe(200);
  return walletBalance(currency);
}

async function createBeneficiary(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await post('/v1/beneficiaries', { ...SEPA_BENEFICIARY, ...overrides });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return body.accounts[0].id as string;
}

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

describe('authentication', () => {
  it('reads the key from ww-api-key with no Bearer prefix', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/wewire/v1/wallets',
      headers: { 'ww-api-key': key() },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a bearer token, because WeWire would', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/wewire/v1/wallets',
      headers: { authorization: `Bearer ${key()}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_TOKEN_MISSING');
    expect(response.json().success).toBe(false);
  });

  it('refuses a live key and says so (spec §29)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/wewire/v1/wallets',
      headers: { 'ww-api-key': 'sk_live_notarealkey' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('live WeWire API key');
  });
});

/* ------------------------------------------------------------------ *
 * Beneficiaries
 * ------------------------------------------------------------------ */

describe('beneficiaries', () => {
  it('validates the IBAN checksum, not just its shape', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    // One transposed digit: right length, right country, wrong checksum.
    expect(isValidIban('DE89370400440532013001')).toBe(false);
  });

  it('validates the ABA routing checksum', () => {
    expect(isValidRoutingNumber('021000021')).toBe(true);
    expect(isValidRoutingNumber('021000022')).toBe(false);
  });

  it('rejects a bad IBAN with a 400 naming the field', async () => {
    const response = await post('/v1/beneficiaries', {
      ...SEPA_BENEFICIARY,
      accountDetails: { settlementRail: 'SEPA', currency: 'EUR', iban: 'DE89370400440532013001' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toContain('checksum');
  });

  it('refuses a rail that does not settle in the account currency', async () => {
    const response = await post('/v1/beneficiaries', {
      ...SEPA_BENEFICIARY,
      accountDetails: { settlementRail: 'SEPA', currency: 'GBP', iban: 'DE89370400440532013000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('settles in EUR');
  });

  it('requires firstName and lastName for an individual', async () => {
    const response = await post('/v1/beneficiaries', {
      type: 'INDIVIDUAL',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      accountDetails: SEPA_BENEFICIARY.accountDetails,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details[0].field).toBe('name');
  });

  it('adds a second account on another rail to the same beneficiary', async () => {
    const created = await post('/v1/beneficiaries', SEPA_BENEFICIARY);
    const beneficiaryId = created.json().id as string;

    const added = await post(`/v1/beneficiaries/${beneficiaryId}/accounts`, {
      settlementRail: 'FPS',
      currency: 'GBP',
      sortCode: '040004',
      accountNumber: '12345678',
    });
    expect(added.statusCode).toBe(201);

    const listed = await get(`/v1/beneficiaries/${beneficiaryId}/accounts`);
    expect(listed.json().totalItems).toBe(2);
    expect(listed.json().data.map((a: { currency: string }) => a.currency).sort()).toEqual([
      'EUR',
      'GBP',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Payouts
 * ------------------------------------------------------------------ */

describe('offshore payouts', () => {
  it('returns a PENDING wallet transaction in WeWire’s shape', async () => {
    const opening = await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();

    const response = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-1',
      from: 'EUR',
      to: 'EUR',
      amount: 2500,
      beneficiaryAccountId: accountId,
      description: 'Q2 vendor payment',
      reference: 'INV-2026-0412',
      purposeCode: 'POP007',
      feeBearer: 'SELF',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Every field WeWire's published example carries.
    expect(Object.keys(body).sort()).toEqual(
      [
        'amount',
        'balanceAfter',
        'balanceBefore',
        'channel',
        'createdAt',
        'currency',
        'description',
        'fee',
        'id',
        'idempotencyKey',
        'purpose',
        'reference',
        'settledAt',
        'status',
        'subCustomerId',
        'type',
        'updatedAt',
      ].sort(),
    );
    expect(body.status).toBe('PENDING');
    expect(body.type).toBe('DEBIT');
    expect(body.channel).toBe('AUTOMATED_PAYOUT');
    expect(body.amount).toBe(2500);
    expect(body.purpose).toBe('POP007');
    expect(body.settledAt).toBeNull();
    // The balance window is folded from the ledger, so it is exact.
    expect(body.balanceBefore).toBe(opening);
    expect(body.balanceAfter).toBe(opening - 2500);
  });

  it('settles under a time advance and reports SUCCESSFUL', async () => {
    await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();
    const created = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-2',
      from: 'EUR',
      to: 'EUR',
      amount: 1000,
      beneficiaryAccountId: accountId,
      description: 'Vendor',
      purposeCode: 'POP007',
    });
    const id = created.json().id as string;

    await advance('30s');

    const fetched = await get(`/v1/transactions/${id}`);
    expect(fetched.json().status).toBe('SUCCESSFUL');
    expect(fetched.json().settledAt).not.toBeNull();
  });

  it('rejects a reference Faster Payments would not carry', async () => {
    await fundWallet('GBP', 5000);
    const created = await post('/v1/beneficiaries', {
      type: 'BUSINESS',
      name: 'Acme Ltd',
      email: 'ap@acme.example',
      accountDetails: {
        settlementRail: 'FPS',
        currency: 'GBP',
        sortCode: '040004',
        accountNumber: '12345678',
      },
    });
    const accountId = created.json().accounts[0].id as string;

    const response = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-3',
      from: 'GBP',
      to: 'GBP',
      amount: 100,
      beneficiaryAccountId: accountId,
      description: 'Invoice',
      // Underscores and parentheses are legal on SEPA, not on FPS.
      reference: 'payment_q2 (urgent)',
      purposeCode: 'POP007',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Faster Payments');
  });

  it('accepts the same reference on SEPA', async () => {
    await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();
    const response = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-4',
      from: 'EUR',
      to: 'EUR',
      amount: 100,
      beneficiaryAccountId: accountId,
      description: 'Invoice',
      reference: 'payment_q2 (urgent)',
      purposeCode: 'POP007',
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a payout larger than the wallet', async () => {
    const balance = await fundWallet('EUR', 100);
    const accountId = await createBeneficiary();
    const response = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-5',
      from: 'EUR',
      to: 'EUR',
      amount: balance + 1,
      beneficiaryAccountId: accountId,
      description: 'Too much',
      purposeCode: 'POP007',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('requires description and purposeCode offshore', async () => {
    await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();
    const response = await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'payout-6',
      from: 'EUR',
      to: 'EUR',
      amount: 100,
      beneficiaryAccountId: accountId,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('description is required');
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency — a body field, on three endpoints only
 * ------------------------------------------------------------------ */

describe('idempotency', () => {
  const payout = (accountId: string, amount: number) => ({
    idempotencyKey: 'same-key',
    from: 'EUR' as const,
    to: 'EUR' as const,
    amount,
    beneficiaryAccountId: accountId,
    description: 'Vendor',
    purposeCode: 'POP007',
  });

  it('replays the original response for the same key and body', async () => {
    await fundWallet('EUR', 10_000);
    const accountId = await createBeneficiary();

    const first = await post('/v1/transactions/initiate-payout', payout(accountId, 500));
    const second = await post('/v1/transactions/initiate-payout', payout(accountId, 500));

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    // And exactly one payout was actually created.
    const listed = await get('/v1/transactions?type=DEBIT');
    expect(listed.json().totalItems).toBe(1);
  });

  it('is a 409 when the same key carries a different body', async () => {
    await fundWallet('EUR', 10_000);
    const accountId = await createBeneficiary();

    await post('/v1/transactions/initiate-payout', payout(accountId, 500));
    const conflict = await post('/v1/transactions/initiate-payout', payout(accountId, 900));

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('RESOURCE_ALREADY_EXISTS');
  });
});

/* ------------------------------------------------------------------ *
 * Ghana corridor
 * ------------------------------------------------------------------ */

describe('the Ghana corridor', () => {
  const collection = (accountNumber: string, accountCode = 'MTN') => ({
    idempotencyKey: `collect-${accountNumber}`,
    amount: 100,
    currency: 'GHS',
    channel: 'MOBILE_MONEY',
    accountCode,
    accountNumber,
    accountName: 'Jane Mensah',
    // Distinct per number: paybox enforces one payment per reference per
    // provider, which WeWire does not document but which is the engine's
    // behaviour for every adapter. docs/wewire.md records it.
    reference: `INV-${accountNumber}`,
    memo: 'Invoice 10045',
  });

  it('accepts a collection with 202 and a PENDING body', async () => {
    const response = await post('/v1/collections', collection('0240000001'));
    expect(response.statusCode).toBe(202);

    const body = response.json();
    expect(body.status).toBe('PENDING');
    expect(body.type).toBe('COLLECTION');
    // Money is a *string* on the Africa objects, a number on wallet ones.
    expect(body.amount).toBe('100.00');
    expect(body.fee).toBe('0.00');
    expect(body.destination).toEqual({
      accountCode: 'MTN',
      accountNumber: '0240000001',
      accountName: 'Jane Mensah',
    });
    // `reason` and `occurredAt` are webhook-only fields.
    expect(body).not.toHaveProperty('reason');
    expect(body).not.toHaveProperty('occurredAt');
  });

  it('drives the published sandbox numbers to their documented outcomes', async () => {
    const success = await post('/v1/collections', collection('0240000001'));
    const failure = await post('/v1/collections', collection('0240000002'));
    await advance('30s');

    const settled = await get(`/v1/transactions/${success.json().id}`);
    const declined = await get(`/v1/transactions/${failure.json().id}`);
    expect(settled.json().status).toBe('SUCCESSFUL');
    expect(declined.json().status).toBe('FAILED');
  });

  it('will not inherit an outcome when the network does not match the number', async () => {
    // 0240000002 is MTN's failure number; sent as VOD it is just a number.
    const response = await post('/v1/collections', collection('0240000002', 'VOD'));
    await advance('30s');
    const settled = await get(`/v1/transactions/${response.json().id}`);
    expect(settled.json().status).toBe('SUCCESSFUL');
  });

  it('refuses a bank collection with WeWire’s own message', async () => {
    const response = await post('/v1/collections', {
      ...collection('0240000001'),
      channel: 'BANK',
      accountCode: 'GCB',
      accountNumber: '1234567890123',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      'This currency and channel combination is not supported yet.',
    );
  });

  it('enforces the 10-digit mobile-money rule verbatim', async () => {
    const response = await post('/v1/collections', collection('024412345'));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      'accountNumber must be a 10-digit mobile money number',
    );
  });

  it('rejects an unknown account code', async () => {
    const response = await post('/v1/collections', collection('0240000001', 'XXX'));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('Unknown account code for this channel.');
  });

  it('disburses to a bank and debits the wallet immediately', async () => {
    const opening = await fundWallet('GHS', 1000);
    const response = await post('/v1/disbursements', {
      idempotencyKey: 'disburse-1',
      amount: 500,
      currency: 'GHS',
      channel: 'BANK',
      accountCode: 'GCB',
      accountNumber: '1234567890123',
      accountName: 'Acme Ltd',
      reference: 'PO-5582-2',
      memo: 'Vendor settlement',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().type).toBe('DISBURSEMENT');

    // "The gross amount is debited from your balance immediately."
    expect(await walletBalance('GHS')).toBe(opening - 500);
  });

  it('resolves a name deterministically on account lookup', async () => {
    const first = await get('/v1/account-lookup?currency=GHS&accountCode=MTN&accountNumber=0244123456');
    const second = await get('/v1/account-lookup?currency=GHS&accountCode=MTN&accountNumber=0244123456');
    expect(first.statusCode).toBe(200);
    expect(first.json().accountName).toBe(second.json().accountName);
    expect(first.json().accountName).toMatch(/^[A-Z]+ [A-Z]+$/);
  });
});

/* ------------------------------------------------------------------ *
 * Transactions
 * ------------------------------------------------------------------ */

describe('listing transactions', () => {
  it('pages in WeWire’s envelope and filters by type', async () => {
    await fundWallet('EUR', 10_000);
    const accountId = await createBeneficiary();
    for (const index of [1, 2, 3]) {
      await post('/v1/transactions/initiate-payout', {
        idempotencyKey: `list-${index}`,
        from: 'EUR',
        to: 'EUR',
        amount: 100,
        beneficiaryAccountId: accountId,
        description: `Payout ${index}`,
        purposeCode: 'POP007',
      });
    }
    await post('/v1/collections', {
      idempotencyKey: 'list-collect',
      amount: 50,
      currency: 'GHS',
      channel: 'MOBILE_MONEY',
      accountCode: 'MTN',
      accountNumber: '0240000001',
    });

    const debits = await get('/v1/transactions?type=DEBIT&page=1&limit=2');
    const body = debits.json();
    expect(Object.keys(body).sort()).toEqual([
      'currentPage',
      'data',
      'pageSize',
      'totalItems',
      'totalPages',
    ]);
    expect(body.totalItems).toBe(3);
    expect(body.totalPages).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.data.every((row: { type: string }) => row.type === 'DEBIT')).toBe(true);

    const credits = await get('/v1/transactions?type=CREDIT');
    expect(credits.json().totalItems).toBe(1);
  });

  it('is a 404 in WeWire’s envelope for an unknown transaction', async () => {
    const response = await get('/v1/transactions/nope');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'No transaction "nope".',
        statusCode: 404,
        paybox_code: 'not_found',
      },
    });
  });
});

/* ------------------------------------------------------------------ *
 * Rates and FX
 * ------------------------------------------------------------------ */

describe('rates', () => {
  it('quotes a bid below the ask', async () => {
    const response = await get('/v1/rates/USD-GHS');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pair).toBe('USD/GHS');
    expect(body.bid).toBeLessThan(body.ask);
  });

  it('is deterministic: the same seed gives the same rate', async () => {
    const first = await get('/v1/rates/USD-GHS');
    const second = await get('/v1/rates/USD-GHS');
    expect(first.json()).toEqual(second.json());
  });

  it('refuses a pair it has no rate for', async () => {
    const response = await get('/v1/rates/USD-XXX');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CURRENCY_NOT_SUPPORTED');
  });

  it('previews a conversion in integer-exact minor units', async () => {
    const response = await post('/v1/rates/conversion/preview', {
      from: 'USD',
      to: 'EUR',
      amount: 100,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rate).toBeGreaterThan(0);
    // The engine never converts; the adapter quotes and the amount is exact.
    expect(Number.isInteger(Math.round(body.convertedAmount * 100))).toBe(true);
    expect(body.fee).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Sub-customers
 * ------------------------------------------------------------------ */

describe('sub-customers', () => {
  it('creates one and keeps its wallet separate from the platform’s', async () => {
    const created = await post('/v1/subcustomers', {
      type: 'INDIVIDUAL',
      name: 'Kofi Mensah',
      email: 'kofi@example.com',
      country: 'GHA',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().kycStatus).toBe('APPROVED');

    const platformBalance = await fundWallet('USD', 100);
    await post('/paybox/wallets/credit', { currency: 'USD', amount: 250, subCustomerId: id });

    // A sub-customer's pot is its own: it gets no share of the platform's
    // opening float, and crediting it leaves the platform untouched.
    expect(await walletBalance('USD')).toBe(platformBalance);
    expect(await walletBalance('USD', id)).toBe(250);

    const sub = await get(`/v1/subcustomers/${id}/wallets`);
    expect(sub.json().data[0].subCustomerId).toBe(id);
  });

  it('archives one', async () => {
    const created = await post('/v1/subcustomers', {
      name: 'Acme Ltd',
      email: 'ap@acme.example',
      country: 'GHA',
      type: 'BUSINESS',
    });
    const archived = await patch(`/v1/subcustomers/${created.json().id}/archive`, {});
    expect(archived.json().status).toBe('ARCHIVED');
  });
});

/* ------------------------------------------------------------------ *
 * Webhooks — Standard Webhooks
 * ------------------------------------------------------------------ */

describe('webhooks', () => {
  /** Standard Webhooks secrets are `whsec_` + base64; the HMAC key is the
   *  decoded portion, which is the part integrations get wrong. */
  const SECRET = 'whsec_cGF5Ym94LXdld2lyZS10ZXN0LXNlY3JldA==';

  async function subscribe(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'https://example.test/hook', provider: 'wewire', secret: SECRET },
    });
    expect(response.statusCode).toBe(201);
    return response.json().secret as string;
  }

  it('signs with Standard Webhooks and verifies', async () => {
    const secret = await subscribe();
    await post('/v1/collections', {
      idempotencyKey: 'hook-1',
      amount: 100,
      currency: 'GHS',
      channel: 'MOBILE_MONEY',
      accountCode: 'MTN',
      accountNumber: '0240000001',
      memo: 'Invoice 1',
    });
    await advance('30s');

    const delivery = transport.sent.find(
      (call) => JSON.parse(call.body).eventType === 'collection.completed',
    );
    expect(delivery, 'a collection.completed delivery').toBeDefined();

    const headers = delivery!.headers as Record<string, string>;
    expect(headers['webhook-id']).toMatch(/^msg_/);
    expect(headers[WEWIRE_SIGNATURE_HEADER]).toMatch(/^v1,/);

    expect(
      verifyWewireSignature(headers, delivery!.body, secret, {
        now: Number(headers[WEWIRE_TIMESTAMP_HEADER]) * 1000,
      }),
    ).toBe(true);
  });

  it('refuses a signature outside the five-minute tolerance', () => {
    const body = JSON.stringify({ eventType: 'collection.completed', data: {} });
    const headers = wewireSignatureHeaders(body, 'whsec_dGVzdA==', 1_700_000_000_000);
    expect(
      verifyWewireSignature(headers, body, 'whsec_dGVzdA==', { now: 1_700_000_000_000 }),
    ).toBe(true);
    // Six minutes later, the same delivery must not verify.
    expect(
      verifyWewireSignature(headers, body, 'whsec_dGVzdA==', {
        now: 1_700_000_000_000 + 360_000,
      }),
    ).toBe(false);
  });

  it('accepts any of several signatures during a rotation', () => {
    const body = JSON.stringify({ eventType: 'x', data: {} });
    const now = 1_700_000_000_000;
    const current = wewireSignatureHeaders(body, 'whsec_bmV3', now);
    const old = wewireSignatureHeaders(body, 'whsec_b2xk', now);

    const rotating = {
      ...current,
      [WEWIRE_SIGNATURE_HEADER]: `${old[WEWIRE_SIGNATURE_HEADER]} ${current[WEWIRE_SIGNATURE_HEADER]}`,
    };
    expect(verifyWewireSignature(rotating, body, 'whsec_bmV3', { now })).toBe(true);
    expect(verifyWewireSignature(rotating, body, 'whsec_b2xk', { now })).toBe(true);
    expect(verifyWewireSignature(rotating, body, 'whsec_b3RoZXI=', { now })).toBe(false);
  });

  it('names the event by corridor, not by resource', async () => {
    await subscribe();
    await fundWallet('GHS', 1000);
    await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();

    await post('/v1/disbursements', {
      idempotencyKey: 'corridor-gh',
      amount: 100,
      currency: 'GHS',
      channel: 'MOBILE_MONEY',
      accountCode: 'VOD',
      accountNumber: '0201234567',
      accountName: 'Kofi Mensah',
    });
    await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'corridor-offshore',
      from: 'EUR',
      to: 'EUR',
      amount: 100,
      beneficiaryAccountId: accountId,
      description: 'Vendor',
      purposeCode: 'POP007',
    });
    await advance('30s');

    const names = transport.sent.map((call) => JSON.parse(call.body).eventType);
    // The same canonical transfer.successful, two different event names.
    expect(names).toContain('disbursement.completed');
    expect(names).toContain('transaction.status_updated');
  });

  it('uses transactionId, not id, on the webhook payload', async () => {
    await subscribe();
    await fundWallet('EUR', 5000);
    const accountId = await createBeneficiary();
    await post('/v1/transactions/initiate-payout', {
      idempotencyKey: 'shape-1',
      from: 'EUR',
      to: 'EUR',
      amount: 100,
      beneficiaryAccountId: accountId,
      description: 'Vendor',
      purposeCode: 'POP007',
    });
    await advance('30s');

    const delivery = transport.sent.find(
      (call) => JSON.parse(call.body).eventType === 'transaction.status_updated',
    );
    const data = JSON.parse(delivery!.body).data;
    expect(data).toHaveProperty('transactionId');
    expect(data).not.toHaveProperty('id');
    // And `PAYOUT`, where the API object says `AUTOMATED_PAYOUT`.
    expect(data.channel).toBe('PAYOUT');
    expect(data.walletId).toBe('wal_business_eur');
  });

  it('does not emit transaction.pay_in, which paybox cannot produce', async () => {
    await subscribe();
    await post('/v1/collections', {
      idempotencyKey: 'no-payin',
      amount: 100,
      currency: 'GHS',
      channel: 'MOBILE_MONEY',
      accountCode: 'MTN',
      accountNumber: '0240000001',
    });
    await advance('30s');

    const names = transport.sent.map((call) => JSON.parse(call.body).eventType);
    expect(names).not.toContain('transaction.pay_in');
  });

  it('reports a failure in WeWire’s wording, not the card simulator’s', async () => {
    await subscribe();
    await post('/v1/collections', {
      idempotencyKey: 'reason-1',
      amount: 100,
      currency: 'GHS',
      channel: 'MOBILE_MONEY',
      accountCode: 'MTN',
      // The published number that always fails.
      accountNumber: '0240000002',
    });
    await advance('30s');

    const delivery = transport.sent.find(
      (call) => JSON.parse(call.body).eventType === 'collection.failed',
    );
    const data = JSON.parse(delivery!.body).data;
    // "The card was declined by the issuer" is nonsense on a mobile-money
    // prompt; WeWire's documented reasons are these.
    expect(data.reason).toBe('Customer declined the prompt');
    expect(data.reason).not.toContain('card');
  });
});

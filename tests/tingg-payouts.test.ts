import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Tingg Payouts -- the BEEP API.
 *
 * Shapes transcribed from docs.tingg.africa/reference/postpayment,
 * /querypaymentstatus, /queryfloatbalance, /validateaccount and /querybill,
 * all read 2026-09-20.
 *
 * The property these tests exist to pin is that **nothing here is an HTTP
 * error**. Every documented failure at Tingg comes back 200 with a code in the
 * envelope, and a client written against that has no branch for anything else.
 */
let app: FastifyInstance;
let context: PayboxContext;

const BEEP = '/tingg/v1/global-api/payments';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'tingg-payouts';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });
  app = await buildApp(context);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const credentials = () => ({
  username: context.tinggKeys.payoutsUsername,
  password: context.tinggKeys.payoutsPassword,
});

const beep = (fn: string, packet: unknown[], overrides: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: BEEP,
    headers: { 'content-type': 'application/json' },
    payload: {
      function: fn,
      countryCode: 'KE',
      payload: { credentials: credentials(), packet },
      ...overrides,
    },
  });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

/** `amount` is a major-unit figure, the way Tingg's own sample quotes it. */
function packet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceCode: 'KE-RTGS-BANK-PAYOUT',
    MSISDN: '254712345678',
    accountNumber: '01234568765',
    payerTransactionID: 'PAYOUT-0001',
    amount: 1000,
    narration: 'purpose of this RTGS payout',
    currencyCode: 'KES',
    customerNames: 'John Doe',
    paymentMode: 'Online Payment',
    extraData: {
      destinationAccountName: 'John Doe',
      destinationAccountNo: '01234568765',
      destinationBank: 'Stanbic Bank',
      destinationBankCode: '0031',
    },
    ...overrides,
  };
}

describe('authentication', () => {
  it('answers 200 with authStatusCode 132 for a bad password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: BEEP,
      headers: { 'content-type': 'application/json' },
      payload: {
        function: 'BEEP.postPayment',
        countryCode: 'KE',
        payload: {
          credentials: { username: 'nobody', password: 'wrong' },
          packet: [packet()],
        },
      },
    });
    // Not a 401. BEEP puts the failure in the envelope, and a client written
    // against it would not know what to do with an HTTP error.
    expect(response.statusCode).toBe(200);
    expect(response.json().authStatus.authStatusCode).toBe(132);
    expect(response.json().results).toEqual([]);
  });

  it('answers 131 when the credentials are accepted', async () => {
    const response = await beep('BEEP.postPayment', [packet()]);
    expect(response.json().authStatus.authStatusCode).toBe(131);
  });

  it('answers 167 for an unknown function rather than 404', async () => {
    const response = await beep('BEEP.notAFunction', [packet()]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].statusCode).toBe(167);
  });
});

describe('BEEP.postPayment', () => {
  it('queues a payout and answers 139', async () => {
    const response = await beep('BEEP.postPayment', [packet()]);
    expect(response.statusCode).toBe(200);
    const [row] = response.json().results;
    expect(row.statusCode).toBe(139);
    expect(row.statusDescription).toBe(
      'Payment posted successfully and pending acknowledgement',
    );
    expect(row.payerTransactionID).toBe('PAYOUT-0001');
    expect(typeof row.beepTransactionID).toBe('number');
  });

  it('stores the amount in minor units', async () => {
    await beep('BEEP.postPayment', [packet()]);
    const transfer = await context.storage.transfers.byReference('tingg', 'PAYOUT-0001');
    expect(transfer?.amount).toBe(100_000);
    expect(transfer?.currency).toBe('KES');
  });

  it('reserves against the balance when queued, not when it settles', async () => {
    const before = await context.engine.getBalance('tingg', 'KES');
    await beep('BEEP.postPayment', [packet()]);
    const after = await context.engine.getBalance('tingg', 'KES');
    expect(before - after).toBe(100_000);
  });

  it('answers 230 when the float cannot cover the payout', async () => {
    const response = await beep('BEEP.postPayment', [
      packet({ payerTransactionID: 'PAYOUT-BIG', amount: 10_000_000 }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].statusCode).toBe(230);
    expect(response.json().results[0].statusDescription).toBe('Insufficient float balance');
  });

  it('echoes the original rather than queueing a second payout on a repeat', async () => {
    const first = await beep('BEEP.postPayment', [packet()]);
    const second = await beep('BEEP.postPayment', [packet()]);
    expect(second.json().results[0].beepTransactionID).toBe(
      first.json().results[0].beepTransactionID,
    );
  });

  it('answers one result per packet item, in order', async () => {
    const response = await beep('BEEP.postPayment', [
      packet({ payerTransactionID: 'P-1' }),
      packet({ payerTransactionID: 'P-2', amount: 10_000_000 }),
      packet({ payerTransactionID: 'P-3' }),
    ]);
    const results = response.json().results;
    expect(results).toHaveLength(3);
    // One bad item must not sink the rest -- a packet is a batch.
    expect(results.map((row: { statusCode: number }) => row.statusCode)).toEqual([139, 230, 139]);
  });

  it('settles the payout once the clock moves', async () => {
    await beep('BEEP.postPayment', [packet()]);
    await advance('10s');
    const transfer = await context.storage.transfers.byReference('tingg', 'PAYOUT-0001');
    expect(transfer?.status).toBe('successful');
  });

  it('fails a payout to an account ending 0000', async () => {
    await beep('BEEP.postPayment', [packet({ accountNumber: '01234560000' })]);
    await advance('10s');
    const transfer = await context.storage.transfers.byReference('tingg', 'PAYOUT-0001');
    expect(transfer?.status).toBe('failed');
  });
});

describe('BEEP.queryPaymentStatus', () => {
  it('reports a queued payout as 139 and a settled one as 183', async () => {
    await beep('BEEP.postPayment', [packet()]);

    const queued = await beep('BEEP.queryPaymentStatus', [
      { payerTransactionID: 'PAYOUT-0001' },
    ]);
    expect(queued.json().results[0].statusCode).toBe(139);

    await advance('10s');
    const settled = await beep('BEEP.queryPaymentStatus', [
      { payerTransactionID: 'PAYOUT-0001' },
    ]);
    expect(settled.json().results[0].statusCode).toBe(183);
    expect(settled.json().results[0].receiptNumber).toContain(
      String(settled.json().results[0].beepTransactionID),
    );
  });

  it('finds a payout by its beepTransactionID', async () => {
    const posted = await beep('BEEP.postPayment', [packet()]);
    const beepId = posted.json().results[0].beepTransactionID;

    const response = await beep('BEEP.queryPaymentStatus', [{ beepTransactionID: beepId }]);
    expect(response.json().results[0].payerTransactionID).toBe('PAYOUT-0001');
  });

  it('answers 174 for a payout that does not exist', async () => {
    const response = await beep('BEEP.queryPaymentStatus', [
      { payerTransactionID: 'NOPE' },
    ]);
    expect(response.json().results[0].statusCode).toBe(174);
  });
});

describe('BEEP.queryFloatBalance', () => {
  it('reads the same ledger a payout reserves against', async () => {
    const before = await beep('BEEP.queryFloatBalance', [
      { serviceCode: 'KE-BANK-PAYOUT', narration: 'float' },
    ]);
    expect(before.json().results[0].statusCode).toBe(418);
    expect(before.json().results[0].currencyCode).toBe('KES');
    const opening = before.json().results[0].balance;

    await beep('BEEP.postPayment', [packet()]);

    const after = await beep('BEEP.queryFloatBalance', [{ serviceCode: 'KE-BANK-PAYOUT' }]);
    // 1000 major units left the float, which is what 230 exists to catch.
    expect(opening - after.json().results[0].balance).toBe(1000);
  });
});

describe('BEEP.validateAccount', () => {
  it('answers 307 for a valid account', async () => {
    const response = await beep('BEEP.validateAccount', [
      { serviceCode: 'GH-DSTV', accountNumber: '260771000063' },
    ]);
    expect(response.json().results[0].statusCode).toBe(307);
    expect(response.json().results[0].active).toBe('yes');
  });

  it('answers 306 for an account ending 0000 and 301 for one ending 9999', async () => {
    const invalid = await beep('BEEP.validateAccount', [
      { serviceCode: 'GH-DSTV', accountNumber: '260771000000' },
    ]);
    expect(invalid.json().results[0].statusCode).toBe(306);

    const unavailable = await beep('BEEP.validateAccount', [
      { serviceCode: 'GH-DSTV', accountNumber: '260771009999' },
    ]);
    expect(unavailable.json().results[0].statusCode).toBe(301);
  });
});

describe('BEEP.queryBill', () => {
  it('answers 308 with a bill in major units', async () => {
    const response = await beep('BEEP.queryBill', [
      { serviceCode: 'TZ-VODA-REMITTANCE', accountNumber: '2022227', MSISDN: '254712345678' },
    ]);
    const row = response.json().results[0];
    expect(row.statusCode).toBe(308);
    expect(row.currency).toBe('KES');
    expect(typeof row.dueAmount).toBe('number');
    // Tingg stamps a bare date-time, not ISO 8601 with a T and a Z.
    expect(row.dueDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('quotes the same bill for the same account every time', async () => {
    const first = await beep('BEEP.queryBill', [
      { serviceCode: 'TZ-VODA', accountNumber: '2022227' },
    ]);
    const second = await beep('BEEP.queryBill', [
      { serviceCode: 'TZ-VODA', accountNumber: '2022227' },
    ]);
    expect(first.json().results[0].dueAmount).toBe(second.json().results[0].dueAmount);
  });
});

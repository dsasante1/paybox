import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { paystackInstrumentResolver } from '@paybox/paystack';
import { resolveInstrument } from '@paybox/simulator';

/**
 * Paystack's own published test instruments.
 *
 * Transcribed from <https://paystack.com/docs/payments/test-payments/>, read
 * 2026-08-28. These are the numbers a developer will already have copied out
 * of Paystack's documentation, so the emulator has to reproduce them --
 * especially the declining one.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'published';
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

const auth = { authorization: 'Bearer sk_test_local_suite' };

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function charge(number: string, email = 'dev@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email,
      amount: 100_000,
      currency: 'NGN',
      card: { number, expiry_month: '08', expiry_year: '27' },
    },
  });
  await advance('30s');
  const verified = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${res.json().data.reference}`,
    headers: auth,
  });
  return verified.json().data;
}

describe('the resolver itself', () => {
  it('recognises Paystack cards however they are spaced', () => {
    for (const written of [
      '4084 0800 0000 5408',
      '4084080000005408',
      '4084-0800-0000-5408',
    ]) {
      expect(paystackInstrumentResolver(written, 'card')?.outcome).toBe('declined');
    }
  });

  it('returns null for anything Paystack does not publish', () => {
    // paybox's own synthetic numbers must keep falling through to the generic
    // suffix convention rather than being swallowed by the provider table.
    expect(paystackInstrumentResolver('4000000000000002', 'card')).toBeNull();
  });

  it('lets the provider table win over the generic suffix convention', () => {
    // Last four of the declining Paystack card is 5408, which the suffix
    // table knows nothing about -- so without the resolver this is a success.
    expect(resolveInstrument('4084080000005408', 'card').outcome).toBe('success');
    expect(
      resolveInstrument('4084080000005408', 'card', {
        resolver: paystackInstrumentResolver,
      }).outcome,
    ).toBe('declined');
  });

  it('still honours the paybox_outcome override', () => {
    expect(
      resolveInstrument('4084084084084081', 'card', {
        resolver: paystackInstrumentResolver,
        override: 'insufficient_funds',
      }).outcome,
    ).toBe('insufficient_funds');
  });
});

describe('over the API', () => {
  it('DECLINES the card Paystack documents as declined', async () => {
    // The regression this whole change exists for: before the provider table,
    // this produced a *successful* payment, turning a developer's failure test
    // into a silent pass.
    const transaction = await charge('4084 0800 0000 5408');

    expect(transaction.status).toBe('failed');
    expect(transaction.gateway_response).toBe('Declined');
  });

  it('succeeds on the card Paystack documents as successful', async () => {
    const transaction = await charge('4084 0840 8408 4081');
    expect(transaction.status).toBe('success');
    expect(transaction.authorization.reusable).toBe(true);
  });

  it('reports insufficient funds on the card documented for it', async () => {
    const transaction = await charge('4084 0800 0067 0037', 'nsf@example.com');
    expect(transaction.status).toBe('failed');
    expect(transaction.gateway_response).toBe('Insufficient funds');
    expect(transaction.gateway_response_code).toBe('insufficient_funds');
    expect(transaction.response_code).toBe('51');
  });

  it('parks the PIN + OTP card awaiting a customer action', async () => {
    const transaction = await charge('5060 6666 6666 6666 666', 'otp@example.com');
    expect(transaction.status).toBe('ongoing');

    // And Paystack's documented PIN and OTP for that card complete it.
    const pin = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_pin',
      headers: auth,
      payload: { pin: '1234', reference: transaction.reference },
    });
    expect(pin.json().data.status).toBe('send_otp');

    const otp = await app.inject({
      method: 'POST',
      url: '/paystack/charge/submit_otp',
      headers: auth,
      payload: { otp: '123456', reference: transaction.reference },
    });
    expect(otp.json().data.status).toBe('success');
  });

  it('recognises the published mobile-money number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'momo@example.com',
        amount: 50_000,
        currency: 'GHS',
        mobile_money: { phone: '055 123 498 7', provider: 'mtn' },
      },
    });
    await advance('30s');
    const verified = await app.inject({
      method: 'GET',
      url: `/paystack/transaction/verify/${res.json().data.reference}`,
      headers: auth,
    });
    expect(verified.json().data.status).toBe('success');
  });

  it('leaves the paybox synthetic cards working as before', async () => {
    expect((await charge('4000 0000 0000 0002', 'own@example.com')).status).toBe('failed');
    expect((await charge('4000 0000 0000 0000', 'own2@example.com')).status).toBe('success');
  });
});

describe('gateway response codes', () => {
  it('reports approved on a successful card charge', async () => {
    const transaction = await charge('4084 0840 8408 4081');
    expect(transaction.response_code).toBe('00');
    expect(transaction.gateway_response_code).toBe('approved');
  });

  it('reports do_not_honor on a decline', async () => {
    const transaction = await charge('4084 0800 0000 5408');
    expect(transaction.response_code).toBe('05');
    expect(transaction.gateway_response_code).toBe('do_not_honor');
  });

  it('omits the raw processor code for non-card channels', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'ussd@example.com',
        amount: 40_000,
        currency: 'NGN',
        ussd: { type: '737' },
      },
    });
    await advance('30s');
    const verified = await app.inject({
      method: 'GET',
      url: `/paystack/transaction/verify/${res.json().data.reference}`,
      headers: auth,
    });
    // response_code is card-only at Paystack; the classification is not.
    expect(verified.json().data.response_code).toBeNull();
    expect(verified.json().data.gateway_response_code).toBe('approved');
  });
});

describe('the USSD dial string', () => {
  it('has the documented shape and is embedded in the display text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'dial@example.com',
        amount: 40_000,
        currency: 'NGN',
        ussd: { type: '737' },
        reference: 'ussd-fixed-ref',
      },
    });

    const data = res.json().data;
    // Paystack's own example is *737*33*4*18791#
    expect(data.ussd_code).toMatch(/^\*737\*33\*4\*\d{5}#$/);
    expect(data.display_text).toBe(
      `Please dial ${data.ussd_code} on your mobile phone to complete the transaction`,
    );
  });

  it('is deterministic for the same reference', async () => {
    const dial = async (reference: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/paystack/charge',
        headers: auth,
        payload: {
          email: 'd@example.com',
          amount: 40_000,
          currency: 'NGN',
          ussd: { type: '919' },
          reference,
        },
      });
      return res.json().data.ussd_code as string;
    };
    const first = await dial('same-ref');
    const other = await dial('different-ref');
    expect(first).toMatch(/^\*919\*/);
    expect(first).not.toBe(other);
  });
});

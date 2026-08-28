import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import {
  destinationForRecipientType,
  paystackTransferFee,
  transferFeeRefundable,
} from '@paybox/paystack';

/**
 * Paystack's published transfer fee schedules.
 *
 * Transcribed 2026-08-28 from their per-country pricing pages. A commercial
 * source rather than the API contract, so these assertions pin what the
 * emulator claims, not what Paystack is contractually bound to.
 */
let app: FastifyInstance;
let context: PayboxContext;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'fees';
  process.env.PAYBOX_OPENING_BALANCE = '100000000';
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
  delete process.env.PAYBOX_OPENING_BALANCE;
});

const auth = { authorization: 'Bearer sk_test_local_suite' };

const fee = (amount: number, currency: string, destination: 'bank' | 'mobile_money') =>
  paystackTransferFee({ amount, currency, destination });

describe('Nigeria — tiered by amount', () => {
  // NGN 5,000 and below: NGN 10 | 5,001-50,000: NGN 25 | above 50,000: NGN 50
  it('charges NGN 10 up to and including NGN 5,000', () => {
    expect(fee(100_000, 'NGN', 'bank')).toBe(1_000);
    expect(fee(500_000, 'NGN', 'bank')).toBe(1_000);
  });

  it('charges NGN 25 from NGN 5,001 to NGN 50,000', () => {
    expect(fee(500_100, 'NGN', 'bank')).toBe(2_500);
    expect(fee(5_000_000, 'NGN', 'bank')).toBe(2_500);
  });

  it('charges NGN 50 above NGN 50,000', () => {
    expect(fee(5_000_100, 'NGN', 'bank')).toBe(5_000);
    expect(fee(900_000_000, 'NGN', 'bank')).toBe(5_000);
  });
});

describe('Ghana — split by destination, not amount', () => {
  it('charges GHS 1 to mobile money and GHS 8 to a bank', () => {
    expect(fee(50_000, 'GHS', 'mobile_money')).toBe(100);
    expect(fee(50_000, 'GHS', 'bank')).toBe(800);
  });

  it('does not vary with the amount', () => {
    expect(fee(100, 'GHS', 'bank')).toBe(fee(99_999_999, 'GHS', 'bank'));
  });
});

describe('Kenya — tiered and split', () => {
  it('uses the M-PESA wallet ladder for mobile money', () => {
    expect(fee(150_000, 'KES', 'mobile_money')).toBe(2_000);
    expect(fee(2_000_000, 'KES', 'mobile_money')).toBe(4_000);
    expect(fee(2_000_100, 'KES', 'mobile_money')).toBe(6_000);
  });

  it('uses the bank ladder for bank accounts', () => {
    expect(fee(1_000_000, 'KES', 'bank')).toBe(8_000);
    expect(fee(5_000_000, 'KES', 'bank')).toBe(12_000);
    expect(fee(99_999_900, 'KES', 'bank')).toBe(14_000);
    expect(fee(100_000_000, 'KES', 'bank')).toBe(35_000);
  });
});

describe('South Africa — the fee survives a failure', () => {
  it('is flat', () => {
    expect(fee(1, 'ZAR', 'bank')).toBe(300);
    expect(fee(90_000_000, 'ZAR', 'bank')).toBe(300);
  });

  it('is marked non-refundable, unlike every other currency', () => {
    // "ZAR 3 per transfer (failed or successful)"
    expect(transferFeeRefundable('ZAR')).toBe(false);
    expect(transferFeeRefundable('NGN')).toBe(true);
    expect(transferFeeRefundable('GHS')).toBe(true);
  });
});

describe('destination is derived from the recipient type', () => {
  it('treats only mobile_money as a wallet', () => {
    expect(destinationForRecipientType('mobile_money')).toBe('mobile_money');
    for (const type of ['nuban', 'ghipss', 'basa', 'authorization']) {
      expect(destinationForRecipientType(type)).toBe('bank');
    }
  });
});

describe('an unknown currency', () => {
  it('charges nothing rather than guessing', () => {
    expect(fee(100_000, 'XOF', 'bank')).toBe(0);
  });
});

describe('over the API', () => {
  async function recipient(type: string, currency: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/transferrecipient',
      headers: auth,
      payload: {
        type,
        name: 'Tolu Robert',
        account_number: '0123456789',
        bank_code: type === 'mobile_money' ? 'MTN' : '058',
        currency,
      },
    });
    return res.json().data.recipient_code as string;
  }

  async function balance(currency: string) {
    const res = await app.inject({ method: 'GET', url: '/paystack/balance', headers: auth });
    const row = (res.json().data as Array<{ currency: string; balance: number }>).find(
      (b) => b.currency === currency,
    );
    return row?.balance ?? null;
  }

  async function transfer(code: string, amount: number, currency: string) {
    return app.inject({
      method: 'POST',
      url: '/paystack/transfer',
      headers: auth,
      payload: { source: 'balance', amount, recipient: code, currency },
    });
  }

  it('deducts the tier the amount actually falls into', async () => {
    const code = await recipient('nuban', 'NGN');
    const opening = 100_000_000;

    // NGN 60,000 is in the top tier, so NGN 50 not NGN 10.
    await transfer(code, 6_000_000, 'NGN');
    expect(await balance('NGN')).toBe(opening - 6_000_000 - 5_000);
  });

  it('charges the mobile-money rate for a mobile-money recipient', async () => {
    const code = await recipient('mobile_money', 'GHS');
    await transfer(code, 50_000, 'GHS');

    const ghs = await balance('GHS');
    // Opening float applies per currency, so GHS starts fresh.
    expect(ghs).toBe(100_000_000 - 50_000 - 100);
  });

  it('keeps the ZAR fee when the transfer fails', async () => {
    const code = await recipient('basa', 'ZAR');
    const res = await transfer(code, 1_000_000, 'ZAR');
    const transferCode = res.json().data.transfer_code.replace(/^TRF_/, '');
    const row = await context.storage.transfers.byProviderTransferId('paystack', transferCode);

    await context.engine.transitionTransfer(row!.id, 'failed', {
      failureReason: 'Bank rejected the payout',
    });

    // The amount comes back; the ZAR 3 does not.
    expect(await balance('ZAR')).toBe(100_000_000 - 300);
  });

  it('returns the fee on a failed NGN transfer, where it is refundable', async () => {
    const code = await recipient('nuban', 'NGN');
    const res = await transfer(code, 1_000_000, 'NGN');
    const transferCode = res.json().data.transfer_code.replace(/^TRF_/, '');
    const row = await context.storage.transfers.byProviderTransferId('paystack', transferCode);

    await context.engine.transitionTransfer(row!.id, 'failed', { failureReason: 'x' });
    expect(await balance('NGN')).toBe(100_000_000);
  });
});

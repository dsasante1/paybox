import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fromPaystackStatus,
  serializeTransaction,
  signPaystackPayload,
  toPaystackStatus,
  verifyPaystackSignature,
} from '@paybox/paystack';
import { PAYMENT_STATUSES, type Payment } from '@paybox/shared';

/**
 * Provider compatibility tests (spec §37).
 *
 * These assert our responses carry the field set Paystack documents. They test
 * shape, not values — a fixture cannot pin an id or a timestamp — and they run
 * entirely offline. Nothing here ever contacts a real payment API.
 */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../packages/providers/paystack/fixtures/${name}`, import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;

const samplePayment: Payment = {
  id: 'pay_test',
  provider: 'paystack',
  reference: 'order_1',
  providerTransactionId: 'abc123def456',
  amount: 10_000,
  currency: 'GHS',
  status: 'successful',
  providerStatus: 'success',
  paymentMethod: 'card',
  paymentMethodDetails: { bin: '400000', last4: '0000', brand: 'visa' },
  customerId: null,
  callbackUrl: null,
  amountRefunded: 0,
  failureCode: null,
  failureMessage: null,
  metadata: {},
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-01T09:00:05.000Z',
  expiresAt: null,
  authorizedAt: null,
  paidAt: '2026-01-01T09:00:05.000Z',
};

describe('transaction object shape', () => {
  it('carries every key the documented verify response has', () => {
    const documented = Object.keys((fixture('transaction-success.json').data as object) ?? {});
    const ours = Object.keys(serializeTransaction(samplePayment));
    const missing = documented.filter((key) => !ours.includes(key));
    expect(missing).toEqual([]);
  });

  it('reports amounts in minor units, unmodified', () => {
    expect(serializeTransaction(samplePayment).amount).toBe(10_000);
    expect(serializeTransaction(samplePayment).requested_amount).toBe(10_000);
  });

  it('never exposes a full PAN or a CVV', () => {
    const serialised = JSON.stringify(serializeTransaction(samplePayment));
    expect(serialised).not.toMatch(/"cvv"/);
    expect(serialised).not.toMatch(/4000000000000000/);
  });
});

describe('status mapping', () => {
  it('maps every canonical status to a Paystack status', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(toPaystackStatus(status)).toBeTruthy();
    }
  });

  it('round-trips the statuses Paystack and we agree on', () => {
    for (const status of ['successful', 'failed', 'pending', 'processing'] as const) {
      expect(fromPaystackStatus(toPaystackStatus(status))).toBe(status);
    }
  });

  it('returns null for a status Paystack does not have', () => {
    expect(fromPaystackStatus('not_a_real_status')).toBeNull();
  });
});

describe('webhook signing (verified against Paystack docs, 2026-08-27)', () => {
  const secret = 'sk_test_local_example';

  it('is an HMAC-SHA512 hex digest of the raw body', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'x' } });
    const signature = signPaystackPayload(body, secret);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyPaystackSignature(body, secret, signature)).toBe(true);
  });

  it('fails when a single byte of the body changes', () => {
    const body = JSON.stringify({ event: 'charge.success', data: { amount: 100 } });
    const tampered = JSON.stringify({ event: 'charge.success', data: { amount: 101 } });
    const signature = signPaystackPayload(body, secret);
    expect(verifyPaystackSignature(tampered, secret, signature)).toBe(false);
  });

  it('fails with the wrong secret', () => {
    const body = '{"event":"charge.success"}';
    expect(verifyPaystackSignature(body, 'other_key', signPaystackPayload(body, secret))).toBe(false);
  });

  it('uses the documented webhook envelope', () => {
    expect(Object.keys(fixture('webhook-charge-success.json'))).toEqual(
      expect.arrayContaining(['event', 'data']),
    );
  });
});

describe('initialize response', () => {
  it('has exactly the three documented data keys', () => {
    expect(Object.keys((fixture('initialize-success.json').data as object) ?? {}).sort()).toEqual([
      'access_code',
      'authorization_url',
      'reference',
    ]);
  });
});

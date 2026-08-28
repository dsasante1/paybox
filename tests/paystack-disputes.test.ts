import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Chargebacks.
 *
 * Shapes verified against the official Paystack OpenAPI specification,
 * `PaystackOSS/openapi` `dist/paystack.yaml` blob
 * efa5c8d25611a60f01fd8ce59352fb38b7edfbfb, fetched 2026-08-27
 * (`DisputeResolve`, `DisputeEvidence`, and the `status` enum on
 * `dispute_list`). Note `dispute_resolve` is a PUT.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-01-01T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'disputes';
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

async function advance(value: string) {
  await app.inject({
    method: 'POST',
    url: '/api/time',
    payload: { action: 'advance', value },
  });
}

async function withWebhooks() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: { url: 'http://localhost:9999/hook' },
  });
  return () => transport.sent.map((r) => (JSON.parse(r.body) as { event: string }).event);
}

/** A settled charge, which is the only thing that can be disputed. */
async function settledCharge(amount = 200_000) {
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/charge',
    headers: auth,
    payload: {
      email: 'dev@example.com',
      amount,
      currency: 'NGN',
      card: { number: '4000000000000000', expiry_month: '09', expiry_year: '31' },
    },
  });
  await advance('30s');
  return res.json().data.reference as string;
}

async function openDispute(payload: Record<string, unknown> = {}) {
  const reference = await settledCharge();
  const res = await app.inject({
    method: 'POST',
    url: '/paystack/dispute',
    headers: auth,
    payload: { transaction: reference, ...payload },
  });
  return { reference, res };
}

async function verify(reference: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/paystack/transaction/verify/${reference}`,
    headers: auth,
  });
  return res.json().data;
}

describe('opening a dispute', () => {
  it('opens against a settled charge and emits charge.dispute.create', async () => {
    const events = await withWebhooks();
    const { res } = await openDispute();

    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.status).toBe('awaiting-merchant-feedback');
    expect(data.refund_amount).toBe(200_000);
    expect(data.transaction_reference).toBeTruthy();

    await advance('1s');
    expect(events()).toContain('charge.dispute.create');
  });

  it('refuses to dispute a charge that never succeeded', async () => {
    const charge = await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: auth,
      payload: {
        email: 'dev@example.com',
        amount: 90_000,
        currency: 'NGN',
        card: { number: '4000000000000002' },
      },
    });
    await advance('30s');

    const res = await app.inject({
      method: 'POST',
      url: '/paystack/dispute',
      headers: auth,
      payload: { transaction: charge.json().data.reference },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/collected money/);
  });

  it('refuses a disputed amount larger than the payment', async () => {
    const reference = await settledCharge(100_000);
    const res = await app.inject({
      method: 'POST',
      url: '/paystack/dispute',
      headers: auth,
      payload: { transaction: reference, refund_amount: 500_000 },
    });
    expect(res.json().status).toBe(false);
    expect(res.json().message).toMatch(/exceeds the payment/);
  });

  it('lists disputes for a transaction', async () => {
    const { reference } = await openDispute();
    const res = await app.inject({
      method: 'GET',
      url: `/paystack/dispute/transaction/${reference}`,
      headers: auth,
    });
    expect(res.json().data).toHaveLength(1);
  });
});

describe('evidence', () => {
  it('attaches merchant evidence without resolving anything', async () => {
    const { res: created } = await openDispute();
    const id = created.json().data.id as number;

    const res = await app.inject({
      method: 'POST',
      url: `/paystack/dispute/${id}/evidence`,
      headers: auth,
      payload: {
        customer_email: 'buyer@example.com',
        customer_name: 'Mensah King',
        customer_phone: '08012345678',
        service_details: 'claim for buying cups',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.customer_name).toBe('Mensah King');

    const fetched = await app.inject({
      method: 'GET',
      url: `/paystack/dispute/${id}`,
      headers: auth,
    });
    expect(fetched.json().data.status).toBe('awaiting-merchant-feedback');
    expect(fetched.json().data.evidence.customer_email).toBe('buyer@example.com');
  });

  it('returns an upload url of the documented shape', async () => {
    const { res: created } = await openDispute();
    const res = await app.inject({
      method: 'GET',
      url: `/paystack/dispute/${created.json().data.id}/upload_url`,
      headers: auth,
    });
    expect(res.json().data).toHaveProperty('signedUrl');
    expect(res.json().data).toHaveProperty('fileName');
  });
});

describe('resolving', () => {
  it('merchant-accepted refunds the payment and moves it to refunded', async () => {
    const events = await withWebhooks();
    const { reference, res: created } = await openDispute();
    const id = created.json().data.id as number;

    const res = await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${id}/resolve`,
      headers: auth,
      payload: {
        resolution: 'merchant-accepted',
        message: 'Merchant accepted',
        refund_amount: 200_000,
        uploaded_filename: 'evidence.pdf',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('resolved');
    expect(res.json().data.resolution).toBe('merchant-accepted');

    // A real refund was raised, so the transaction reads as reversed.
    expect((await verify(reference)).status).toBe('reversed');

    await advance('1s');
    const names = events();
    expect(names).toContain('charge.dispute.resolve');
    expect(names).toContain('refund.processed');
  });

  it('a partial merchant-accepted resolution partially refunds', async () => {
    const { reference, res: created } = await openDispute();

    await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${created.json().data.id}/resolve`,
      headers: auth,
      payload: {
        resolution: 'merchant-accepted',
        message: 'Partial concession',
        refund_amount: 50_000,
        uploaded_filename: 'evidence.pdf',
      },
    });

    const transaction = await verify(reference);
    // Paystack does not change a transaction's status on a partial refund.
    expect(transaction.status).toBe('success');
    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.status).toBe('partially_refunded');
    expect(payment?.amountRefunded).toBe(50_000);
  });

  it('declined closes the dispute with no money movement', async () => {
    const { reference, res: created } = await openDispute();

    const res = await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${created.json().data.id}/resolve`,
      headers: auth,
      payload: {
        resolution: 'declined',
        message: 'Evidence supports the merchant',
        refund_amount: 0,
        uploaded_filename: 'evidence.pdf',
      },
    });

    expect(res.json().data.resolution).toBe('declined');
    expect((await verify(reference)).status).toBe('success');
    const payment = await context.storage.payments.byReference('paystack', reference);
    expect(payment?.amountRefunded).toBe(0);
  });

  it('refuses to resolve the same dispute twice', async () => {
    const { res: created } = await openDispute();
    const id = created.json().data.id as number;
    const payload = {
      resolution: 'declined',
      message: 'Closed',
      refund_amount: 0,
      uploaded_filename: 'x.pdf',
    };

    await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${id}/resolve`,
      headers: auth,
      payload,
    });
    const second = await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${id}/resolve`,
      headers: auth,
      payload,
    });

    expect(second.json().status).toBe(false);
    expect(second.json().message).toMatch(/already been resolved/);
  });

  it('rejects a resolution outside the documented enum', async () => {
    const { res: created } = await openDispute();
    const res = await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${created.json().data.id}/resolve`,
      headers: auth,
      payload: { resolution: 'whatever', message: 'x', refund_amount: 0 },
    });
    expect(res.json().status).toBe(false);
  });
});

describe('the response deadline', () => {
  it('fires a reminder when virtual time reaches it', async () => {
    const events = await withWebhooks();
    const { res: created } = await openDispute();
    const id = created.json().data.id as number;

    expect(events()).not.toContain('charge.dispute.remind');

    // The default window is a week, with the reminder a day before.
    await advance('7d');

    expect(events()).toContain('charge.dispute.remind');
    const fetched = await app.inject({
      method: 'GET',
      url: `/paystack/dispute/${id}`,
      headers: auth,
    });
    expect(fetched.json().data.status).toBe('awaiting-bank-feedback');
  });

  it('does not remind about a dispute already resolved', async () => {
    const events = await withWebhooks();
    const { res: created } = await openDispute();

    await app.inject({
      method: 'PUT',
      url: `/paystack/dispute/${created.json().data.id}/resolve`,
      headers: auth,
      payload: {
        resolution: 'declined',
        message: 'Closed early',
        refund_amount: 0,
        uploaded_filename: 'x.pdf',
      },
    });

    await advance('30d');
    expect(events()).not.toContain('charge.dispute.remind');
  });
});

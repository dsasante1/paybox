import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Quid Payments payouts: recipients, quotes, idempotency and the balance.
 *
 * Behaviour transcribed from `docs.quiddpayments.com/payouts/`, the payout
 * section of `/merchant-api.md` and the `Payout`, `PayoutBalance` and
 * `PayoutRecipient` components of the published OpenAPI document (contract
 * `2026-06`), all read 2026-09-15.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const API = '/quiddpay/api/v1';

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-14T12:00:00.000Z';
  process.env.PAYBOX_SEED = 'quiddpay-payouts';
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

const key = () => context.quiddpayKeys.apiKey;
const auth = () => ({ authorization: `Bearer ${key()}`, 'content-type': 'application/json' });

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: (body ?? {}) as object });

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key()}` } });

const del = (url: string) =>
  app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${key()}` } });

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function bankRecipient() {
  const response = await post(`${API}/payouts/recipients`, {
    bank_id: 'gcb-bank',
    account_number: '1234567890',
    account_name: 'Kwame Owusu',
  });
  return { status: response.statusCode, body: response.json() };
}

async function walletRecipient() {
  const response = await post(`${API}/payouts/recipients`, {
    account_type: 'momo',
    network: 'mtn',
    phone: '0241234567',
    account_name: 'Ama Mensah',
  });
  return { status: response.statusCode, body: response.json() };
}

describe('capabilities and balance', () => {
  it('reports the account types and networks the guide names', async () => {
    const body = (await get(`${API}/payouts/capabilities`)).json();

    expect(body.enabled).toBe(true);
    expect(body.account_types).toEqual(['bank', 'momo']);
    expect(body.mobile_money_networks.map((n: { id: string }) => n.id)).toEqual([
      'mtn',
      'telecel',
      'at',
    ]);
    // The worked example from Quid's own payout guide.
    expect(body.banks.map((b: { id: string }) => b.id)).toContain('gcb-bank');
  });

  it('folds the three figures from the ledger', async () => {
    const body = (await get(`${API}/payouts/balance`)).json();

    expect(body.currency).toBe('GHS');
    expect(body.environment).toBe('test');
    expect(body.available_minor).toBe(10_000_000);
    expect(body.held_minor).toBe(0);
    expect(body.eligible_minor).toBe(body.available_minor + body.held_minor);
  });

  it('debits the balance by the amount plus the fee', async () => {
    const { body: recipient } = await walletRecipient();
    await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 50_000,
      client_reference: 'PO-BAL-1',
    });

    const balance = (await get(`${API}/payouts/balance`)).json();
    // 100 pesewas is paybox's wallet fee, documented as paybox's own.
    expect(balance.available_minor).toBe(10_000_000 - 50_000 - 100);
  });
});

describe('recipients', () => {
  it('creates a bank recipient pending verification', async () => {
    const { status, body } = await bankRecipient();

    expect(status).toBe(201);
    expect(body.account_type).toBe('bank');
    expect(body.bank_id).toBe('gcb-bank');
    expect(body.bank_name).toBe('GCB Bank');
    expect(body.verified).toBe(false);
    expect(body.verification_status).toBe('pending_verification');
    // Quid marks every field required for both account types, so the wallet
    // fields are present and empty rather than absent.
    expect(body.phone).toBe('');
    expect(body.network).toBe('');
  });

  it('returns a wallet number in +233 form whichever form was sent', async () => {
    const { body } = await walletRecipient();

    expect(body.account_type).toBe('momo');
    expect(body.phone).toBe('+233241234567');
    expect(body.network_name).toBe('MTN MoMo');
    expect(body.account_number).toBe('');
  });

  it('refuses to mix bank and wallet fields', async () => {
    const response = await post(`${API}/payouts/recipients`, {
      account_type: 'momo',
      bank_id: 'gcb-bank',
      account_number: '1234567890',
      account_name: 'Kwame Owusu',
    });

    expect(response.statusCode).toBe(400);
  });

  it('is deliberately not idempotent, as the guide states', async () => {
    const first = await bankRecipient();
    const second = await bankRecipient();

    // Quid tells an integration to list recipients after an uncertain
    // response rather than retrying, precisely because of this.
    expect(second.body.id).not.toBe(first.body.id);
    expect((await get(`${API}/payouts/recipients`)).json().total).toBe(2);
  });

  it('lists, fetches and deletes', async () => {
    const { body: recipient } = await bankRecipient();

    expect((await get(`${API}/payouts/recipients/${recipient.id}`)).json().id).toBe(recipient.id);
    expect((await del(`${API}/payouts/recipients/${recipient.id}`)).statusCode).toBe(204);
    expect((await get(`${API}/payouts/recipients/${recipient.id}`)).statusCode).toBe(404);
  });

  it('answers a missing record with detail, not a coded envelope', async () => {
    const response = await get(`${API}/payouts/recipients/rcp_nope`);

    // `MerchantErrorCode` has no NOT_FOUND member; Quid's 404s carry `detail`.
    expect(response.statusCode).toBe(404);
    expect(response.json().detail).toContain('rcp_nope');
    expect(response.json().error).toBeUndefined();
  });
});

describe('quotes', () => {
  it('previews the fee without reserving anything', async () => {
    const { body: recipient } = await bankRecipient();
    const before = (await get(`${API}/payouts/balance`)).json();

    const quote = (
      await post(`${API}/payouts/quote`, { recipient_id: recipient.id, amount_minor: 25_000 })
    ).json();

    expect(quote.amount_minor).toBe(25_000);
    expect(quote.fee_minor).toBe(250);
    expect(quote.total_debit_minor).toBe(25_250);
    expect(quote.expires_at).toBe('2026-06-14T12:15:00.000Z');

    // A quote is a preview: it reserves no funds and locks no pricing.
    expect((await get(`${API}/payouts/balance`)).json()).toEqual(before);
  });
});

describe('creating a payout', () => {
  it('settles a test payout immediately with a TEST- reference', async () => {
    const { body: recipient } = await bankRecipient();
    const response = await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 120_000,
      client_reference: 'PO-2026-001',
      notes: 'June settlement',
    });
    const payout = response.json();

    expect(response.statusCode).toBe(201);
    expect(payout.status).toBe('paid');
    expect(payout.status_label).toBe('Paid');
    expect(payout.amount_minor).toBe(120_000);
    expect(payout.fee_minor).toBe(250);
    expect(payout.total_debit_minor).toBe(120_250);
    expect(payout.bank_reference).toMatch(/^TEST-/);
    expect(payout.reconciliation_status).toBe('not_required');
    // Completed test payouts cannot be cancelled, and a key cannot approve.
    expect(payout.can_cancel).toBe(false);
    expect(payout.can_approve).toBe(false);
  });

  it('replays an unchanged client_reference and refuses a changed one', async () => {
    const { body: recipient } = await bankRecipient();
    const payload = {
      recipient_id: recipient.id,
      amount_minor: 30_000,
      client_reference: 'PO-2026-002',
    };

    const first = await post(`${API}/payouts`, payload);
    const replay = await post(`${API}/payouts`, payload);
    const changed = await post(`${API}/payouts`, { ...payload, amount_minor: 40_000 });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('REFERENCE_CONFLICT');

    // A replay must not send the money twice.
    const balance = (await get(`${API}/payouts/balance`)).json();
    expect(balance.available_minor).toBe(10_000_000 - 30_000 - 250);
  });

  it('creates neither a payout nor a hold when max_fee_minor is exceeded', async () => {
    const { body: recipient } = await bankRecipient();
    const before = (await get(`${API}/payouts/balance`)).json();

    const response = await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 10_000,
      client_reference: 'PO-2026-003',
      max_fee_minor: 10,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('FEE_LIMIT_EXCEEDED');
    expect((await get(`${API}/payouts/balance`)).json()).toEqual(before);
    expect((await get(`${API}/payouts`)).json().total).toBe(0);
  });

  it('refuses a payout the balance cannot cover', async () => {
    const { body: recipient } = await bankRecipient();
    const response = await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 99_000_000,
      client_reference: 'PO-2026-004',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('validates client_reference against the published pattern', async () => {
    const { body: recipient } = await bankRecipient();
    const response = await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 1_000,
      client_reference: '-starts-with-a-dash',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().client_reference).toBeDefined();
  });
});

describe('reading payouts back', () => {
  it('pages and filters by client_reference', async () => {
    const { body: recipient } = await bankRecipient();
    for (const reference of ['PO-A', 'PO-B', 'PO-C']) {
      await post(`${API}/payouts`, {
        recipient_id: recipient.id,
        amount_minor: 1_000,
        client_reference: reference,
      });
    }

    const paged = (await get(`${API}/payouts?page=1&limit=2`)).json();
    expect(paged.payouts).toHaveLength(2);
    expect(paged.total).toBe(3);
    expect(paged.limit).toBe(2);

    const filtered = (await get(`${API}/payouts?reference=PO-B`)).json();
    expect(filtered.total).toBe(1);
    expect(filtered.payouts[0].client_reference).toBe('PO-B');
  });

  it('serves a real PDF receipt and its evidence', async () => {
    const { body: recipient } = await bankRecipient();
    const payout = (
      await post(`${API}/payouts`, {
        recipient_id: recipient.id,
        amount_minor: 5_000,
        client_reference: 'PO-RECEIPT',
      })
    ).json();

    const receipt = await get(`${API}/payouts/${payout.id}/receipt`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers['content-type']).toContain('application/pdf');
    // Real bytes, not JSON: code that writes the file or checks the magic
    // number works here exactly as it would in production.
    expect(receipt.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const evidenceId = payout.evidence[0].id;
    const evidence = await get(`${API}/payouts/${payout.id}/evidence/${evidenceId}`);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    expect((await get(`${API}/payouts/${payout.id}/evidence/ev_nope`)).statusCode).toBe(404);
  });

  it('refuses to cancel a payout that has already paid', async () => {
    const { body: recipient } = await bankRecipient();
    const payout = (
      await post(`${API}/payouts`, {
        recipient_id: recipient.id,
        amount_minor: 5_000,
        client_reference: 'PO-CANCEL',
      })
    ).json();

    const response = await post(`${API}/payouts/${payout.id}/cancel`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MANUAL_PAYOUT_CONFLICT');
  });
});

describe('payout webhooks', () => {
  it('reports the lifecycle, not just the ending', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/webhooks/endpoints',
      payload: { url: 'https://merchant.example.com/hook', provider: 'quiddpay', eventTypes: [] },
    });

    const { body: recipient } = await bankRecipient();
    await post(`${API}/payouts`, {
      recipient_id: recipient.id,
      amount_minor: 7_500,
      client_reference: 'PO-HOOK',
    });
    await advance('30s');

    const types = transport.sent.map(
      (request) => request.headers['x-payment-platform-event-type'],
    );
    // Unlike checkout, where only final events are sent, a payout reports its
    // whole lifecycle so a merchant can follow it.
    expect(types).toEqual(['payout.requested', 'payout.paid']);

    const paid = JSON.parse(
      transport.sent.find(
        (request) => request.headers['x-payment-platform-event-type'] === 'payout.paid',
      )!.body,
    );
    expect(paid.data.payout).toMatchObject({
      reference: 'PO-HOOK',
      status: 'paid',
      amount_minor: 7_500,
      fee_minor: 250,
      currency: 'GHS',
      reconciliation_status: 'not_required',
    });
    // Quid states payout events carry no session and no client_reference.
    expect(paid.data.session).toBeUndefined();
    expect(paid.data.payout.client_reference).toBeUndefined();
  });
});

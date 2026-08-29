import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * The invoice lifecycle: draft, finalize, pay, void, mark uncollectible.
 *
 * Verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28). Event names cross-checked against the
 * same spec's webhook list.
 *
 * The invariant these are really guarding is that an invoice's total is a fold
 * over its lines rather than a separately-stored number -- the two can never
 * disagree, because there is only one of them.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

beforeEach(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = '2026-06-10T09:00:00.000Z';
  process.env.PAYBOX_SEED = 'invoices';
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

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, String(v));
  return params.toString();
}

const post = (url: string, fields: Record<string, string | number> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });

const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: auth });

const VISA = '4242424242424242';
const DECLINE = '4000000000000002';

async function customerWithCard(number = VISA, email = 'ada@example.com') {
  const customer = (await post('/stripe/v1/customers', { email })).json();
  const pm = (
    await post('/stripe/v1/payment_methods', { type: 'card', 'card[number]': number })
  ).json();
  await post(`/stripe/v1/payment_methods/${pm.id}/attach`, { customer: customer.id });
  return { id: customer.id as string, paymentMethod: pm.id as string };
}

async function endpoint() {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: {
      url: 'http://localhost:9999/hook',
      provider: 'stripe',
      secret: 'whsec_x',
      eventTypes: [],
    },
  });
}

async function deliveredTypes(): Promise<string[]> {
  await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });
  return transport.sent.map((request) => JSON.parse(request.body).type as string);
}

describe('drafting an invoice', () => {
  it('starts as a draft owing nothing', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();

    expect(invoice).toMatchObject({
      object: 'invoice',
      status: 'draft',
      amount_due: 0,
      attempt_count: 0,
      attempted: false,
      billing_reason: 'manual',
      paid: false,
      subscription: null,
    });
    // A draft has no number; providers assign one at finalisation.
    expect(invoice.number).toBeNull();
  });

  it('totals itself from the lines added to it', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();

    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 1_500,
      currency: 'usd',
      description: 'Consulting',
    });
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 2_500,
      currency: 'usd',
      description: 'Setup fee',
    });

    const read = (await get(`/stripe/v1/invoices/${invoice.id}`)).json();
    expect(read.amount_due).toBe(4_000);
    expect(read.total).toBe(4_000);
    expect(read.lines.data).toHaveLength(2);
    expect(read.lines.data.map((l: { description: string }) => l.description)).toEqual([
      'Consulting',
      'Setup fee',
    ]);
  });

  it('subtracts a negative line, because a credit is a credit', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();

    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 5_000,
      currency: 'usd',
    });
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: -1_000,
      currency: 'usd',
      description: 'Goodwill credit',
    });

    const read = (await get(`/stripe/v1/invoices/${invoice.id}`)).json();
    expect(read.amount_due).toBe(4_000);
  });

  it('retotals when a line is removed', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    const item = (
      await post('/stripe/v1/invoiceitems', {
        customer: cus.id,
        invoice: invoice.id,
        amount: 900,
        currency: 'usd',
      })
    ).json();

    await del(`/stripe/v1/invoiceitems/${item.id}`);

    expect((await get(`/stripe/v1/invoices/${invoice.id}`)).json().amount_due).toBe(0);
  });

  it('takes unit_amount and quantity', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      unit_amount: 250,
      quantity: 4,
      currency: 'usd',
    });

    const read = (await get(`/stripe/v1/invoices/${invoice.id}`)).json();
    expect(read.amount_due).toBe(1_000);
    expect(read.lines.data[0].quantity).toBe(4);
  });

  it('requires an amount of some kind', async () => {
    const cus = await customerWithCard();
    const response = await post('/stripe/v1/invoiceitems', { customer: cus.id, currency: 'usd' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('required');
  });
});

describe('finalizing', () => {
  it('opens the invoice and assigns a number', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 3_000,
      currency: 'usd',
    });

    const open = (await post(`/stripe/v1/invoices/${invoice.id}/finalize`)).json();

    expect(open.status).toBe('open');
    expect(open.amount_due).toBe(3_000);
    expect(open.amount_remaining).toBe(3_000);
    expect(open.auto_advance).toBe(true);
    expect(open.number).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('sweeps in items that were left pending', async () => {
    const cus = await customerWithCard();
    // No `invoice`, so this item waits for whichever invoice is finalized next.
    const pending = (
      await post('/stripe/v1/invoiceitems', {
        customer: cus.id,
        amount: 700,
        currency: 'usd',
        description: 'Carried forward',
      })
    ).json();
    expect(pending.invoice).toBeNull();

    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    const open = (await post(`/stripe/v1/invoices/${invoice.id}/finalize`)).json();

    expect(open.amount_due).toBe(700);
    expect(open.lines.data[0].description).toBe('Carried forward');
  });

  it('refuses to finalize twice', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post(`/stripe/v1/invoices/${invoice.id}/finalize`);
    const again = await post(`/stripe/v1/invoices/${invoice.id}/finalize`);

    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('already finalized');
  });

  it('auto_advance finalizes at creation', async () => {
    const cus = await customerWithCard();
    const invoice = (
      await post('/stripe/v1/invoices', { customer: cus.id, auto_advance: 'true' })
    ).json();
    expect(invoice.status).toBe('open');
  });

  it('refuses to add a line to a finalized invoice', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post(`/stripe/v1/invoices/${invoice.id}/finalize`);

    const response = await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 100,
      currency: 'usd',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('only a draft is editable');
  });
});

describe('paying', () => {
  async function openInvoice(cardNumber = VISA) {
    const cus = await customerWithCard(cardNumber);
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 2_200,
      currency: 'usd',
    });
    return {
      cus,
      invoice: (await post(`/stripe/v1/invoices/${invoice.id}/finalize`)).json(),
    };
  }

  it("charges the customer's default card", async () => {
    const { invoice } = await openInvoice();
    const paid = (await post(`/stripe/v1/invoices/${invoice.id}/pay`)).json();

    expect(paid).toMatchObject({
      status: 'paid',
      paid: true,
      amount_paid: 2_200,
      amount_remaining: 0,
      attempt_count: 1,
      auto_advance: false,
    });
    expect(paid.payment_intent).toMatch(/^pi_/);
  });

  it('creates a real payment, not a bookkeeping entry', async () => {
    const { invoice } = await openInvoice();
    const paid = (await post(`/stripe/v1/invoices/${invoice.id}/pay`)).json();

    const intent = (await get(`/stripe/v1/payment_intents/${paid.payment_intent}`)).json();
    expect(intent).toMatchObject({ status: 'succeeded', amount: 2_200 });
  });

  it('leaves a declined invoice owed and payable again', async () => {
    const { cus, invoice } = await openInvoice(DECLINE);
    const failed = (await post(`/stripe/v1/invoices/${invoice.id}/pay`)).json();

    // Stripe keeps a failed invoice `open` -- the status describes the invoice,
    // not the attempt.
    expect(failed.status).toBe('open');
    expect(failed.paid).toBe(false);
    expect(failed.attempt_count).toBe(1);

    // Attach a card that works and try again.
    const good = (
      await post('/stripe/v1/payment_methods', { type: 'card', 'card[number]': VISA })
    ).json();
    await post(`/stripe/v1/payment_methods/${good.id}/attach`, { customer: cus.id });

    const paid = (
      await post(`/stripe/v1/invoices/${invoice.id}/pay`, { payment_method: good.id })
    ).json();
    expect(paid.status).toBe('paid');
    expect(paid.attempt_count).toBe(2);
  });

  it('refuses to pay a draft', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    const response = await post(`/stripe/v1/invoices/${invoice.id}/pay`);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Finalize it first');
  });

  it('refuses to pay twice', async () => {
    const { invoice } = await openInvoice();
    await post(`/stripe/v1/invoices/${invoice.id}/pay`);
    const again = await post(`/stripe/v1/invoices/${invoice.id}/pay`);

    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toContain('already paid');
  });

  it('settles out of band without moving money', async () => {
    const { invoice } = await openInvoice();
    const paid = (
      await post(`/stripe/v1/invoices/${invoice.id}/pay`, { paid_out_of_band: 'true' })
    ).json();

    expect(paid.status).toBe('paid');
    // Nothing moved through the emulator, so no payment was created.
    expect(paid.payment_intent).toBeNull();
    expect((await context.storage.payments.list({ provider: 'stripe' })).total).toBe(0);
  });

  it('needs a payment method it can actually use', async () => {
    const customer = (await post('/stripe/v1/customers', { email: 'nobody@example.com' })).json();
    const invoice = (await post('/stripe/v1/invoices', { customer: customer.id })).json();
    await post(`/stripe/v1/invoices/${invoice.id}/finalize`);

    const response = await post(`/stripe/v1/invoices/${invoice.id}/pay`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('no default payment method');
  });
});

describe('ending an invoice without payment', () => {
  async function openInvoice() {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 1_100,
      currency: 'usd',
    });
    return (await post(`/stripe/v1/invoices/${invoice.id}/finalize`)).json();
  }

  it('voids an open invoice', async () => {
    const invoice = await openInvoice();
    const voided = (await post(`/stripe/v1/invoices/${invoice.id}/void`)).json();

    expect(voided).toMatchObject({
      status: 'void',
      amount_remaining: 0,
      paid: false,
      auto_advance: false,
    });
  });

  it('will not void a paid invoice', async () => {
    const invoice = await openInvoice();
    await post(`/stripe/v1/invoices/${invoice.id}/pay`);
    const response = await post(`/stripe/v1/invoices/${invoice.id}/void`);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Refund it instead');
  });

  it('marks an invoice uncollectible, and still lets it be paid late', async () => {
    const invoice = await openInvoice();
    const written = (
      await post(`/stripe/v1/invoices/${invoice.id}/mark_uncollectible`)
    ).json();
    expect(written.status).toBe('uncollectible');

    // Writing a debt off is bookkeeping, not a fact about the customer.
    const paid = (await post(`/stripe/v1/invoices/${invoice.id}/pay`)).json();
    expect(paid.status).toBe('paid');
  });

  it('voids a draft rather than deleting it, keeping the audit trail', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    const deleted = (await del(`/stripe/v1/invoices/${invoice.id}`)).json();

    expect(deleted).toMatchObject({ id: invoice.id, deleted: true });
    // paybox voids instead of removing -- the event log is append-only.
    expect((await get(`/stripe/v1/invoices/${invoice.id}`)).json().status).toBe('void');
  });

  it('refuses to delete a finalized invoice', async () => {
    const invoice = await openInvoice();
    const response = await del(`/stripe/v1/invoices/${invoice.id}`);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('void it instead');
  });
});

describe('reading invoices', () => {
  it('lists lines on their own route', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 400,
      currency: 'usd',
      description: 'Line one',
    });

    const lines = (await get(`/stripe/v1/invoices/${invoice.id}/lines`)).json();
    expect(lines.object).toBe('list');
    expect(lines.data).toHaveLength(1);
    expect(lines.data[0].description).toBe('Line one');
  });

  it('expands the customer', async () => {
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    const expanded = (
      await get(`/stripe/v1/invoices/${invoice.id}?expand[]=customer`)
    ).json();

    expect(expanded.customer).toMatchObject({ object: 'customer', email: 'ada@example.com' });
  });

  it('lists pending invoice items', async () => {
    const cus = await customerWithCard();
    await post('/stripe/v1/invoiceitems', { customer: cus.id, amount: 100, currency: 'usd' });

    const items = (await get(`/stripe/v1/invoiceitems?customer=${cus.id}`)).json();
    expect(items.data).toHaveLength(1);
    expect(items.data[0].invoice).toBeNull();
  });
});

describe('webhooks', () => {
  it('reports each step with the event Stripe sends for it', async () => {
    await endpoint();
    const cus = await customerWithCard();
    const invoice = (await post('/stripe/v1/invoices', { customer: cus.id })).json();
    await post('/stripe/v1/invoiceitems', {
      customer: cus.id,
      invoice: invoice.id,
      amount: 1_000,
      currency: 'usd',
    });
    await post(`/stripe/v1/invoices/${invoice.id}/finalize`);
    await post(`/stripe/v1/invoices/${invoice.id}/pay`);

    const types = await deliveredTypes();
    expect(types).toContain('invoice.created');
    expect(types).toContain('invoiceitem.created');
    expect(types).toContain('invoice.finalized');
    expect(types).toContain('invoice.paid');
    expect(types).toContain('invoice.payment_succeeded');
  });

  it('reports a void and a write-off', async () => {
    await endpoint();
    const cus = await customerWithCard();
    const first = (await post('/stripe/v1/invoices', { customer: cus.id, auto_advance: 'true' })).json();
    const second = (await post('/stripe/v1/invoices', { customer: cus.id, auto_advance: 'true' })).json();
    await post(`/stripe/v1/invoices/${first.id}/void`);
    await post(`/stripe/v1/invoices/${second.id}/mark_uncollectible`);

    const types = await deliveredTypes();
    expect(types).toContain('invoice.voided');
    expect(types).toContain('invoice.marked_uncollectible');
  });
});

describe('subscription invoices still work the same way', () => {
  it('carries a real line item and reads as a renewal', async () => {
    const cus = await customerWithCard();
    const price = (
      await post('/stripe/v1/prices', {
        currency: 'usd',
        unit_amount: 1_500,
        'product_data[name]': 'Pro plan',
        'recurring[interval]': 'month',
      })
    ).json();
    await post('/stripe/v1/subscriptions', {
      customer: cus.id,
      'items[0][price]': price.id,
    });

    await app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value: '1m' } });

    const invoices = (await get('/stripe/v1/invoices')).json();
    expect(invoices.data.length).toBeGreaterThan(0);
    const invoice = invoices.data[0];
    expect(invoice.billing_reason).toBe('subscription_cycle');
    expect(invoice.subscription).toMatch(/^sub_/);
    expect(invoice.lines.data[0]).toMatchObject({
      description: 'Pro plan',
      amount: 1_500,
      type: 'subscription',
    });
  });
});

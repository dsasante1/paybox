import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, sent, startBachs, START, type BachsBilling } from './bachs-billing-helpers.js';

/**
 * Bachs disputes and uploads through the HTTP surface.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document (listDisputes,
 * getDispute, uploadDisputeDocument, updateDisputeEvidence, submitDispute,
 * createUpload, getUpload, deleteUpload), guides/disputes/overview,
 * connect/disputes, for-you/fees and the dispute-created and dispute-updated
 * event pages. `POST /v1/disputes` and `/network` are paybox's own.
 */
let env: BachsBilling;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  env = await startBachs();
  api = client(env);
});

afterEach(async () => {
  await env.close();
  delete process.env.PAYBOX_OPENING_BALANCE;
});

const cents = (decimal: string) => Math.round(Number(decimal) * 100);

async function available(currency: string): Promise<number> {
  const response = await api.get('/v1/balances');
  expect(response.statusCode, response.body).toBe(200);
  const entry = (response.json().balances as Array<{ currency: string; available_balance: string }>).find(
    (row) => row.currency === currency,
  );
  return cents(entry?.available_balance ?? 'NaN');
}

/** A card collection; returns its charge id. */
async function collect(amount = '100.00', currency = 'USD', customer: Record<string, unknown> = { email: 'ama@example.com' }) {
  const session = await api.checkout({ pricing: { currency, amount }, customer });
  await api.pagePost(`${session.path}/pay`, {
    corridor: currency === 'NGN' ? 'NGN_CARD' : 'USD_CARD',
    card_number: '4242424242424242',
  });
  await api.advance('1s');
  const checkout = (await api.get(`/v1/checkout-sessions/${session.id}`)).json();
  return checkout.charge.payment_id as string;
}

async function open(body: Record<string, unknown>, status = 201) {
  const response = await api.post('/v1/disputes', body);
  expect(response.statusCode, response.body).toBe(status);
  return response.json() as Record<string, any>;
}

async function network(id: string, body: Record<string, unknown>) {
  const response = await api.post(`/v1/disputes/${id}/network`, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, any>;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.7\n%test\n');

/** A `multipart/form-data` body, as a browser or an SDK sends it. */
function multipart(parts: Array<{ name: string; value: string } | { name: string; file: string; type: string; bytes: Buffer }>) {
  const boundary = '----paybox-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('file' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.file}"\r\nContent-Type: ${part.type}\r\n\r\n`,
        ),
        part.bytes,
        Buffer.from('\r\n'),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(url: string, parts: Parameters<typeof multipart>[0]) {
  const body = multipart(parts);
  return env.app.inject({
    method: 'POST',
    url: `/bachs${url}`,
    headers: { authorization: `Bearer ${env.context.bachsKeys.secretKey}`, 'content-type': body.contentType },
    payload: body.payload,
  });
}

describe('opening a dispute', () => {
  it('records it as Bachs shows it, prefilled from the customer, and sends dispute.created', async () => {
    const customer = await api.post('/v1/customers', {
      email: 'kofi@example.com',
      name: 'Kofi Mensah',
      billing_address: { line1: '12 Ring Road', city: 'Accra', country: 'GH' },
    });
    const charge = await collect('75.00', 'USD', { customer_id: customer.json().customer_id });
    const dispute = await open({ charge_id: charge, reason: 'product_not_received' });

    expect(dispute).toEqual({
      dispute_id: expect.stringMatching(/^dsp_[0-9a-f]{12}$/),
      charge_id: charge,
      amount: '75.00',
      currency: 'USD',
      status: 'needs_response',
      is_response_editable: true,
      reason: 'product_not_received',
      // Bachs' own example: fourteen days, to the last second of the day.
      response_deadline_at: '2026-06-28T23:59:59.000Z',
      // `access_activity_log` and the two policy attachments are typed as
      // plain strings, not nullable ones: unset, they are left out.
      evidence: {
        billing_address: '12 Ring Road, Accra, GH',
        cancellation_policy_disclosure: null,
        customer_communication_attachment_id: null,
        customer_email_address: 'kofi@example.com',
        customer_name: 'Kofi Mensah',
        notes: null,
        product_description: null,
        refund_policy_disclosure: null,
        refund_refusal_explanation: null,
        service_date: null,
        uncategorized_attachment_id: null,
      },
      latest_submission: null,
      created_at: '2026-06-14T12:00:01.000Z',
      updated_at: '2026-06-14T12:00:01.000Z',
    });

    const [created] = await sent(env, 'dispute.created');
    expect(created?.data).toEqual({
      dispute_id: dispute.dispute_id,
      charge_id: charge,
      amount: '75.00',
      currency: 'USD',
      status: 'needs_response',
      is_response_editable: true,
      reason: 'product_not_received',
      response_deadline_at: '2026-06-28T23:59:59Z',
      created_at: '2026-06-14T12:00:01Z',
      updated_at: '2026-06-14T12:00:01Z',
      charge_amount: '75.00',
      charge_currency: 'USD',
    });
    expect(await sent(env, 'dispute.updated')).toEqual([]);
  });

  it('covers part of a charge when asked, and refuses more than the charge', async () => {
    const charge = await collect('100.00');
    const partial = await open({ charge_id: charge, amount: '40.00' });
    expect(partial.amount).toBe('40.00');
    const [created] = await sent(env, 'dispute.created');
    expect(created?.data).toMatchObject({ amount: '40.00', charge_amount: '100.00' });

    const other = await collect('10.00');
    const tooMuch = await api.post('/v1/disputes', { charge_id: other, amount: '10.01' });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error_code).toBe('VALIDATION_ERROR');
  });

  it('counts a lost dispute as money gone: no refund of it, and no second dispute over it', async () => {
    const charge = await collect('100.00');
    const dispute = await open({ charge_id: charge, amount: '70.00' });
    await network(dispute.dispute_id, { status: 'lost' });

    const full = await api.post('/v1/refunds', { charge_id: charge, reference: 'after-loss', amount: '100.00' });
    expect(full.statusCode).toBe(400);
    const again = await api.post('/v1/disputes', { charge_id: charge });
    expect(again.statusCode).toBe(201);
    expect(again.json().amount).toBe('30.00');
    const more = await api.post('/v1/disputes', { charge_id: await collect('5.00'), amount: '6.00' });
    expect(more.statusCode).toBe(400);
  });

  it('allows one open dispute per charge', async () => {
    const charge = await collect();
    await open({ charge_id: charge });
    const second = await api.post('/v1/disputes', { charge_id: charge });
    expect(second.statusCode).toBe(409);
    expect(second.json().error_code).toBe('CONFLICT');
  });

  it('refuses a charge that does not exist', async () => {
    const response = await api.post('/v1/disputes', { charge_id: 'ch_nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error_code).toBe('NOT_FOUND');
  });
});

describe('what a dispute does to the balance', () => {
  it('takes the $15 fee and sets the amount aside; a win returns the amount but not the fee', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const dispute = await open({ charge_id: charge });
    expect(await available('USD')).toBe(before - 1_500 - 10_000);

    const won = await network(dispute.dispute_id, { status: 'won' });
    expect(won).toMatchObject({ status: 'won', is_response_editable: false });
    expect(await available('USD')).toBe(before - 1_500);

    const [updated] = await sent(env, 'dispute.updated');
    expect(updated?.data).toMatchObject({ dispute_id: dispute.dispute_id, status: 'won', is_response_editable: false });
  });

  it('keeps the amount on a loss, without charging the fee again', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const dispute = await open({ charge_id: charge });
    await network(dispute.dispute_id, { status: 'lost' });
    expect(await available('USD')).toBe(before - 1_500 - 10_000);
    expect((await sent(env, 'dispute.updated')).map((event) => event.data.status)).toEqual(['lost']);
  });

  it('releases the amount when the network closes it without a ruling', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const dispute = await open({ charge_id: charge });
    await network(dispute.dispute_id, { status: 'closed' });
    expect(await available('USD')).toBe(before - 1_500);
  });

  it('takes an NGN charge’s fee in naira, at the fixed rate', async () => {
    const charge = await collect('50000.00', 'NGN');
    const ngn = await available('NGN');
    const usd = await available('USD');
    await open({ charge_id: charge, amount: '10000.00' });
    // $15 is ₦22,500 at 1,500 to the dollar; the dollar balance is untouched.
    expect(await available('NGN')).toBe(ngn - 2_250_000 - 1_000_000);
    expect(await available('USD')).toBe(usd);
  });

  it('can drive a balance negative on a loss, which blocks every payout until it heals', async () => {
    process.env.PAYBOX_OPENING_BALANCE = '0';
    await env.close();
    env = await startBachs();
    api = client(env);

    const charge = await collect('10.00');
    const dispute = await open({ charge_id: charge });
    await network(dispute.dispute_id, { status: 'lost' });
    expect(await available('USD')).toBeLessThan(0);

    const ngnDestination = await api.post('/v1/payouts/destinations', {
      currency: 'NGN',
      name: 'Payouts',
      bank_code: '999',
      account_number: '0001112223',
    });
    expect(ngnDestination.statusCode, ngnDestination.body).toBe(201);
    // NGN was never touched, and still nothing can leave.
    const refused = await api.post('/v1/payouts', { destination: ngnDestination.json().id, amount: '1.00' });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error_code).toBe('ORGANIZATION_IN_DEBT');

    // Future collections heal it.
    await collect('100.00');
    expect(await available('USD')).toBeGreaterThan(0);
  });
});

describe('evidence and submission', () => {
  it('saves a partial draft any number of times, clearing a field with null', async () => {
    const dispute = await open({ charge_id: await collect() });
    const first = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, {
      product_description: 'Annual plan',
      notes: 'Delivered on the 5th.',
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      dispute_id: dispute.dispute_id,
      status: 'needs_response',
      is_response_editable: true,
      evidence_updated_at: '2026-06-14T12:00:01.000Z',
    });
    await api.advance('1h');
    const second = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, {
      notes: null,
      service_date: '2026-06-05',
    });
    expect(second.json().evidence_updated_at).toBe('2026-06-14T13:00:01.000Z');

    const read = (await api.get(`/v1/disputes/${dispute.dispute_id}`)).json();
    expect(read.evidence).toMatchObject({
      product_description: 'Annual plan',
      notes: null,
      service_date: '2026-06-05',
      customer_email_address: 'ama@example.com',
    });
    // Saving evidence does not send dispute.updated.
    expect(await sent(env, 'dispute.updated')).toEqual([]);
  });

  it('accepts an uploaded document as an attachment, and refuses one that does not exist', async () => {
    const dispute = await open({ charge_id: await collect() });
    const document = await upload('/v1/disputes/uploads', [
      { name: 'file', file: 'email.pdf', type: 'application/pdf', bytes: PDF },
    ]);
    expect(document.statusCode, document.body).toBe(200);
    expect(document.json()).toEqual({
      document_id: expect.stringMatching(/^upl_[0-9a-f]{12}$/),
      file_name: 'email.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: PDF.length,
      uploaded_at: '2026-06-14T12:00:01.000Z',
    });
    const id = document.json().document_id;

    const attached = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, {
      customer_communication_attachment_id: id,
    });
    expect(attached.statusCode, attached.body).toBe(200);
    const linked = (await api.get(`/v1/utilities/uploads/${id}`)).json();
    expect(linked).toMatchObject({ url: null, linked_resource_type: 'dispute', linked_resource_id: dispute.dispute_id });

    const missing = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, {
      uncategorized_attachment_id: 'upl_000000000000',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error_code).toBe('INVALID_UPLOAD_REFERENCE');

    // A refused save attaches nothing, even what it named before the bad id.
    const spare = (await upload('/v1/disputes/uploads', [{ name: 'file', file: 's.pdf', type: 'application/pdf', bytes: PDF }])).json();
    const refused = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, {
      cancellation_policy_attachment_id: spare.document_id,
      uncategorized_attachment_id: 'upl_000000000000',
    });
    expect(refused.statusCode).toBe(400);
    expect((await api.get(`/v1/utilities/uploads/${spare.document_id}`)).json().linked_resource_id).toBeNull();

    // Cleared, it is free again.
    await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, { customer_communication_attachment_id: null });
    expect((await api.get(`/v1/utilities/uploads/${id}`)).json().linked_resource_id).toBeNull();
    await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, { customer_communication_attachment_id: id });

    // One upload, one resource.
    const other = await open({ charge_id: await collect('5.00') });
    const taken = await api.patch(`/v1/disputes/${other.dispute_id}/evidence`, { uncategorized_attachment_id: id });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().error_code).toBe('INVALID_UPLOAD_REFERENCE');
  });

  it('submits once, locking the evidence, without sending dispute.updated', async () => {
    const dispute = await open({ charge_id: await collect() });
    await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, { notes: 'Delivered.' });
    const submitted = await api.post(`/v1/disputes/${dispute.dispute_id}/submit`, {});
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toEqual({
      dispute_id: dispute.dispute_id,
      status: 'under_review',
      is_response_editable: false,
      submission: {
        submission_id: expect.stringMatching(/^dse_[0-9a-f]{12}$/),
        submission_status: 'submitted',
        trigger_source: 'merchant_submit',
        submitted_at: '2026-06-14T12:00:01.000Z',
      },
    });
    const read = (await api.get(`/v1/disputes/${dispute.dispute_id}`)).json();
    expect(read).toMatchObject({ status: 'under_review', is_response_editable: false });
    expect(read.latest_submission).toEqual({
      submission_id: submitted.json().submission.submission_id,
      status: 'submitted',
      trigger_source: 'merchant_submit',
      submitted_at: '2026-06-14T12:00:01.000Z',
      failed_at: null,
      attempt_sequence: 1,
    });
    expect(await sent(env, 'dispute.updated')).toEqual([]);

    const edit = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, { notes: 'More.' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error_code).toBe('DISPUTE_NOT_EDITABLE');
    const again = await api.post(`/v1/disputes/${dispute.dispute_id}/submit`, {});
    expect(again.statusCode).toBe(409);

    // The ruling after review is the network's, and that does send dispute.updated.
    await network(dispute.dispute_id, { status: 'won' });
    expect((await sent(env, 'dispute.updated')).map((event) => event.data.status)).toEqual(['won']);
  });

  it('refuses fields on submit', async () => {
    const dispute = await open({ charge_id: await collect() });
    const response = await api.post(`/v1/disputes/${dispute.dispute_id}/submit`, { notes: 'x' });
    expect(response.statusCode).toBe(400);
  });

  it('answers 410 DEADLINE_PASSED after the deadline, and 409 once locked whatever the time', async () => {
    const open1 = await open({ charge_id: await collect() });
    const open2 = await open({ charge_id: await collect('20.00') });
    await api.post(`/v1/disputes/${open2.dispute_id}/submit`, {});
    await api.advance('15d');

    const late = await api.patch(`/v1/disputes/${open1.dispute_id}/evidence`, { notes: 'x' });
    expect(late.statusCode).toBe(410);
    expect(late.json().error_code).toBe('DEADLINE_PASSED');
    const lateSubmit = await api.post(`/v1/disputes/${open1.dispute_id}/submit`, {});
    expect(lateSubmit.statusCode).toBe(410);
    // Nothing happens on its own at the deadline: the ruling is the network's.
    expect((await api.get(`/v1/disputes/${open1.dispute_id}`)).json()).toMatchObject({
      status: 'needs_response',
      is_response_editable: true,
    });

    const locked = await api.patch(`/v1/disputes/${open2.dispute_id}/evidence`, { notes: 'x' });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error_code).toBe('DISPUTE_NOT_EDITABLE');
  });

  it('lets the network move the deadline earlier, never later, without dispute.updated', async () => {
    const dispute = await open({ charge_id: await collect() });
    const moved = await network(dispute.dispute_id, { response_deadline_at: '2026-06-20T23:59:59Z' });
    expect(moved.response_deadline_at).toBe('2026-06-20T23:59:59.000Z');
    expect(await sent(env, 'dispute.updated')).toEqual([]);

    const later = await api.post(`/v1/disputes/${dispute.dispute_id}/network`, {
      response_deadline_at: '2026-07-20T23:59:59Z',
    });
    expect(later.statusCode).toBe(400);

    await api.advance('7d');
    const late = await api.patch(`/v1/disputes/${dispute.dispute_id}/evidence`, { notes: 'x' });
    expect(late.statusCode).toBe(410);
  });

  it('records a deadline move in the event log', async () => {
    const dispute = await open({ charge_id: await collect() });
    await network(dispute.dispute_id, { response_deadline_at: '2026-06-20T23:59:59Z' });
    const core = (await env.context.storage.disputes.byProviderDisputeId('bachs', dispute.dispute_id))!;
    const events = await env.context.storage.events.listByResource(core.id);
    expect(events.map((event) => event.type)).toEqual(['dispute.created', 'dispute.deadline_moved']);
  });

  it('refuses a second ruling', async () => {
    const dispute = await open({ charge_id: await collect() });
    await network(dispute.dispute_id, { status: 'won' });
    const again = await api.post(`/v1/disputes/${dispute.dispute_id}/network`, { status: 'lost' });
    expect(again.statusCode).toBe(409);
  });
});

describe('prevention by refund', () => {
  it('prevents an undecided dispute when a refund of the charge succeeds, releasing the amount', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const dispute = await open({ charge_id: charge });

    const refund = await api.post('/v1/refunds', { charge_id: charge, reference: 'refund-1' });
    expect(refund.statusCode, refund.body).toBe(201);
    await api.advance('1h');

    const read = (await api.get(`/v1/disputes/${dispute.dispute_id}`)).json();
    expect(read).toMatchObject({ status: 'prevented', is_response_editable: false });
    expect((await sent(env, 'dispute.updated')).map((event) => event.data.status)).toEqual(['prevented']);
    // The fee stays; the refund moved the money, nothing else is set aside.
    expect(await available('USD')).toBe(before - 1_500 - 10_000);
  });

  it('needs the refund funded on its own: "an unfundable refund is refused"', async () => {
    process.env.PAYBOX_OPENING_BALANCE = '0';
    await env.close();
    env = await startBachs();
    api = client(env);

    const charge = await collect('100.00');
    await open({ charge_id: charge, amount: '50.00' });
    // The fee and the hold leave too little for a $50 refund.
    expect(await available('USD')).toBeLessThan(5_000);
    const refund = await api.post('/v1/refunds', { charge_id: charge, reference: 'refund-2', amount: '50.00' });
    expect(refund.statusCode).toBe(400);
    expect(refund.json().detail).toBe('Insufficient balance to refund');
  });

  it('refuses a loss while a refund of the same money is in flight', async () => {
    const charge = await collect('100.00');
    const dispute = await open({ charge_id: charge });
    await api.post('/v1/refunds', { charge_id: charge, reference: 'in-flight' });
    const lost = await api.post(`/v1/disputes/${dispute.dispute_id}/network`, { status: 'lost' });
    expect(lost.statusCode).toBe(409);
    await api.advance('1h');
    expect((await api.get(`/v1/disputes/${dispute.dispute_id}`)).json().status).toBe('prevented');
  });

  it('leaves the dispute standing when a refund covers less than the disputed amount', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const dispute = await open({ charge_id: charge, amount: '60.00' });
    await api.post('/v1/refunds', { charge_id: charge, reference: 'refund-3', amount: '10.00' });
    await api.advance('1h');
    expect((await api.get(`/v1/disputes/${dispute.dispute_id}`)).json().status).toBe('needs_response');
    expect(await sent(env, 'dispute.updated')).toEqual([]);
    expect(await available('USD')).toBe(before - 1_500 - 6_000 - 1_000);
  });

  it('sends refund.paid before the dispute.updated its refund causes', async () => {
    const charge = await collect('100.00');
    await open({ charge_id: charge });
    await api.post('/v1/refunds', { charge_id: charge, reference: 'refund-4' });
    await api.advance('1h');
    const rows = await env.context.storage.providerState.listByPrefix('bachs', 'event:');
    const order = rows
      .map((row) => JSON.parse(row.value) as { seq: number; type: string })
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => entry.type)
      .filter((type) => type === 'refund.paid' || type === 'dispute.updated');
    expect(order).toEqual(['refund.paid', 'dispute.updated']);
  });
});

describe('early dispute warnings', () => {
  it('charge $29 once per payment and set nothing aside; escalation adds the $15 fee and the hold', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const warning = await open({ charge_id: charge, warning: true });
    expect(warning.status).toBe('needs_response');
    expect(await available('USD')).toBe(before - 2_900);

    // "If a warned payment goes on to become a dispute, both fees apply."
    const escalated = await open({ charge_id: charge }, 200);
    expect(escalated.dispute_id).toBe(warning.dispute_id);
    expect(await available('USD')).toBe(before - 2_900 - 1_500 - 10_000);
    expect(await sent(env, 'dispute.created')).toHaveLength(1);
  });

  it('charges the warning fee once per payment, however many warnings', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const first = await open({ charge_id: charge, warning: true });
    await network(first.dispute_id, { status: 'closed' });
    await open({ charge_id: charge, warning: true });
    expect(await available('USD')).toBe(before - 2_900);
  });

  it('takes the dispute’s own amount, reason and deadline on escalation', async () => {
    const charge = await collect('100.00');
    const before = await available('USD');
    const warning = await open({ charge_id: charge, warning: true, amount: '10.00' });
    const dispute = await open(
      { charge_id: charge, amount: '80.00', reason: 'duplicate', response_deadline_at: '2026-06-25T23:59:59Z' },
      200,
    );
    expect(dispute).toMatchObject({
      dispute_id: warning.dispute_id,
      amount: '80.00',
      reason: 'duplicate',
      response_deadline_at: '2026-06-25T23:59:59.000Z',
    });
    expect(await available('USD')).toBe(before - 2_900 - 1_500 - 8_000);
  });

  it('cannot be won or lost, only closed, until escalated', async () => {
    const warning = await open({ charge_id: await collect(), warning: true });
    for (const status of ['won', 'lost']) {
      const response = await api.post(`/v1/disputes/${warning.dispute_id}/network`, { status });
      expect(response.statusCode).toBe(409);
    }
    expect((await network(warning.dispute_id, { status: 'closed' })).status).toBe('closed');
  });

  it('refuses a second warning while one is open', async () => {
    const charge = await collect();
    await open({ charge_id: charge, warning: true });
    const again = await api.post('/v1/disputes', { charge_id: charge, warning: true });
    expect(again.statusCode).toBe(409);
  });
});

describe('listing', () => {
  it('lists newest first with a total, filtered by status and creation time', async () => {
    const a = await open({ charge_id: await collect('10.00') });
    await api.advance('1d');
    const b = await open({ charge_id: await collect('20.00') });
    await network(a.dispute_id, { status: 'won' });

    const all = (await api.get('/v1/disputes')).json();
    expect(all.total).toBe(2);
    expect(all.items.map((item: any) => item.dispute_id)).toEqual([b.dispute_id, a.dispute_id]);
    expect(Object.keys(all.items[0])).toEqual([
      'dispute_id',
      'charge_id',
      'amount',
      'currency',
      'status',
      'is_response_editable',
      'reason',
      'response_deadline_at',
      'created_at',
      'updated_at',
    ]);

    const won = (await api.get('/v1/disputes?status=won')).json();
    expect(won.items.map((item: any) => item.dispute_id)).toEqual([a.dispute_id]);
    const recent = (await api.get('/v1/disputes?from_date=2026-06-15T00:00:00Z')).json();
    expect(recent.items.map((item: any) => item.dispute_id)).toEqual([b.dispute_id]);
    const early = (await api.get('/v1/disputes?to_date=2026-06-15T00:00:00Z')).json();
    expect(early.items.map((item: any) => item.dispute_id)).toEqual([a.dispute_id]);
    const page = (await api.get('/v1/disputes?limit=1&offset=1')).json();
    expect(page).toMatchObject({ total: 2, items: [{ dispute_id: a.dispute_id }] });
  });

  it('answers 404 for a dispute that does not exist', async () => {
    const response = await api.get('/v1/disputes/dsp_000000000000');
    expect(response.statusCode).toBe(404);
  });
});

describe("paybox's generic tooling on a Bachs dispute", () => {
  it('a dispute opened and lost through the control API moves the balance once', async () => {
    const charge = await collect('100.00');
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', charge);
    const before = await available('USD');

    const opened = await env.app.inject({
      method: 'POST',
      url: '/api/disputes',
      payload: { paymentId: payment!.id, refundAmount: 4_000 },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const coreId = opened.json().id as string;
    const listed = (await api.get('/v1/disputes')).json();
    // Given an id of Bachs' own shape, and found by either.
    expect(listed.items).toMatchObject([{ dispute_id: expect.stringMatching(/^dsp_[0-9a-f]{12}$/), status: 'needs_response', amount: '40.00' }]);
    const bachsId = listed.items[0].dispute_id as string;
    expect((await api.get(`/v1/disputes/${coreId}`)).json().dispute_id).toBe(bachsId);
    expect(await available('USD')).toBe(before - 1_500 - 4_000);

    // A merchant-accepted resolution raises a real refund, which takes the
    // money; the hold comes back so the loss is not counted twice.
    const resolved = await env.app.inject({
      method: 'POST',
      url: `/api/disputes/${coreId}/resolve`,
      payload: { resolution: 'merchant-accepted' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await api.get(`/v1/disputes/${bachsId}`)).json().status).toBe('lost');
    expect(await available('USD')).toBe(before - 1_500 - 4_000);

    // Paystack's deadline reminder does not move a Bachs dispute.
    await api.advance('8d');
    expect((await sent(env, 'dispute.updated')).map((event) => event.data.status)).toEqual(['lost']);
  });

  it('keeps the submission of a dispute opened through the control API', async () => {
    const payment = await env.context.storage.payments.byProviderTransactionId('bachs', await collect());
    await env.app.inject({ method: 'POST', url: '/api/disputes', payload: { paymentId: payment!.id } });
    const id = (await api.get('/v1/disputes')).json().items[0].dispute_id as string;
    expect((await api.post(`/v1/disputes/${id}/submit`, {})).statusCode).toBe(200);
    expect((await api.get(`/v1/disputes/${id}`)).json().latest_submission).toMatchObject({ attempt_sequence: 1 });
  });

  it('a dispute row whose ledger entries were never written is still reported and then settled', async () => {
    const charge = await collect('100.00');
    const payment = (await env.context.storage.payments.byProviderTransactionId('bachs', charge))!;
    const before = await available('USD');
    // As if the process stopped between the row and the sweep: no event, no ledger entry.
    await env.context.storage.disputes.insert({
      id: 'dsp_crashcrash01',
      provider: 'bachs',
      providerDisputeId: 'dsp_0123456789ab',
      paymentId: payment.id,
      customerId: payment.customerId,
      category: 'fraudulent',
      status: 'awaiting_merchant_feedback',
      providerStatus: 'needs_response',
      resolution: null,
      refundAmount: 2_500,
      currency: 'USD',
      dueAt: '2026-06-28T23:59:59.000Z',
      resolvedAt: null,
      evidence: null,
      message: null,
      metadata: {},
      createdAt: START,
      updatedAt: START,
    });
    const ledger = async () =>
      (await env.context.storage.ledger.list({ provider: 'bachs', limit: 500 })).items.filter((entry) =>
        entry.reason.startsWith('dispute'),
      );
    expect(await ledger()).toEqual([]);
    expect(await available('USD')).toBe(before - 1_500 - 2_500);

    await collect('1.00');
    expect((await ledger()).map((entry) => [entry.reason, entry.amount]).sort()).toEqual([
      ['dispute_fee', 1_500],
      ['dispute_hold', 2_500],
    ]);
  });
});

describe('uploads', () => {
  it('stores a file, detects its type from its contents, serves it, and deletes it', async () => {
    const created = await upload('/v1/utilities/uploads', [
      { name: 'scope', value: 'product-media' },
      { name: 'file', file: 'hero.png', type: 'text/plain', bytes: PNG },
    ]);
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json();
    expect(body).toEqual({
      upload_id: expect.stringMatching(/^upl_[0-9a-f]{12}$/),
      file_name: 'hero.png',
      mime_type: 'image/png',
      file_size_bytes: PNG.length,
      url: `http://127.0.0.1:8080/bachs/files/${body.upload_id}/hero.png`,
      linked_resource_type: null,
      linked_resource_id: null,
      created_at: '2026-06-14T12:00:00.000Z',
      updated_at: '2026-06-14T12:00:00.000Z',
    });

    const served = await env.app.inject({ method: 'GET', url: new URL(body.url).pathname });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.rawPayload.equals(PNG)).toBe(true);

    expect((await api.get(`/v1/utilities/uploads/${body.upload_id}`)).json()).toEqual(body);
    const deleted = await api.del(`/v1/utilities/uploads/${body.upload_id}`);
    expect(deleted.json()).toEqual({ upload_id: body.upload_id, deleted: true });
    expect((await api.get(`/v1/utilities/uploads/${body.upload_id}`)).statusCode).toBe(404);
    expect((await api.del(`/v1/utilities/uploads/${body.upload_id}`)).statusCode).toBe(404);
  });

  it('refuses a request without a file, and a bad scope', async () => {
    const none = await upload('/v1/utilities/uploads', [{ name: 'scope', value: 'general' }]);
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({
      error_code: 'VALIDATION_ERROR',
      errors: [{ field: 'file', message: 'Field required', type: 'missing' }],
    });
    const json = await api.post('/v1/utilities/uploads', { file: 'x' });
    expect(json.statusCode).toBe(400);
    const scope = await upload('/v1/utilities/uploads', [
      { name: 'scope', value: 'Not Valid' },
      { name: 'file', file: 'a.png', type: 'image/png', bytes: PNG },
    ]);
    expect(scope.statusCode).toBe(400);
  });

  it('takes only PDF, JPEG, PNG or GIF up to 10 MB as a dispute document, and never serves it', async () => {
    const text = await upload('/v1/disputes/uploads', [
      { name: 'file', file: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') },
    ]);
    expect(text.statusCode).toBe(400);
    // A PDF by its name and declared type, but not by its contents.
    const disguised = await upload('/v1/disputes/uploads', [
      { name: 'file', file: 'fake.pdf', type: 'application/pdf', bytes: Buffer.from('not a pdf') },
    ]);
    expect(disguised.statusCode).toBe(400);
    const big = await upload('/v1/disputes/uploads', [
      { name: 'file', file: 'big.pdf', type: 'application/pdf', bytes: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]) },
    ]);
    expect(big.statusCode).toBe(400);
    expect(big.json().error_code).toBe('VALIDATION_ERROR');

    const ok = await upload('/v1/disputes/uploads', [{ name: 'file', file: 'r.pdf', type: 'application/pdf', bytes: PDF }]);
    const id = ok.json().document_id;
    expect((await api.get(`/v1/utilities/uploads/${id}`)).json().url).toBeNull();
    const fetched = await env.app.inject({ method: 'GET', url: `/bachs/files/${id}/r.pdf` });
    expect(fetched.statusCode).toBe(404);
  });

  it('attaches uploads to a product as media, which then cannot be deleted until replaced', async () => {
    const product = await api.product({ currency: 'USD', amount: '10.00' }, {});
    const one = (await upload('/v1/utilities/uploads', [{ name: 'file', file: 'a.png', type: 'image/png', bytes: PNG }])).json();
    const two = (await upload('/v1/utilities/uploads', [{ name: 'file', file: 'b.png', type: 'image/png', bytes: PNG }])).json();

    const patched = await api.patch(`/v1/products/${product}`, { media: [two.upload_id, one.upload_id] });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().media).toEqual([
      {
        id: two.upload_id,
        url: two.url,
        file_name: 'b.png',
        mime_type: 'image/png',
        file_size_bytes: PNG.length,
        created_at: two.created_at,
      },
      expect.objectContaining({ id: one.upload_id }),
    ]);
    expect((await api.get(`/v1/products/${product}`)).json().media).toHaveLength(2);
    expect((await api.get(`/v1/utilities/uploads/${one.upload_id}`)).json()).toMatchObject({
      linked_resource_type: 'product',
      linked_resource_id: product,
    });
    expect((await api.del(`/v1/utilities/uploads/${one.upload_id}`)).statusCode).toBe(409);

    // "Replaces existing media": the one dropped is free again.
    await api.patch(`/v1/products/${product}`, { media: [two.upload_id] });
    expect((await api.del(`/v1/utilities/uploads/${one.upload_id}`)).statusCode).toBe(200);
  });

  it('changes nothing about a product when its media is refused, and keeps an upload on one product', async () => {
    const a = await api.product({ currency: 'USD', amount: '10.00' }, {}, 'A');
    const b = await api.product({ currency: 'USD', amount: '10.00' }, {}, 'B');
    const refused = await api.patch(`/v1/products/${a}`, { name: 'Renamed', media: ['upl_000000000000'] });
    expect(refused.statusCode).toBe(400);
    expect((await api.get(`/v1/products/${a}`)).json().name).toBe('A');

    const shared = (await upload('/v1/utilities/uploads', [{ name: 'file', file: 'x.png', type: 'image/png', bytes: PNG }])).json();
    expect((await api.patch(`/v1/products/${a}`, { media: [shared.upload_id] })).statusCode).toBe(200);
    const elsewhere = await api.patch(`/v1/products/${b}`, { media: [shared.upload_id] });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json().error_code).toBe('INVALID_UPLOAD_REFERENCE');
  });

  it('serves a type a browser would run as a download, never inline', async () => {
    const page = (
      await upload('/v1/utilities/uploads', [
        { name: 'file', file: 'x.html', type: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') },
      ])
    ).json();
    expect(page.mime_type).toBe('text/html');
    const served = await env.app.inject({ method: 'GET', url: new URL(page.url).pathname });
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toBe(`attachment; filename="x.html"; filename*=UTF-8''x.html`);
    expect(served.headers['x-content-type-options']).toBe('nosniff');

    // A name outside Latin-1 still downloads, under its own name.
    const named = (
      await upload('/v1/utilities/uploads', [
        { name: 'file', file: '日本.txt', type: 'text/plain', bytes: Buffer.from('hello') },
      ])
    ).json();
    const download = await env.app.inject({ method: 'GET', url: new URL(named.url).pathname });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent('日本.txt')}`,
    );
  });

  it('refuses a dispute document as product media', async () => {
    const product = await api.product({ currency: 'USD', amount: '10.00' }, {});
    const document = (await upload('/v1/disputes/uploads', [{ name: 'file', file: 'r.pdf', type: 'application/pdf', bytes: PDF }])).json();
    const response = await api.patch(`/v1/products/${product}`, { media: [document.document_id] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('INVALID_UPLOAD_REFERENCE');
  });

  it('refuses more than five media items, and an id that is not an upload', async () => {
    const product = await api.product({ currency: 'USD', amount: '10.00' }, {});
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await upload('/v1/utilities/uploads', [{ name: 'file', file: `${i}.png`, type: 'image/png', bytes: PNG }])).json().upload_id);
    }
    const tooMany = await api.patch(`/v1/products/${product}`, { media: ids });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error_code).toBe('MEDIA_LIMIT_EXCEEDED');
    const unknown = await api.patch(`/v1/products/${product}`, { media: ['upl_000000000000'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error_code).toBe('INVALID_UPLOAD_REFERENCE');
  });
});

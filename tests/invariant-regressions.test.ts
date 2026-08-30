import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { VirtualClock } from '@paybox/core';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Regressions from the 2026-08-30 end-to-end pass of the running emulator.
 *
 * Every test here reproduces a defect that pass found by driving the running
 * server, reduced to the smallest request sequence that showed it. They are
 * kept together rather than spread across the provider suites because each
 * one was a *cross-layer* failure -- a storage constraint surfacing through an
 * adapter, a clock override leaking through the control plane -- and the
 * point is to pin the observable behaviour at the boundary a developer sees.
 */
let app: FastifyInstance;
let context: PayboxContext;
let transport: RecordingTransport;

const START = '2026-05-04T12:00:00.000Z';

async function boot(seed = 'regressions') {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = START;
  process.env.PAYBOX_SEED = seed;
  transport = new RecordingTransport();
  const { config } = loadConfig();
  context = await buildContext({ config, transport, logSink: () => {} });
  app = await buildApp(context);
  await app.ready();
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
  await context.shutdown();
});

const PAYSTACK = { authorization: 'Bearer sk_test_local_suite' };
const STRIPE = {
  authorization: 'Bearer sk_test_local_suite',
  'content-type': 'application/x-www-form-urlencoded',
};
const FLW = { authorization: 'Bearer FLWSECK_TEST-suite-X' };
const WEWIRE = { 'ww-api-key': 'sk_test_local_suite' };

const advance = (value: string) =>
  app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });

async function endpoint(provider: string) {
  await app.inject({
    method: 'POST',
    url: '/api/webhooks/endpoints',
    payload: { url: 'http://localhost:9999/hook', provider, secret: 'whsec_x', eventTypes: [] },
  });
}

const sentTypes = () =>
  transport.sent.map((r) => {
    const body = JSON.parse(r.body) as { type?: string; event?: string; eventType?: string };
    return body.type ?? body.event ?? body.eventType ?? '';
  });

/** A connected account that has completed onboarding. */
async function onboardedAccount(): Promise<string> {
  const account = (
    await app.inject({
      method: 'POST',
      url: '/stripe/v1/accounts',
      headers: STRIPE,
      payload:
        'type=express&country=US&capabilities[card_payments][requested]=true&capabilities[transfers][requested]=true',
    })
  ).json();
  const link = (
    await app.inject({
      method: 'POST',
      url: '/stripe/v1/account_links',
      headers: STRIPE,
      payload: `account=${account.id}&type=account_onboarding`,
    })
  ).json();
  const path = new URL(link.url).pathname;
  await app.inject({
    method: 'POST',
    url: `${path}/complete`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'outcome=complete',
  });
  return account.id as string;
}

describe('reset', () => {
  it('empties everything, including a ledger that references a connected account', async () => {
    const account = await onboardedAccount();
    // A direct charge writes ledger rows owned by the connected account,
    // which `balance_ledger.subaccount_id` references with ON DELETE RESTRICT.
    await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: { ...STRIPE, 'stripe-account': account },
      payload:
        'amount=1000&currency=usd&confirm=true&application_fee_amount=100&payment_method_data[type]=card&payment_method_data[card][number]=4242424242424242',
    });
    await advance('3s');

    const reset = await app.inject({ method: 'POST', url: '/api/reset' });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: 'reset' });

    expect((await context.storage.payments.list({ limit: 1 })).total).toBe(0);
    expect((await context.storage.ledger.list({ limit: 1 })).items).toHaveLength(0);
    expect((await context.storage.subaccounts.list({ limit: 1 })).items).toHaveLength(0);
    expect((await context.storage.events.list({ limit: 1 })).items).toHaveLength(0);
  });
});

describe('virtual time never moves backwards', () => {
  it('reports the clock’s own instant while a job runs under at(), and freeze() keeps it', async () => {
    const start = Date.parse(START);
    const clock = new VirtualClock({ startAt: start, frozen: true });
    clock.set(start + 3_600_000);

    await clock.at(start + 3_000, async () => {
      // The job sees its scheduled instant...
      expect(clock.now()).toBe(start + 3_000);
      // ...but the control surface does not, and a freeze mid-job pins the
      // real instant rather than the job's.
      expect(clock.state().now).toBe(start + 3_600_000);
      expect(clock.freeze().now).toBe(start + 3_600_000);
    });
    expect(clock.now()).toBe(start + 3_600_000);
  });

  it('refuses a freeze or set to an earlier instant, as a 400 through the control plane', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/time' })).json();
    for (const payload of [
      { action: 'set', value: '2020-01-01T00:00:00Z' },
      { action: 'freeze', value: Date.parse(START) - 1 },
      { action: 'advance', value: 'soon' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/time', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
    expect((await app.inject({ method: 'GET', url: '/api/time' })).json().now).toBe(before.now);
  });
});

describe('scenarios', () => {
  async function pendingPayment(reference: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/paystack/transaction/initialize',
      headers: PAYSTACK,
      payload: { email: 'sc@test.local', amount: 1000, currency: 'GHS', reference },
    });
    const detail = (await app.inject({ method: 'GET', url: `/api/payments/${reference}` })).json();
    return detail.payment.id as string;
  }
  const status = async (reference: string) =>
    (await app.inject({ method: 'GET', url: `/api/payments/${reference}` })).json().payment
      .status as string;

  it('late-reversal declines and then actually reverses', async () => {
    await endpoint('paystack');
    const id = await pendingPayment('lr_1');
    const run = await app.inject({
      method: 'POST',
      url: '/api/scenarios/run',
      payload: { scenario: 'late-reversal', paymentId: id },
    });
    expect(run.statusCode).toBe(200);

    await advance('3s');
    expect(await status('lr_1')).toBe('failed');
    await advance('2m');
    expect(await status('lr_1')).toBe('successful');

    const jobs = (await context.storage.jobs.list({ limit: 50 })).items.filter(
      (job) => job.kind === 'scenario.step',
    );
    expect(jobs.map((job) => job.status).sort()).toEqual(['done', 'done', 'done']);
    expect(sentTypes()).toContain('charge.success');
  });

  it('skips steps that land on a payment that has already settled, without failing the job', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: PAYSTACK,
      payload: { email: 'sc@test.local', amount: 1000, currency: 'GHS', reference: 'settled_1', card: { number: '4000000000000000' } },
    });
    await advance('3s');
    expect(await status('settled_1')).toBe('successful');
    const id = (await app.inject({ method: 'GET', url: '/api/payments/settled_1' })).json().payment.id;

    await app.inject({
      method: 'POST',
      url: '/api/scenarios/run',
      payload: { scenario: 'mobile-money-timeout', paymentId: id },
    });
    await advance('6m');

    expect(await status('settled_1')).toBe('successful');
    const failed = (await context.storage.jobs.list({ limit: 50, status: 'failed' })).items;
    expect(failed.filter((job) => job.kind === 'scenario.step')).toHaveLength(0);
  });
});

describe('transfer references', () => {
  it('a reused reference is a duplicate_reference, not a constraint error, on every adapter', async () => {
    const recipient = (
      await app.inject({
        method: 'POST',
        url: '/paystack/transferrecipient',
        headers: PAYSTACK,
        payload: { type: 'nuban', name: 'P', account_number: '0001234567', bank_code: '058', currency: 'NGN' },
      })
    ).json().data.recipient_code;
    const body = { amount: 1000, recipient, reference: 'dup_ref' };
    expect(
      (await app.inject({ method: 'POST', url: '/paystack/transfer', headers: PAYSTACK, payload: body })).statusCode,
    ).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/paystack/transfer', headers: PAYSTACK, payload: body });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ status: false, code: 'duplicate_reference' });

    const beneficiary = (
      await app.inject({
        method: 'POST',
        url: '/wewire/v1/beneficiaries',
        headers: WEWIRE,
        payload: {
          type: 'INDIVIDUAL',
          firstName: 'J',
          lastName: 'D',
          email: 'j@test.local',
          accountDetails: { settlementRail: 'FPS', currency: 'GBP', sortCode: '040004', accountNumber: '12345678' },
        },
      })
    ).json();
    const payout = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/wewire/v1/transactions/initiate-payout',
        headers: WEWIRE,
        payload: {
          idempotencyKey: key,
          from: 'USD',
          to: 'GBP',
          amount: 10,
          beneficiaryAccountId: beneficiary.accounts[0].id,
          description: 'd',
          purposeCode: 'POP001',
          reference: 'SAME REF',
        },
      });
    expect((await payout('k1')).statusCode).toBe(200);
    const reused = await payout('k2');
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('RESOURCE_ALREADY_EXISTS');
    expect((await context.storage.transfers.list({ limit: 10 })).items).toHaveLength(2);
  });
});

describe('Paystack numeric ids', () => {
  it('resolves a refund and a split by the numeric id their create responses returned', async () => {
    await app.inject({
      method: 'POST',
      url: '/paystack/charge',
      headers: PAYSTACK,
      payload: { email: 'n@test.local', amount: 5000, currency: 'GHS', reference: 'num_1', card: { number: '4000000000000000' } },
    });
    await advance('3s');
    const refund = (
      await app.inject({ method: 'POST', url: '/paystack/refund', headers: PAYSTACK, payload: { transaction: 'num_1', amount: 100 } })
    ).json().data;
    const byNumber = await app.inject({ method: 'GET', url: `/paystack/refund/${refund.id}`, headers: PAYSTACK });
    expect(byNumber.statusCode).toBe(200);
    expect(byNumber.json().data.id).toBe(refund.id);

    const subaccount = (
      await app.inject({
        method: 'POST',
        url: '/paystack/subaccount',
        headers: PAYSTACK,
        payload: { business_name: 'V', settlement_bank: '058', account_number: '0123456789', percentage_charge: 20 },
      })
    ).json().data.subaccount_code;
    const split = (
      await app.inject({
        method: 'POST',
        url: '/paystack/split',
        headers: PAYSTACK,
        payload: { name: 'S', type: 'percentage', currency: 'NGN', subaccounts: [{ subaccount, share: 30 }] },
      })
    ).json().data;
    const splitByNumber = await app.inject({ method: 'GET', url: `/paystack/split/${split.id}`, headers: PAYSTACK });
    expect(splitByNumber.statusCode).toBe(200);
    expect(splitByNumber.json().data.split_code).toBe(split.split_code);
  });
});

describe('Stripe', () => {
  it('emits payment_intent.created for an intent created with confirm=true', async () => {
    await endpoint('stripe');
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: STRIPE,
      payload:
        'amount=2000&currency=usd&confirm=true&payment_method_data[type]=card&payment_method_data[card][number]=4242424242424242',
    });
    expect(res.json().status).toBe('processing');
    await advance('3s');
    const types = sentTypes();
    expect(types.indexOf('payment_intent.created')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('payment_intent.created')).toBeLessThan(types.indexOf('payment_intent.succeeded'));
  });

  it('steps up a SetupIntent confirmed separately with a 3-D Secure card', async () => {
    const setup = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/setup_intents',
        headers: STRIPE,
        payload: 'payment_method_data[type]=card&payment_method_data[card][number]=4000002500003155',
      })
    ).json();
    const confirmed = await app.inject({
      method: 'POST',
      url: `/stripe/v1/setup_intents/${setup.id}/confirm`,
      headers: STRIPE,
      payload: 'return_url=http://localhost:3000/back',
    });
    expect(confirmed.json().status).toBe('requires_action');
    expect(confirmed.json().next_action?.redirect_to_url?.url).toContain('/stripe/setup/');
  });

  it('honours several expand[] keys in a query string', async () => {
    const intent = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/payment_intents',
        headers: STRIPE,
        payload:
          'amount=2000&currency=usd&confirm=true&payment_method_data[type]=card&payment_method_data[card][number]=4242424242424242',
      })
    ).json();
    await advance('3s');
    const res = await app.inject({
      method: 'GET',
      url: `/stripe/v1/payment_intents/${intent.id}?expand[]=customer&expand[]=latest_charge`,
      headers: STRIPE,
    });
    expect(typeof res.json().latest_charge).toBe('object');
    expect(res.json().latest_charge.object).toBe('charge');
  });

  it('persists a transfer description and reports an invoice description', async () => {
    const account = await onboardedAccount();
    const transfer = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/transfers',
        headers: STRIPE,
        payload: `amount=500&currency=usd&destination=${account}`,
      })
    ).json();
    const updated = await app.inject({
      method: 'POST',
      url: `/stripe/v1/transfers/${transfer.id}`,
      headers: STRIPE,
      payload: 'description=settled%20order%201',
    });
    expect(updated.json().description).toBe('settled order 1');
    const read = await app.inject({ method: 'GET', url: `/stripe/v1/transfers/${transfer.id}`, headers: STRIPE });
    expect(read.json().description).toBe('settled order 1');

    const customer = (
      await app.inject({ method: 'POST', url: '/stripe/v1/customers', headers: STRIPE, payload: 'email=inv@test.local' })
    ).json();
    const invoice = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/invoices',
        headers: STRIPE,
        payload: `customer=${customer.id}&description=first`,
      })
    ).json();
    expect(invoice.description).toBe('first');
    const changed = await app.inject({
      method: 'POST',
      url: `/stripe/v1/invoices/${invoice.id}`,
      headers: STRIPE,
      payload: 'description=second',
    });
    expect(changed.json().description).toBe('second');
  });
});

describe('Flutterwave v3 card tokens', () => {
  it('returns card.token on a settled charge and accepts it at /tokenized-charges', async () => {
    const charge = (
      await app.inject({
        method: 'POST',
        url: '/flutterwave/v3/charges?type=card',
        headers: FLW,
        payload: {
          card_number: '5377283645077450',
          cvv: '789',
          expiry_month: '09',
          expiry_year: '32',
          currency: 'NGN',
          amount: '100',
          email: 'tok@test.local',
          tx_ref: 'tok_1',
        },
      })
    ).json();
    expect(charge.data.card.token).toBeNull();
    await advance('3s');

    const verify = (
      await app.inject({ method: 'GET', url: `/flutterwave/v3/transactions/${charge.data.id}/verify`, headers: FLW })
    ).json();
    expect(verify.data.status).toBe('successful');
    expect(verify.data.card.token).toMatch(/^flw-t1nf-/);

    const tokenized = await app.inject({
      method: 'POST',
      url: '/flutterwave/v3/tokenized-charges',
      headers: FLW,
      payload: { token: verify.data.card.token, currency: 'NGN', amount: '15', email: 'tok@test.local', tx_ref: 'tok_2' },
    });
    expect(tokenized.statusCode).toBe(200);
    expect(tokenized.json().data.status).toBe('successful');
  });
});

describe('/api/providers', () => {
  it('exposes every adapter’s credentials, including the v4 client credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const byId = Object.fromEntries(
      (res.json().providers as { id: string; keys?: Record<string, unknown> }[]).map((p) => [p.id, p.keys]),
    );
    for (const id of ['paystack', 'stripe', 'flutterwave', 'kora', 'wewire', 'wise']) {
      expect(byId[id]).toBeDefined();
    }
    expect((byId.flutterwave as { v4: { clientId: string; clientSecret: string } }).v4).toEqual(
      context.flutterwaveV4,
    );
    expect((byId.wise as { apiToken: string }).apiToken).toBe(context.wiseKeys.apiToken);
  });
});

describe('review follow-ups', () => {
  it('refuses a custom scenario whose step names an unknown status, outcome or action', async () => {
    for (const [yaml, field] of [
      ['name: typo-status\nsteps:\n  - status: sucessful\n', 'status'],
      ['name: typo-outcome\nsteps:\n  - outcome: declinned\n', 'outcome'],
      ['name: typo-action\nsteps:\n  - action: aprove\n', 'action'],
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/scenarios', payload: { yaml } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
      expect(res.json().message).toContain(`unknown ${field}`);
    }
    const listed = (await app.inject({ method: 'GET', url: '/api/scenarios' })).json().scenarios as {
      name: string;
    }[];
    expect(listed.some((s) => s.name.startsWith('typo-'))).toBe(false);
  });

  it('resolves a stored instrument by BIN and last four, so a separately confirmed 3DS intent steps up', async () => {
    const intent = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/payment_intents',
        headers: STRIPE,
        payload:
          'amount=1500&currency=usd&payment_method_data[type]=card&payment_method_data[card][number]=4000002500003155',
      })
    ).json();
    expect(intent.status).toBe('requires_confirmation');
    const confirmed = await app.inject({
      method: 'POST',
      url: `/stripe/v1/payment_intents/${intent.id}/confirm`,
      headers: STRIPE,
      payload: 'return_url=http://localhost:3000/return',
    });
    expect(confirmed.json().status).toBe('processing');
    await advance('3s');
    const parked = (
      await app.inject({ method: 'GET', url: `/stripe/v1/payment_intents/${intent.id}`, headers: STRIPE })
    ).json();
    expect(parked.status).toBe('requires_action');
    expect(parked.next_action).toBeTruthy();

    // A card outside the published table with the same last four resolves
    // through the generic suffix table on both paths, never the published one.
    const other = (
      await app.inject({
        method: 'POST',
        url: '/stripe/v1/payment_intents',
        headers: STRIPE,
        payload:
          'amount=1500&currency=usd&payment_method_data[type]=card&payment_method_data[card][number]=5555444433333155',
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/stripe/v1/payment_intents/${other.id}/confirm`,
      headers: STRIPE,
      payload: '',
    });
    await advance('3s');
    const settled = (
      await app.inject({ method: 'GET', url: `/stripe/v1/payment_intents/${other.id}`, headers: STRIPE })
    ).json();
    expect(settled.status).toBe('succeeded');
  });
});

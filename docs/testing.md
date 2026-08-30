# Testing with paybox

Two ways to use the emulator: **exploring** by hand — CLI, dashboard, curl —
and **asserting** from an automated suite. This page is about the second, and
about the specific failure modes worth a test of their own.

## The shape of an automated test

1. Start the emulator with **`:memory:`**, a **frozen clock**, a fixed
   **`startAt`** and a fixed **seed**. Every id, timestamp and retry delay is
   now a literal you can assert.
2. Wait for `GET /api/health`.
3. Read the credentials from `GET /api/providers` rather than pasting them.
4. Start a **webhook receiver** inside the test process and register it with
   `POST /api/webhooks/endpoints`.
5. Drive your application, or the provider API directly.
6. Move time with `POST /api/time` — when it returns, every job that came due
   has run and every webhook it produced has been delivered.
7. Assert on the control plane (`/api/payments/:id`), on the provider surface
   (`/transaction/verify/:ref`), and on what your receiver got.

Any language works; it is all HTTP. The example is Node because the emulator
already requires it.

### Example: Vitest, Paystack mobile money

```ts
// paystack.emulator.test.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';

const PORT = 8089;
const BASE = `http://127.0.0.1:${PORT}`;
const RECEIVER_PORT = 3999;

let emulator: ChildProcess;
let receiver: Server;
let secretKey: string;
const received: { headers: Record<string, string>; raw: Buffer }[] = [];

const api = async (path: string, body?: unknown) =>
  (await fetch(`${BASE}${path}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )).json();

beforeAll(async () => {
  emulator = spawn('npx', ['paybox-emulator', 'start',
      '--port', String(PORT), '--database', ':memory:', '--freeze', '--seed', 'suite'],
    { env: { ...process.env, PAYBOX_START_AT: '2026-01-01T00:00:00Z' }, stdio: 'ignore' });

  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  ({ keys: { secretKey } } = await api('/api/providers'));

  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, raw: Buffer.concat(chunks) });
      res.writeHead(200).end();
    });
  }).listen(RECEIVER_PORT);
  await api('/api/webhooks/endpoints', { url: `http://127.0.0.1:${RECEIVER_PORT}/hook`, provider: 'paystack' });
}, 30_000);

afterAll(() => { emulator.kill(); receiver.close(); });

test('a mobile-money prompt is approved and a signed charge.success arrives', async () => {
  const charge = await fetch(`${BASE}/paystack/charge`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'dev@example.com', amount: 25_000, currency: 'GHS', reference: 'momo_1',
      mobile_money: { phone: '0550000000', provider: 'mtn' },
    }),
  }).then((r) => r.json());
  expect(charge.status).toBe(true);

  // The customer has not approved yet.
  expect((await api('/api/payments/momo_1')).payment.status).toBe('requires_action');

  // The test instrument's outcome is due 3 s out. Fast-forward instead of waiting.
  await api('/api/time', { action: 'advance', value: '3s' });

  const { payment } = await api('/api/payments/momo_1');
  expect(payment.status).toBe('successful');
  expect(payment.paidAt).toBe('2026-01-01T00:00:03.000Z');        // exact, because the clock is frozen

  const hook = received.find((h) => JSON.parse(h.raw.toString('utf8')).event === 'charge.success');
  expect(hook).toBeDefined();
  const expected = createHmac('sha512', secretKey).update(hook!.raw).digest('hex');
  expect(timingSafeEqual(Buffer.from(expected), Buffer.from(hook!.headers['x-paystack-signature']))).toBe(true);

  const verify = await fetch(`${BASE}/paystack/transaction/verify/momo_1`, {
    headers: { authorization: `Bearer ${secretKey}` },
  }).then((r) => r.json());
  expect(verify.data.status).toBe('success');
});
```

Points worth noticing:

- `advance` returned only after the outcome job *and* the webhook it produced
  had run — no polling, no sleeps.
- `paidAt` is asserted literally. It is `startAt + 3 s` because the outcome
  job ran *at the instant it was due*.
- The signature is checked over the raw bytes the receiver got, which is the
  check that catches a framework re-serialising the body.

### Pointing the test at your own app instead

Keep steps 1–4 and 6–7, and replace the direct provider call with a request to
your application. Register the webhook endpoint at *your* webhook route, and
assert on what your application did (the order it marked paid, the row it
wrote) as well as on the emulator's view.

## In CI

### GitHub Actions, with `npx`

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- name: Start paybox
  run: npx paybox-emulator start --database :memory: --freeze --seed "${{ github.run_id }}" &
  env:
    PAYBOX_START_AT: 2026-01-01T00:00:00Z
- name: Wait for it
  run: for i in $(seq 1 50); do curl -sf http://127.0.0.1:8080/api/health && break; sleep 0.2; done
- run: npm test
```

### GitHub Actions, as a container service

For a runner without Node, or alongside a non-Node application:

```yaml
services:
  paybox:
    image: dsasante1/paybox:0.1
    env:
      PAYBOX_DATABASE: ":memory:"
      PAYBOX_FREEZE_CLOCK: "1"
      PAYBOX_START_AT: "2026-01-01T00:00:00Z"
      PAYBOX_SEED: "ci"
    ports: ["8080:8080"]
```

Webhooks from the container reach your job's process on the runner's host
network; see [Docker → Reaching your application](docker.md#reaching-your-application-from-the-container)
for the `host.docker.internal` rules elsewhere.

### Determinism checklist

- `PAYBOX_DATABASE=:memory:` — no state from a previous run.
- `PAYBOX_FREEZE_CLOCK=1` and `PAYBOX_START_AT` — every timestamp is known.
- `PAYBOX_SEED` — every id and jitter value is known. Vary it per job if you
  want runs to differ; fix it if you want them identical.
- Do not use `paybox network latency` in an asserting test; it is real time.
- Keep the *sequence* of operations fixed. Ids are stable per run, not per
  resource: inserting an extra payment before the one you assert on changes
  its id.
- If a provider's signature carries a timestamp (Stripe, WeWire), pass the
  emulator's `now` into your verifier or widen its tolerance in test
  configuration — see [Time control](time.md#signatures-that-carry-a-timestamp).

## Recipes

Each of these is a production failure mode that a sandbox cannot produce on
demand. They are written for the CLI; every one is equally a sequence of
`/api` calls.

### Duplicate and replayed webhooks — is the handler idempotent?

```bash
paybox webhook chaos --duplicate true
paybox payment success order_1        # two deliveries, identical bytes
paybox webhook replay whd_…           # a third, later, still identical
```

Expected: one fulfilment. The example app in
[`examples/express-paystack`](../examples/express-paystack) shows the
event-id set that makes this pass.

### The retry ladder — does the endpoint recover?

```bash
paybox webhook fail http_500
paybox payment success order_2
paybox time advance 30s               # five attempts, then exhausted
paybox webhook list --status exhausted
paybox webhook fail off
paybox webhook retry whd_…            # granted one more attempt
```

Use `webhooks.retry.schedule: paystack` and `time advance 12h` for the real
hourly ladder.

### Webhook before the API response — does ordering matter?

```bash
paybox network latency 3000           # hold every provider response open 3 s
```

Now initialize and settle a payment from your app: the `charge.success`
webhook reaches your webhook route while your HTTP client is still waiting for
the `initialize` response. An integration that creates the order row only
after `initialize` returns will receive a webhook for an order it has not
written yet.

### A failure that becomes a success

```bash
paybox scenario run late-reversal pay_…
paybox time advance 5m
```

Declined, then reversed to `successful` two minutes later. Most integrations
write the failure off and never revisit it.

### Out-of-order delivery

```bash
paybox webhook chaos --out-of-order true
paybox payment refund order_3         # refund events arrive shuffled with each other
paybox time advance 10s
```

### Dunning — a renewal that keeps failing

Create a plan and a subscription through the provider API backed by a card
that needs a step-up (`4000 0000 0000 0004` at Paystack), then:

```bash
paybox time advance 32d               # renewal fails: invoice.payment_failed, subscription → attention
paybox subscription list --status attention
paybox time advance 31d               # and again: attention is recoverable, not terminal
```

### A year of billing in one call

```bash
paybox time advance 365d
paybox subscription get sub_…         # twelve invoices, one calendar month apart, each stamped at its period start
```

### Insufficient balance on a payout

```bash
PAYBOX_OPENING_BALANCE=0 paybox start
# POST /paystack/transfer → refused, insufficient balance
paybox balance credit 100000 --currency NGN
# POST /paystack/transfer → pending; reserved amount + fee
paybox balance                        # shows the reservation already taken
```

### An abandoned Stripe checkout

```bash
# POST /stripe/v1/checkout/sessions … then never pay
paybox time advance 25h               # status: expired; checkout.session.expired delivered
```

### A stale Wise quote, an expired v4 token

```bash
paybox time advance 31m               # POST /wise/v1/transfers with that quote → 422
paybox time advance 11m               # a Flutterwave v4 bearer token is now rejected
```

### A dispute nobody answered

```bash
paybox dispute open pay_… --amount 50000
paybox time advance 7d                # charge.dispute.remind; status → awaiting_bank_feedback
paybox dispute resolve dsp_… --amount 50000   # merchant-accepted: a real refund settles
```

### A step-up your app must surface

```bash
paybox payment create --amount 10000 --method card --reference card_3ds
# use 4000 0000 0000 0004 through your own checkout instead for the real path
paybox payment get card_3ds           # requires_action
paybox payment approve card_3ds       # or reject
```

### Simulated provider outages

```bash
paybox network failure 0.25           # a quarter of requests fail at the edge, in the provider's envelope
paybox network reset
```

## Seeding volume

Reporting and export endpoints behave differently either side of a 500-row
page. From a clone, `npm run seed:volume -- ./data/volume.db 520 1000` writes
520 settled payments through the engine; serve that file with
`PAYBOX_DATABASE=./data/volume.db` and exercise the HTTP surface over it. See
[CONTRIBUTING.md](../CONTRIBUTING.md#verifying-against-a-large-database).

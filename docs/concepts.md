# Concepts

Six ideas that every other page assumes. Read this once; the rest of the
documentation will make more sense.

## 1. It is an emulator, not a mock

A mock returns canned responses. paybox runs a real payment engine: every
request drives a state machine, appends to an append-only event log, schedules
jobs, and produces the same events and webhooks the equivalent organic flow
would. `paybox payment success order_1` and a test card that happens to succeed
take the **same code path** — which is why what you learn here transfers to
production.

The consequence worth internalising: the emulator can refuse you. A refund
larger than what is left, a transfer the balance cannot cover, a capture on a
payment that was never authorized, a transition the state machine does not
allow — all are errors, in the provider's own error shape, exactly as the
real API would answer.

## 2. Three surfaces

```
your application ──▶ /paystack, /stripe, /flutterwave, /flutterwave/v4,
                     /kora, /wewire, /wise            provider-compatible APIs
you / your tests ──▶ /api (CLI · dashboard · curl)    the control plane
the payer        ──▶ hosted pages                    checkout, 3-DS, onboarding
```

- **Provider APIs** mirror the upstream contract. Your integration talks to
  these and should not know it is talking to an emulator. Each is an isolated
  Fastify plugin with its own authentication, error envelope and idempotency
  store — a Stripe error never leaks into a Paystack response.
- **The control plane** at `/api` is emulator-only. The CLI is a thin client
  over it and the dashboard calls the same routes, so anything one can do the
  others can too. It has no authentication; it is meant to be reachable only
  from your machine. Reference: [Control API](control-api.md).
- **Hosted pages** are what a provider's `authorization_url` / `url` /
  `checkout_url` points at. paybox serves its own — unmistakably local, with
  the test instruments listed on them — because emulating `initialize`
  without the page it points at would leave the most-used integration path
  untestable. They are deliberately unauthenticated, as the real ones are.

## 3. One engine, many providers

There is one payment model. `provider` is a column on every row, not a
different table per provider. That is what lets the CLI list Paystack, Stripe
and Kora payments in one table, and lets the same `time advance` run a
Paystack subscription renewal and a Stripe checkout expiry in one call.

### Two statuses

Every payment (and refund, transfer, subscription, invoice, dispute) stores
two statuses:

| Field | Example | Who reads it |
|---|---|---|
| `status` — canonical | `successful`, `requires_action`, `non_renewing` | the state machine, `/api`, CLI, dashboard, scenarios |
| `providerStatus` — verbatim | `success` (Paystack), `succeeded` (Stripe), `ongoing`, `non-renewing` | the adapter, when it echoes the provider's wire format |

Canonical vocabulary is snake_case. The full list and the transitions between
them are in [Payment lifecycle](payment-lifecycle.md); each provider's mapping
is in its contract (`docs/<provider>.md`, "Status mapping").

### Handles

A payment has several names, and which one you use depends on where you are:

| Handle | Looks like | Where it works |
|---|---|---|
| paybox id | `pay_7f3k…` | `/api/payments/:id`, every CLI `payment` command, `scenario run` |
| reference | `order_1` (yours, or generated) | Paystack endpoints, `/api/payments/:id` and the CLI **for Paystack payments only** |
| provider id | Paystack numeric id, `pi_…`, `chg_…`, `KPY-CA-…`, an `int64` | that provider's own endpoints |

The CLI and `/api/payments/:id` resolve a paybox id first and then fall back to
a **Paystack** reference. A Stripe payment must be addressed by its `pay_` id
(which `paybox payment list` shows, and which `pi_…` maps onto by swapping the
prefix).

## 4. The event log is the source of truth

Every state change appends an event and updates the row in one transaction.
The payment row is a projection; the log is the history. Nothing ever updates
or deletes an event.

That single mechanism is what gives you, for free:

- the **timeline** on a payment (`paybox payment get`, the dashboard, Paystack's
  `log.history`, `GET /api/payments/:id/timeline`);
- **webhook replay** from an event (`POST /api/events/:id/replay`);
- the **event feed** (`paybox events`, `GET /api/events`, the SSE stream at
  `GET /api/stream`).

Each event carries a per-resource `sequence` that is gapless, so ordering is
total and stable even under a frozen clock where every timestamp is the same.

Webhooks are produced *from* events, after the transaction commits — never
mid-transaction, so a webhook can never describe a state that then rolled
back.

## 5. Virtual time and the job table

Anything that would take time at a real provider — a webhook retry in five
minutes, a payment expiring in ten, a subscription renewing next month, a
dispute deadline in seven days, a 30-second `processing` hop in a scenario —
is a row in a `jobs` table with a `runAt` compared against **virtual** time.

```bash
paybox time advance 2h    # every job due in the next two hours runs now
```

Nothing sleeps. Each job runs *at the instant it was scheduled for*, so a
renewal due on the 1st is stamped the 1st even if you advanced a year in one
go, and a retry due at T+4s computes its next attempt from T+4s. When
`advance` returns, every job that came due has already run.

Two things are *not* on virtual time, deliberately: `paybox network latency`
holds responses open for real milliseconds (its purpose is to let a webhook
race the API response), and the webhook delivery timeout (`webhooks.timeoutMs`)
is a real socket timeout.

Everything about this is in [Time control](time.md).

### Auto-advance

A charge that carries a test instrument schedules its own outcome
`simulation.autoAdvanceDelayMs` (default 3000 ms) into the future — on virtual
time. With the clock flowing, a mobile-money charge approves itself about three
seconds later, the way a real prompt would. With the clock **frozen**, it sits
in `requires_action` until you `paybox time advance 3s`, or drive it by hand
with `paybox payment approve`. This is the most common "why is it stuck"
question; see [Troubleshooting](troubleshooting.md).

## 6. Determinism

The same inputs with the same seed produce byte-identical output. Three
settings make that true:

| Setting | Fixes |
|---|---|
| `seed` / `PAYBOX_SEED` | every generated id, reference, token, key, and retry jitter |
| `freezeClock` / `PAYBOX_FREEZE_CLOCK` | every timestamp — nothing moves unless you move it |
| `startAt` / `PAYBOX_START_AT` | *which* instant the frozen clock starts at |

With all three set, a test can assert a literal `pay_…` id, a literal
`expiresAt`, and a literal retry time instead of matching patterns. Ids come
from labelled random streams, so an extra webhook retry cannot shift the id a
later payment receives.

What stays fixed is the *sequence of operations*: the tenth payment created
in a run always gets the same id, but if your test creates nine payments
instead of ten before it, the id changes. Reproducibility is per run, not per
resource.

## Emulator-only controls

These exist so that a flow which, in production, starts with someone else's
action (a bank transfer, a chargeback, a wallet deposit) can be started
locally. They are never provider surface and production code must never call
them.

| Control | What it stands in for |
|---|---|
| Everything under `/api/*` | the provider's dashboard buttons and your own test harness |
| `POST /paystack/dispute` | the payer's bank raising a chargeback |
| `POST /api/dedicated-accounts/:id/credit` | a customer paying into a virtual account |
| `POST /api/balance/credit` | money arriving in your Paystack balance |
| `POST /wewire/paybox/wallets/credit` | a deposit into a WeWire wallet |
| `GET /wewire/paybox/ghana-codes` | a reference page WeWire publishes as documentation |
| `GET /wise/paybox/webhook-public-key` | the key a Wise subscriber would fetch from Wise |
| `GET /paystack/subscription/:code/invoices` | billing history Paystack shows in its dashboard |
| the hosted pages (`/paystack/checkout/…`, `/stripe/checkout/…`, `/stripe/setup/…`, `/stripe/connect/onboard/…`, `/flutterwave/checkout/…`, `/flutterwave/3ds/…`, `/flutterwave/v4/redirect/…`, `/kora/checkout/…`) | the provider's own hosted pages |
| `metadata.paybox_outcome` on a Paystack charge | choosing an outcome on a channel with no instrument to encode one in |
| `PAYBOX_ALLOW_ANY_KEY` | nothing — it only relaxes the test-key format check; live keys stay refused |

Contrast these with sandbox controls the **provider itself** ships, which
paybox implements as published rather than inventing an equivalent: Kora's
`/charges/mobile-money/sandbox/authorize-stk` and
`/virtual-bank-account/sandbox/credit`, Wise's
`GET /simulation/transfers/{id}/{status}` and `POST /simulation/balance/topup`,
and Flutterwave v4's `X-Scenario-Key` header. An existing sandbox script that
uses those drives the emulator unchanged.

## Money

- Integer minor units, always. No floating point reaches storage.
- **No FX happens in the engine.** The WeWire and Wise adapters quote from a
  fixed rate table (deterministic, not market data) and record the quoted
  destination amount as metadata; the ledger stays in the source currency.
- **The balance is a fold over an append-only ledger**, never a stored number.
  A transfer reserves its amount (plus fee, where the provider charges one)
  when it is *queued*, so two queued payouts cannot spend the same money; a
  failed or reversed transfer credits the reservation back.
- Every provider and currency starts at an **opening test float**
  (`balance.opening`, default 10,000,000 minor units), which is config rather
  than a ledger row so `paybox reset` cannot wipe it. Set it to `0` to hit the
  insufficient-balance path from the first payout.

## Safety

No code path reaches a payment network. Live keys are refused with HTTP 403
and that is not configurable. Card numbers are reduced to a BIN and last four
before anything is stored; the CVV is never read. The server binds `127.0.0.1`
unless told otherwise, and `/api` has no authentication — do not expose it.
[SECURITY.md](../SECURITY.md) states the guarantees and their limits.

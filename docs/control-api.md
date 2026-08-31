# Control API

The emulator's own control plane, mounted at `/api`. The CLI is a thin client
over exactly these routes and the dashboard calls the same ones, so this page
is the definitive list of what either can do.

- No authentication. It is designed to be reachable only from your machine.
- JSON in, JSON out. `content-type: application/json` on writes; an empty
  body on a POST is accepted.
- Canonical vocabulary throughout — `successful`, not `success`.
- Amounts are integer minor units.
- Interactive reference: `GET /docs` — Scalar, served from the emulator
  itself (no CDN; works offline). It lists **every route from every adapter's
  coverage manifest** — the same source the drift test enforces — grouped by
  provider, each entry carrying its coverage status. Schemas appear only
  where a shape has been hand-transcribed; everywhere else the contract in
  `docs/<provider>.md` is authoritative.

Every route below is relative to the emulator base, `http://127.0.0.1:8080`
by default.

## Errors

```json
{ "error": "not_found", "message": "No payment matching \"order_9\".", "details": {} }
```

| HTTP | `error` | When |
|---|---|---|
| 400 | `validation_failed`, `invalid_request`, `refund_exceeds_amount`, `unsupported_currency` | bad input; also any payment-outcome code (`card_declined`, `insufficient_funds`…) that a provider surface would report as HTTP 200 |
| 401 | `authentication_failed` | never from `/api` itself; seen when a control route drives a provider path |
| 404 | `not_found` | unknown id, reference, scenario, delivery |
| 409 | `invalid_state_transition`, `duplicate_reference`, `idempotency_conflict` | the state machine refused, or a reference/key was reused |
| 500 | `internal_error` | a bug — please report it |

`details` carries machine-readable extras, e.g. `{ from, to, allowed }` on a
refused transition.

## Health and overview

### `GET /api/health`

```json
{ "status": "ok", "version": "0.2.0", "time": "2026-01-01T00:00:00.000Z",
  "clock": { "mode": "frozen", "now": 1767225600000, "offsetMs": -20000000 } }
```

What the Docker `HEALTHCHECK` and `paybox status` poll.

### `GET /api/overview`

Payment counts by canonical status (with `pending` folding in `processing` and
`requires_action`, and `refunded` folding in `partially_refunded`), webhook
delivery counts, the twenty most recent events, the clock state, the network
profile and the current webhook chaos settings. What the dashboard's Overview
tab renders.

### `GET /api/providers`

```json
{ "providers": [
    { "id": "paystack", "enabled": true, "basePath": "/paystack", "status": "partial",
      "docs": "/docs/paystack",
      "keys": { "secretKey": "sk_test_local_…", "publicKey": "pk_test_local_…" } },
    { "id": "stripe", "…": "…", "keys": { "secretKey": "sk_test_local…", "publishableKey": "pk_test_local…" } },
    { "id": "flutterwave", "…": "…",
      "keys": { "secretKey": "FLWSECK_TEST-…", "publicKey": "FLWPUBK_TEST-…", "encryptionKey": "…",
                "v4": { "clientId": "flw-test-local-…", "clientSecret": "flwsec-test-local-…" } } },
    { "id": "kora",   "keys": { "secretKey": "…", "publicKey": "…" } },
    { "id": "wewire", "keys": { "secretKey": "…" } },
    { "id": "wise",   "keys": { "apiToken": "wise_test_local_…" } }
  ],
  "keys": { "secretKey": "sk_test_local_…", "publicKey": "pk_test_local_…" } }
```

The one place a script can fetch every local credential. Top-level `keys` is
the Paystack pair, kept for older clients. `status` is `partial` for every
adapter, by design — see each provider's contract for what that means.

## Payments

### `GET /api/payments`

| Query | Default | |
|---|---|---|
| `status` | — | canonical status |
| `provider` | — | `paystack`, `stripe`, `flutterwave`, `kora`, `wewire`, `wise` |
| `reference` | — | exact match |
| `limit` | `50` | page size |
| `offset` | `0` | |

Returns a page, `{ "items": [Payment, …], "total": <count> }`, newest first.

### `GET /api/payments/:id`

`:id` is a paybox id (`pay_…`) or a **Paystack** reference; every payment
route below resolves it the same way.

```json
{ "payment": Payment,
  "formattedAmount": "GHS 250.00",
  "timeline": [PayboxEvent, …],
  "refunds": [Refund, …],
  "webhookDeliveries": [WebhookDelivery, …] }
```

`timeline` is the payment's slice of the event log, in sequence order.
`webhookDeliveries` are the deliveries produced by those events (from the
most recent 100 deliveries overall).

### `GET /api/payments/:id/timeline` → `{ "events": [...] }`

### `POST /api/payments/:id/simulate`

```json
{ "outcome": "success", "immediate": false }
```

Drives the payment through the state path for `outcome` (default `success`):
`success`, `declined`, `insufficient_funds`, `expired_card`,
`authentication_required`, `authentication_failed`, `timeout`,
`processing_error`, `customer_rejected`, `network_error`. `immediate: true`
skips the intermediate `processing` hop and jumps to the final state. Each hop
is a real transition with its own event and webhooks. Returns the payment.
Paths are tabulated in [Payment lifecycle](payment-lifecycle.md#outcomes).

### `POST /api/payments/:id/cancel` · `/expire` · `/authorize` · `/capture`

Direct transitions. `capture` requires `authorized` and walks
`processing → successful`. `expire` records `transaction_timeout` as the
failure code. Each returns the payment, or 409 if the state machine refuses.

### `POST /api/payments/:id/authenticate`

```json
{ "approved": true }
```

Completes a pending step-up — 3-D Secure, OTP, mobile-money prompt. Requires
`requires_action`. `approved: true` applies `success`; `false` applies
`customer_rejected`.

### `POST /api/payments/:id/refund`

```json
{ "amount": 5000, "reason": "partial return", "settle": true }
```

Omit `amount` for a full refund of what remains. Refund arithmetic is
enforced (`refund_exceeds_amount`, 400). **`settle` defaults to `true`**: the
refund is created and immediately transitioned to `successful`, so the payment
moves to `refunded` / `partially_refunded` and the balance is debited. Pass
`settle: false` to leave it `pending` and drive it yourself. Returns the
refund.

Refunds raised through a *provider* endpoint (`POST /paystack/refund`,
`POST /stripe/v1/refunds`…) settle asynchronously on virtual time instead.

## Refunds, transfers, customers

- `GET /api/refunds` · `GET /api/transfers` · `GET /api/customers` — pages of
  100, newest first. No filters.
- `POST /api/transfers/:id/settle` with `{ "status": "successful" }` (default)
  or `{ "status": "failed" }`. Walks `processing` then the target, releasing
  the reservation back to the balance on failure.

## Dedicated virtual accounts

- `GET /api/dedicated-accounts`
- `POST /api/dedicated-accounts/:id/credit` — **emulator-only.** `:id` is the
  paybox id or the account number.

  ```json
  { "amount": 250000, "currency": "NGN", "reference": "inbound_1", "senderName": "A CUSTOMER" }
  ```

  Only `amount` is required. Creates a `bank_transfer` payment for the
  account's customer and settles it through the ordinary state machine, so
  the same events and the same `charge.success` fire as for any other
  payment. Returns 201 with the settled payment.

## Stored instruments and recurring billing

- `GET /api/authorizations` — every reusable (and non-reusable) handle a
  charge or setup has minted.
- `GET /api/plans`
- `GET /api/subscriptions?status=<canonical>` — `trialing`, `active`,
  `non_renewing`, `attention`, `completed`, `cancelled`.
- `GET /api/subscriptions/:id` → `{ subscription, plan, invoices }` — the
  billing history, one invoice per period, each stamped at its period start.
- `POST /api/subscriptions/:id/disable` with `{ "status": "non_renewing" }`
  (default) or any legal target such as `cancelled`.
- `GET /api/invoices`

Plans and subscriptions are *created* through the provider APIs
(`POST /paystack/plan`, `POST /stripe/v1/prices`, …); the control plane
reads and controls them.

## Marketplace

- `GET /api/subaccounts` — Paystack subaccounts, Stripe connected accounts,
  WeWire sub-customers: all the same canonical resource.
- `GET /api/splits`

## Balance

- `GET /api/balance?currency=GHS` →
  `{ "balances": [ { "currency": "GHS", "balance": 10000000 } ] }`

  **Folds the Paystack ledger.** Lists every currency that has seen movement,
  or `NGN` on a fresh emulator. Other providers report their balances through
  their own endpoints (`GET /stripe/v1/balance`, `GET /kora/…/balances`,
  `GET /wewire/v1/wallets`, `GET /wise/v4/profiles/{id}/balances`).
- `GET /api/balance/ledger` — the last 100 ledger entries, in sequence order.
- `POST /api/balance/credit` — **emulator-only.**

  ```json
  { "amount": 500000, "currency": "NGN", "reason": "manual_credit" }
  ```

  Credits the Paystack balance. Returns 201 with the ledger entry.

## Disputes

- `GET /api/disputes?status=<canonical>`
- `POST /api/disputes` — **emulator-only** (a chargeback originates with the
  payer's bank).

  ```json
  { "paymentId": "pay_…", "category": "chargeback", "refundAmount": 50000, "message": "…" }
  ```

  Requires a payment that collected money; `refundAmount` defaults to the full
  amount and cannot exceed it. Schedules the deadline reminder job. 201.
- `POST /api/disputes/:id/resolve`

  ```json
  { "resolution": "merchant-accepted", "message": "…", "refundAmount": 50000 }
  ```

  `merchant-accepted` (default) raises and settles a real refund;
  `declined` closes the dispute with no money moving.

## Events

- `GET /api/events?limit=100&type=payment.successful&resourceId=pay_…`
  — the append-only log, newest first. `type` is the *canonical* event name.
- `POST /api/events/:id/replay` → `{ "deliveries": [...] }` — formats and
  signs the event again from scratch and creates fresh deliveries for every
  matching endpoint. Different from replaying a *delivery*, which resends the
  stored bytes.

## Webhooks

### Endpoints

- `GET /api/webhooks/endpoints` → `{ "endpoints": [...] }`
- `POST /api/webhooks/endpoints`

  ```json
  { "url": "http://localhost:3000/webhooks/paystack",
    "provider": "paystack",
    "secret": "optional — see the defaults below",
    "eventTypes": ["charge.success"],
    "description": "optional" }
  ```

  `provider` defaults to `paystack` and must be one of the six; an unknown
  value is a 400 rather than an endpoint nothing can ever match. An endpoint
  only ever receives its own provider's events. `eventTypes` are **provider**
  event names; empty means everything that provider emits. `secret` is what
  deliveries are signed with; omit it and the endpoint gets one shaped the
  way that provider's verifier expects:

  | Provider | Default secret |
  |---|---|
  | Paystack, Kora | that provider's local secret key — what they sign with |
  | Flutterwave | the local Flutterwave secret key, standing in for the merchant-chosen hash |
  | Stripe | a fresh `whsec_local…` per endpoint |
  | WeWire | a fresh `whsec_<base64>` per endpoint, so Standard Webhooks libraries can decode it |
  | Wise | `wise-rsa-signed` — unused; Wise signs with RSA |

  The response carries the secret in full. 201.
- `PATCH /api/webhooks/endpoints/:id` — any of `url`, `secret`, `enabled`,
  `eventTypes`, `description`.
- `DELETE /api/webhooks/endpoints/:id` — 204.

### Deliveries

- `GET /api/webhooks/deliveries?status=<s>&limit=100` — `pending`,
  `delivering`, `succeeded`, `failed`, `exhausted`.
- `GET /api/webhooks/deliveries/:id` — the full record: the exact `payload`
  bytes, the `headers` sent, `attempt`/`maxAttempts`, `responseStatus`,
  `responseBody`, `errorMessage`, `durationMs`, `nextRetryAt`,
  `replayOfDeliveryId`.
- `POST /api/webhooks/deliveries/:id/retry` — one more attempt on the same
  row, now; reopens an exhausted delivery.
- `POST /api/webhooks/deliveries/:id/replay` — a **new** delivery carrying the
  identical payload (and identical signature, unless the provider re-signs
  per attempt). Returns the new delivery with `replayOfDeliveryId` set.

### Chaos

- `GET /api/webhooks/chaos`
- `POST /api/webhooks/chaos` — **merges** into the current settings:

  ```json
  { "forceOutcome": "http_500",
    "failureRate": 0.3,
    "latencyMs": 2000,
    "duplicate": true,
    "outOfOrder": true }
  ```

  | Field | Effect |
  |---|---|
  | `forceOutcome` | every attempt gets this result without touching the network: `http_500`, `http_400`, `http_429`, `timeout`, `connection_refused`, `malformed_response` (a 200 whose body is not JSON). `null` turns it off. |
  | `failureRate` | fraction of attempts that get `http_500`, drawn from the seeded stream |
  | `latencyMs` | virtual delay before a delivery's first attempt |
  | `duplicate` | two delivery rows per endpoint per event |
  | `outOfOrder` | each delivery gets an independent random delay of up to 5 s of virtual time, so a burst arrives shuffled |
- `DELETE /api/webhooks/chaos` — everything off.

## Network simulation

Applies to the provider routes, not to `/api`.

- `GET /api/network` → `{ "latencyMs": 0, "failureRate": 0, "failureStatus": 500 }`
- `POST /api/network` — merges any of those three. `latencyMs` is applied to
  the **response** in real milliseconds; `failureRate` answers that fraction
  of requests with `failureStatus` in the provider's own error envelope
  *before* the handler runs, so the transaction never existed.
- `DELETE /api/network` — back to zero.

## Time

- `GET /api/time` → `{ "mode": "system" | "frozen", "now": <epoch ms>, "offsetMs": <virtual − real> }`
- `POST /api/time`

  | Body | Effect |
  |---|---|
  | `{ "action": "freeze" }` | pin virtual time at now |
  | `{ "action": "freeze", "value": "2026-03-01T00:00:00Z" }` | pin it at a later instant |
  | `{ "action": "unfreeze" }` | resume flowing from the current virtual instant |
  | `{ "action": "advance", "value": "30s" }` | move forward; `ms`, `s`, `m`, `h`, `d`, decimals allowed |
  | `{ "action": "set", "value": "2026-06-01T00:00:00Z" }` | jump to an instant |

  Every action returns the new clock state **after every job that came due
  has run**. Moving backwards, or an unparseable value, is a 400.

## Scenarios

- `GET /api/scenarios` → `{ "scenarios": [ { name, description, steps } ] }`
- `POST /api/scenarios/run` with `{ "scenario": "late-reversal", "paymentId": "pay_…" }`
  — `paymentId` must be a paybox id. Returns
  `{ id: "run_…", scenario, paymentId, steps, startedAt, completesAt }`; the
  steps are now jobs on virtual time.
- `POST /api/scenarios` with `{ "yaml": "<scenario document>" }` — registers a
  custom scenario for the life of the process. Validation errors name the
  offending step. Format: [Scenarios](scenarios.md).

## Jobs, logs, lifecycle

- `GET /api/jobs?status=<ready|leased|done|failed|cancelled>` — the durable
  queue, 100 rows. Each job has a `kind` (`webhook.deliver`, `payment.simulate`,
  `payment.expire`, `refund.settle`, `transfer.settle`, `scenario.step`,
  `dispute.remind`, `subscription.invoice`, `subscription.charge`,
  `subscription.trial_ending`), a `runAt` on virtual time, and a
  `groupKey` so a payment going terminal can cancel its own pending expiry.
- `GET /api/logs?limit=200` → `{ "logs": [...] }` — the in-memory ring of
  structured log entries.
- `POST /api/seed` — creates, through the real engine, one successful card
  payment, one declined, one mobile-money payment awaiting authorization, one
  partially refunded, and one pending transfer. Returns their ids keyed by
  role. Safe to call repeatedly.
- `POST /api/reset` — empties every table. Credentials, config, the opening
  float, chaos and network settings and the clock are untouched.

## Live stream

### `GET /api/stream`

Server-sent events. Emits `hello` once (clock state), then `event` for every
canonical event as it commits and `clock` for every clock change.

```bash
curl -N http://127.0.0.1:8080/api/stream
```

```js
const stream = new EventSource('http://127.0.0.1:8080/api/stream');
stream.addEventListener('event', (e) => console.log(JSON.parse(e.data).type));
```

## Not under `/api`

| Route | |
|---|---|
| `GET /` | redirects to the dashboard |
| `GET /dashboard` | the single-page dashboard |
| `GET /docs` | the Scalar API reference, self-hosted; every served route, generated from the coverage manifests |
| `GET /openapi.json` | the OpenAPI 3.1 document behind it (also at `/docs/openapi.json` and `/docs/openapi.yaml`) |

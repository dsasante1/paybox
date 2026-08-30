# Dashboard

<http://127.0.0.1:8080/dashboard> — `GET /` redirects there. A single
self-contained HTML page served by the emulator: no build step, no external
assets, no authentication. It calls the same `/api` routes the CLI does, so
anything you see or click here has a command-line equivalent in
[cli.md](cli.md) and a route in [control-api.md](control-api.md).

It updates live over the event stream (below); you do not need to refresh.

## Views

### Overview

Payment counts by status, webhook delivery counts, the clock's mode and
current virtual instant, the active network profile and webhook chaos
settings, and a **live activity** feed of the most recent events.

### Payments

Every payment across every provider, newest first, with provider, amount,
method and canonical status. Click one for the detail view:

- amount, status, provider status, method, failure code;
- the **timeline** — the payment's slice of the event log, one row per
  transition, in sequence order;
- **webhook deliveries** produced by those events, with HTTP status, attempt
  count, duration, and a **Replay** button per delivery;
- refunds against it;
- the raw payment JSON.

### Webhooks

- **Endpoints** — register one by URL, remove one, and see the (truncated)
  signing secret each uses. The form registers a **Paystack** endpoint with
  the default secret; for another provider or a custom secret use
  `paybox webhook add --provider … --secret …` or the API.
- **Failure simulation** — the same knobs as `paybox webhook fail` and
  `paybox webhook chaos`: forced outcome (`none` to clear it), failure rate,
  duplicate delivery, out-of-order delivery. Chaos latency is API-only.
- **Deliveries** — every delivery with its event type, URL, status, HTTP
  response, attempts and next retry time. **Retry** re-runs a delivery in
  place; **Replay** creates a new one with the identical signed payload. The
  distinction is explained in [webhooks.md](webhooks.md#retry-vs-replay).

### Events

The append-only log, newest first: time, canonical type, resource id, and
the `previous → current` transition for state changes. **Replay webhook**
re-formats and re-signs the event from scratch and creates fresh deliveries
for every matching endpoint.

### Simulation

- **Time control** — freeze, unfreeze, advance by a duration. The clock state
  in the header updates immediately; every job that came due has run by the
  time the button returns.
- **Network simulation** — latency and failure rate for provider responses.
- **Scenarios** — the registered scenarios with their step counts, and a
  picker to run one against any of the fifty most recent payments.

## The live event stream

The dashboard subscribes to `GET /api/stream`, a server-sent-events endpoint
you can use directly:

```bash
curl -N http://127.0.0.1:8080/api/stream
```

```
event: hello
data: {"time":"2026-01-01T00:00:00.000Z","clock":{"mode":"frozen","now":1767225600000,"offsetMs":0}}

event: event
data: {"id":"evt_…","type":"payment.successful","provider":"paystack","resourceId":"pay_…","sequence":3,…}

event: clock
data: {"mode":"frozen","now":1767225603000,"offsetMs":3000}
```

| Event | When |
|---|---|
| `hello` | once, on connect, with the clock state |
| `event` | every canonical event, as its transaction commits |
| `clock` | every freeze, unfreeze, advance or set |

Reconnection is automatic (`retry: 2000`). Because events are published only
after commit, the stream can never show a state that then rolled back.

## Limits

- It is intentionally plain — dense tables, no charts — and a React
  dashboard is the intended upgrade.
- It shows the most recent rows of each table (100 payments, 100 deliveries,
  150 events); use the CLI's `--json` or the control API for exhaustive
  listings.
- No authentication. It is reachable only from loopback unless you bound the
  server elsewhere; see [SECURITY.md](../SECURITY.md).

# CLI

The `paybox` command is a thin REST client over the emulator's control plane —
the same `/api` routes the dashboard uses. One implementation, one set of
semantics: anything the CLI can do, the dashboard and a curl can too, and the
route each command calls is named below.

```bash
npm install -g paybox-emulator     # puts `paybox` on your PATH
npx paybox-emulator <command>      # the same, without installing
npm run cli -- <command>           # from a clone, straight from the source
```

## Global options

| Option | Effect |
|---|---|
| `--url <url>` | emulator to talk to; default `$PAYBOX_URL` or `http://127.0.0.1:8080` |
| `--json` | raw JSON instead of tables — the exact response body, for scripting |
| `--version` | the version, as `/api/health` reports it |
| `--help` | on the program or on any command |

A failure prints `✗ <message>` to stderr and exits `1`. Anything the server
refuses (an illegal transition, an unknown id) is reported with the server's
message.

**Which id?** Every `<id>` that names a payment accepts a paybox id
(`pay_…`) and, **for Paystack payments only**, the reference. Other providers'
payments are addressed by `pay_…`, which `payment list` shows. Delivery ids
are `whd_…`, endpoint ids `whe_…`, subscription ids `sub_…`, dispute ids
`dsp_…`, scenario runs `run_…`.

## Command index

| Command | Does | Calls |
|---|---|---|
| `start` | run the emulator in the foreground | — |
| `status` | version, clock, every credential, counts | `GET /api/health`, `/api/overview`, `/api/providers` |
| `coverage [provider]` | what each adapter implements, from its manifest | — (local) |
| `provider` | providers, base paths, coverage status | `GET /api/providers` |
| `reset --yes` | delete every payment, event, webhook, job | `POST /api/reset` |
| `seed` | create representative data through the engine | `POST /api/seed` |
| `logs [-n]` | recent structured log entries | `GET /api/logs` |
| `jobs` | the scheduled job queue | `GET /api/jobs` |
| `events [-n]` | the event log | `GET /api/events` |
| `payment …` | list, inspect, create, drive, refund | `/api/payments/*`, provider routes |
| `webhook …` | endpoints, deliveries, retry, replay, chaos | `/api/webhooks/*` |
| `scenario …` | list and run scenarios | `/api/scenarios/*` |
| `time …` | freeze, unfreeze, advance | `POST /api/time` |
| `network …` | latency, failure rate, reset | `/api/network` |
| `plan list` | plans | `GET /api/plans` |
| `subscription …` | list, inspect, disable | `/api/subscriptions/*` |
| `authorizations` | stored instruments | `GET /api/authorizations` |
| `balance …` | show, credit | `/api/balance/*` |
| `dispute …` | list, open, resolve | `/api/disputes/*` |

## Lifecycle

```bash
paybox start                               # foreground; Ctrl-C stops it
paybox start --port 9000 --host 127.0.0.1
paybox start --database :memory:           # nothing survives a restart
paybox start --freeze                      # clock frozen from the first instant
paybox start --seed ci-run-1               # identical seed ⇒ identical ids and jitter
```

`start` flags set the matching `PAYBOX_*` variable before the config loads,
so they win over `paybox.yml` and the environment. Everything else — bind
warnings, retry schedule, opening balance — is in [Configuration](configuration.md).
There is no `paybox stop`; the process runs in the foreground.

```bash
paybox status
```

Prints the URL, version and virtual time; whether the clock is frozen; every
test credential each adapter issued (the same values as the startup banner);
and payment and webhook counts. When an adapter's error says "see
`paybox status`", this is what it means.

```bash
paybox coverage                  # one line per adapter: compatible / partial / emulator-only counts
paybox coverage kora             # every endpoint of one adapter, grouped by status
paybox coverage --json
paybox provider                  # what the running server has enabled
```

`coverage` reads the manifests bundled with the CLI — the same ones the test
suite checks against the router — so it works without a server and cannot
disagree with what is served.

```bash
paybox reset --yes               # refuses from a terminal without --yes; proceeds in a script
paybox seed                      # a successful, a declined, a momo awaiting approval,
                                 # a partially refunded payment and a pending transfer
paybox logs -n 100
paybox jobs                      # kind, status, runAt, attempt — what `time advance` will run
paybox events -n 100             # time, type, resource, previous → current
```

`reset` empties the database only: credentials, config, the opening float,
chaos and network settings and the clock are untouched.

## Payments

```bash
paybox payment list
paybox payment list --status requires_action
paybox payment list --provider stripe --limit 100
paybox payment get order_1                    # detail, timeline, deliveries
paybox payment get pay_7f3k…
```

### Creating one

```bash
paybox payment create --amount 10000                        # Paystack checkout link
paybox payment create --amount 25000 --currency GHS --method mobile_money --reference momo_1
paybox payment create --amount 10000 --method card
paybox payment create --amount 10000 --method bank
paybox payment create --provider stripe --amount 2000 --currency usd
paybox payment create --provider stripe --amount 2000 --currency usd --method card
```

| Option | Default | |
|---|---|---|
| `--provider` | `paystack` | `paystack` or `stripe`; other providers are driven through their own APIs |
| `--amount` | required | minor units |
| `--currency` | `GHS` | |
| `--method` | — | Paystack: `card`, `mobile_money`, `bank`; Stripe: `card` only |
| `--reference` | generated | your own reference |
| `--email` | `test@paybox.local` | |

`create` goes through the **provider's own endpoint** with the local key,
so the result is indistinguishable from one your application made. Without
`--method`, Paystack returns a checkout link (`/transaction/initialize`) and
Stripe an unconfirmed PaymentIntent. With a method, Paystack charges a
successful test instrument (`0550000000` MTN, `4000 0000 0000 0000`, or
bank `058` / `0000000000`) via `/charge`, and Stripe confirms with
`4242 4242 4242 4242`. The instrument's outcome then plays out after the
auto-advance delay — `paybox time advance 3s` under a frozen clock.

### Driving one

```bash
paybox payment success order_1
paybox payment fail order_1 --reason insufficient_funds
paybox payment cancel order_1
paybox payment expire order_1
paybox payment authorize order_1
paybox payment capture order_1                # only from authorized
paybox payment approve order_1                # complete a 3-DS / OTP / momo prompt
paybox payment reject order_1                 # the customer declines it
```

`--reason`: `declined` (default), `insufficient_funds`, `expired_card`,
`authentication_required`, `authentication_failed`, `timeout`,
`processing_error`, `customer_rejected`, `network_error`. Each walks a real
state path — tabulated in [Payment lifecycle](payment-lifecycle.md#outcomes) —
and the same events and webhooks fire as for the organic flow. A transition the
state machine forbids is refused with the list of what would be allowed.

### Refunding

```bash
paybox payment refund order_1                            # everything that remains
paybox payment refund order_1 --amount 5000 --reason "partial return"
```

Settles immediately (the payment becomes `partially_refunded` / `refunded`
and the balance is debited). Refunds raised through a provider endpoint
settle over virtual time instead.

## Webhooks

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
paybox webhook add http://localhost:3000/webhooks/stripe --provider stripe --secret whsec_local
paybox webhook endpoints
```

An endpoint receives every event **for its provider** (`--provider` defaults
to `paystack`). `--secret` is what deliveries are signed with; it defaults to
the Paystack local secret key for every provider, so pass the value your
verifier holds for anything else. Filtering by event type (`eventTypes`) and
disabling an endpoint are available on the API (`PATCH /api/webhooks/endpoints/:id`).

```bash
paybox webhook list
paybox webhook list --status exhausted --limit 100      # pending | delivering | succeeded | failed | exhausted
paybox webhook list --json                              # includes payload, headers, response body
paybox webhook retry whd_…                              # one more attempt on the same delivery, now
paybox webhook replay whd_…                             # a new delivery, identical bytes and signature
```

```bash
paybox webhook fail                    # http_500
paybox webhook fail timeout            # http_500 | http_400 | http_429 | timeout | connection_refused | malformed_response
paybox webhook fail off
paybox webhook chaos --failure-rate 0.3
paybox webhook chaos --duplicate true --out-of-order true
paybox webhook chaos --reset           # every chaos setting off
```

`chaos` **merges**: each flag changes one knob. `--reset` clears all of them,
including a forced outcome. Details in [Webhooks](webhooks.md).

## Time

```bash
paybox time freeze
paybox time advance 30s        # ms | s | m | h | d — decimals allowed
paybox time advance 2h
paybox time advance 365d
paybox time unfreeze
```

`advance` returns after **every job that came due has run** — retries,
expiries, renewals, scenario steps — each at the instant it was due. Virtual
time never moves backwards. Jumping to a specific instant (`set`) and
freezing at a future instant are API-only: [Time control](time.md#the-api).

## Network

```bash
paybox network latency 3000    # hold provider responses open for 3 s (real time)
paybox network failure 0.25    # fail a quarter of provider requests before the handler runs
paybox network reset
```

Applies to the provider routes, not to `/api`, so the CLI keeps working while
your application sees a slow or flaky provider.

## Scenarios

```bash
paybox scenario list
paybox scenario run late-reversal pay_…       # takes a paybox id, not a reference
paybox time advance 5m
```

Built-ins: `mobile-money-success`, `mobile-money-timeout`,
`mobile-money-rejected`, `card-insufficient-funds`, `card-3ds-success`,
`slow-success`, `late-reversal`. Writing and registering your own is on the
API: [Scenarios](scenarios.md).

## Recurring billing

```bash
paybox plan list
paybox subscription list
paybox subscription list --status attention   # renewals that are failing
paybox subscription get sub_…                 # detail plus every invoice
paybox subscription disable sub_…             # → non_renewing
```

Plans and subscriptions are created through the provider API
(`POST /paystack/plan`, `POST /paystack/subscription`, `POST /stripe/v1/prices`,
`POST /stripe/v1/subscriptions`); the CLI reads and controls them. Then:

```bash
paybox time advance 365d
paybox subscription get sub_…    # twelve invoices, one calendar month apart
```

## Stored instruments

```bash
paybox authorizations            # code, channel, last4, reusable, active
```

Charging a card mints one; charging the same card for the same customer again
reuses it. Only `reusable` codes can be charged off-session — mobile money
never can.

## Balance

```bash
paybox balance                                  # per currency, folded from the Paystack ledger
paybox balance credit 500000                    # emulator-only test funds, NGN
paybox balance credit 500000 --currency GHS --reason "stage payout test"
```

Transfers are refused when the balance cannot cover amount plus fee, which is
why `credit` exists. Other providers fund their balances through their own
endpoints ([Providers](providers.md)).

## Disputes

```bash
paybox dispute list
paybox dispute open pay_…                          # emulator-only; chargeback, full amount
paybox dispute open pay_… --category fraud --amount 50000
paybox dispute resolve dsp_… --amount 50000        # merchant-accepted: raises and settles a real refund
paybox dispute resolve dsp_… --decline --message "evidence supplied"
paybox time advance 7d                             # the deadline reminder fires
```

## Scripting

`--json` on any command prints the exact response body, so the CLI composes
with `jq`:

```bash
ID=$(paybox --json payment list | jq -r '.[0].id')
paybox --json webhook list | jq '.[] | select(.status == "exhausted") | .id'
paybox --json status | jq .health.clock
```

For anything the CLI does not expose — endpoint filters, `time set`, custom
scenarios, the SSE stream — call the [Control API](control-api.md) directly.

# Getting started

Ten minutes from nothing to a signed `charge.success` arriving at your
application. Nothing here requires a provider account.

## Requirements

Node 22.5 or newer. Nothing else — no database server, no Redis, no compiler.
Or Docker, and no Node at all.

## Install and run

```bash
npx paybox-emulator start
```

That fetches the package on first use and starts the emulator in the
foreground. To keep the `paybox` command on your PATH:

```bash
npm install -g paybox-emulator
paybox start
```

As a container ([Docker](docker.md) has compose, CI and networking):

```bash
docker run --rm -p 127.0.0.1:8080:8080 dsasante1/paybox
```

From a clone of the repository, `npm install && npm start` runs the server
straight from the TypeScript source and `npm run cli -- <command>` is the CLI.

## What the banner tells you

```
  paybox — local payment emulator
  ───────────────────────────────────────────────
  API         http://127.0.0.1:8080
  Dashboard   http://127.0.0.1:8080/dashboard
  API docs    http://127.0.0.1:8080/docs
  Database    ./data/paybox.db

  Providers
    Paystack   http://127.0.0.1:8080/paystack   partial — see docs/paystack.md
    Stripe     http://127.0.0.1:8080/stripe     partial — see docs/stripe.md
    …

  Test credentials (local only — these are not real keys)
    Paystack   sk_test_local_…
    Stripe     sk_test_local…
    Flutterwave FLWSECK_TEST-…
    …

  No real money can move through this process.
```

- **partial** is honest, not modest: every adapter implements a documented
  subset, and `docs/<provider>.md` is the contract. `paybox coverage` prints
  the figures.
- The credentials are generated from the seed on every start. `paybox status`
  prints them again whenever you need them.
- The database is a file under `./data/` by default, so state survives a
  restart. `paybox start --database :memory:` for a clean slate every time.

## Point your application at it

Change the base URL and use the local key. Every other line of your
integration stays as it is.

```env
PAYSTACK_BASE_URL=http://127.0.0.1:8080/paystack
PAYSTACK_SECRET_KEY=sk_test_local_…
```

The same for the others — [Providers](providers.md) has each one's base URL,
credential, header and SDK settings:

```env
STRIPE_API_BASE=http://127.0.0.1:8080/stripe
FLW_BASE_URL=http://127.0.0.1:8080/flutterwave        # v3; v4 is /flutterwave/v4
KORA_BASE_URL=http://127.0.0.1:8080/kora
WEWIRE_BASE_URL=http://127.0.0.1:8080/wewire
WISE_API_BASE=http://127.0.0.1:8080/wise
```

If your code builds URLs from a constant, that constant is the one line to
change. If you use an SDK with a hardcoded host, see
[Providers → Pointing an SDK](providers.md#pointing-an-sdk-at-the-emulator).

## A first payment

Initialize a transaction exactly as you would against Paystack:

```bash
curl -X POST http://127.0.0.1:8080/paystack/transaction/initialize \
  -H "Authorization: Bearer sk_test_local_…" \
  -H "content-type: application/json" \
  -d '{"email":"dev@example.com","amount":10000,"currency":"GHS","reference":"order_1"}'
```

```json
{ "status": true, "message": "Authorization URL created",
  "data": { "authorization_url": "http://127.0.0.1:8080/paystack/checkout/48zrdrkbqv7e",
            "access_code": "48zrdrkbqv7e", "reference": "order_1" } }
```

Open the `authorization_url`. It is a real checkout page with the test
instruments listed on it: pay with mobile money `0550000000`, card
`4000 0000 0000 0000`, or pick a number whose last digits produce the outcome
you want ([Test instruments](test-instruments.md)). Or skip the page:

```bash
paybox payment success order_1
```

Either way, verify now answers as Paystack would:

```bash
curl http://127.0.0.1:8080/paystack/transaction/verify/order_1 \
  -H "Authorization: Bearer sk_test_local_…"
#  "data": { "status": "success", "amount": 10000, "channel": "mobile_money", … , "log": { "history": [ … ] } }
```

`log.history` is real — it is the payment's event timeline.

## The first webhook

Register where your application listens, then settle a payment:

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
#  ✓ http://localhost:3000/webhooks/paystack
#    signing secret  sk_test_local_…

paybox payment success order_1
paybox webhook list
```

Your application receives a `charge.success` signed with HMAC-SHA512 over the
exact bytes in `x-paystack-signature`. If your verifier fails here, it would
fail in production for the same reason — usually hashing a re-serialised body.
[Webhooks](webhooks.md) has a verifier that works, and
[`examples/express-paystack`](../examples/express-paystack) is a complete
application.

## Watch it

- **Dashboard** <http://127.0.0.1:8080/dashboard> — payments, timelines,
  every delivery with its response, and buttons for retry, replay, time and
  chaos. [Dashboard](dashboard.md).
- **CLI** — `paybox payment get order_1`, `paybox events`, `paybox jobs`.
- **API docs** <http://127.0.0.1:8080/docs> — an interactive reference
  listing every route each adapter serves, grouped by provider with its
  coverage status. The contracts in `docs/<provider>.md` remain the
  authoritative statement of behaviour.

## Four things a sandbox cannot do

```bash
# 1. A mobile-money charge answers immediately; the customer has not approved yet.
paybox payment create --amount 25000 --method mobile_money --reference momo_1
#   → requires_action

# 2. Fast-forward instead of waiting. Every job that comes due runs before this returns.
paybox time advance 5s
#   → successful, charge.success delivered

# 3. Make every webhook fail and watch the retry ladder run to exhaustion.
paybox webhook fail http_500
paybox time advance 30s
paybox webhook list --status exhausted
paybox webhook fail off

# 4. Deliver the same signed payload again. Does your handler double-credit?
paybox webhook replay whd_…
```

Then `paybox webhook chaos --duplicate true --out-of-order true`,
`paybox network latency 3000` (the webhook lands before the API call returns),
and `paybox scenario run late-reversal pay_…` (a failure that becomes a
success). [Testing with paybox](testing.md#recipes) walks through each.

## Configuration

`paybox.yml` in the working directory, or `PAYBOX_*` environment variables;
environment wins. The complete reference — every key, every variable, the
defaults — is [Configuration](configuration.md). The ones you will want first:

| | |
|---|---|
| `PAYBOX_PORT`, `PAYBOX_HOST` | where it listens |
| `PAYBOX_DATABASE` | a file path, or `:memory:` |
| `PAYBOX_FREEZE_CLOCK`, `PAYBOX_START_AT`, `PAYBOX_SEED` | deterministic runs |
| `PAYBOX_AUTO_ADVANCE` | `0` to drive every transition by hand |
| `PAYBOX_OPENING_BALANCE` | the test float payouts draw on |

## Using it in CI

```bash
PAYBOX_DATABASE=:memory: \
PAYBOX_FREEZE_CLOCK=1 \
PAYBOX_START_AT=2026-01-01T00:00:00Z \
PAYBOX_SEED=$CI_JOB_ID \
npx paybox-emulator start &
```

A frozen clock plus a fixed seed makes every id, timestamp and jitter value
reproducible, so tests can assert exact values instead of matching patterns.
Drive time forward explicitly with `paybox time advance`. A complete test and
the GitHub Actions blocks are in [Testing with paybox](testing.md); the
container-as-a-service variant is in [Docker](docker.md#ci).

## Where next

- [Concepts](concepts.md) — the model everything else assumes.
- [Providers](providers.md) — your provider's base URL, credential, webhook
  scheme and SDK settings.
- [Test instruments](test-instruments.md) — which number does what.
- [Troubleshooting](troubleshooting.md) — when something is stuck.
- [The documentation index](README.md) — everything.

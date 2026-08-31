# paybox

A local payment infrastructure emulator. Point an existing Paystack, Stripe,
Flutterwave or Kora integration at `localhost` and test the parts of payments
that are hard to test: pending transactions, asynchronous mobile-money
authorization, duplicate webhooks, retries, timeouts, refunds, idempotency and
flaky networks.

Every adapter is **partially** implemented, and each one's coverage is
documented honestly — see the table below.

> **If your production payment integration can hit it, you should be able to
> reproduce it locally.**

paybox is not a mock server. Every request drives a real state machine, appends
to an append-only event log, and produces the same events and webhooks the
equivalent organic flow would.

**No real money can move through this process.** It has no code path that
reaches a payment network, and it refuses live API keys.

---

## Status

<!-- coverage:start -->
| Provider | Base path | Endpoints | Coverage |
|---|---|---|---|
| Paystack | `/paystack` | 64 | **Partial** — [what works](docs/paystack.md) |
| Stripe | `/stripe` | 92 | **Partial** — [what works](docs/stripe.md) |
| Flutterwave v3 | `/flutterwave` | 26 | **Partial** — [what works](docs/flutterwave.md) |
| Flutterwave v4 | `/flutterwave/v4` | 11 | **Partial** — [what works](docs/flutterwave.md) |
| Kora | `/kora` | 29 | **Partial** — [what works](docs/kora.md) |
| WeWire | `/wewire` | 25 | **Partial** — [what works](docs/wewire.md) |
| Wise | `/wise` | 30 | **Partial** — [what works](docs/wise.md) |
<!-- coverage:end -->

Endpoint counts are generated from each adapter's coverage manifest and checked
against the router by `tests/coverage-drift.test.ts` — the table cannot claim an
endpoint the emulator does not serve. `paybox coverage` prints the same figures,
and `paybox coverage <provider>` breaks them down.

**Partial means partial.** Each `docs/<provider>.md` is a contract, not
marketing: it lists what is implemented, what differs and what is absent. If
something is missing from that file, assume it is not there.

Flutterwave ships two live APIs with different authentication, envelopes and
webhook signatures, so paybox implements them as two adapters rather than one
with a flag.

The engine is provider-independent, and seven adapters across six providers now
sit on it. Anything a
provider needs from the engine reaches it as an injected function — a status
mapping, an instrument table, an authorization minter — never an import, so no
adapter can see another and the engine sees none of them.

---

## Zero to a simulated payment

```bash
npx paybox-emulator start
```

No clone, no database server, no compiler — Node 22.5 or newer is the only
requirement. `npm install -g paybox-emulator` puts the `paybox` command on your
PATH for everything below; each command also works as `npx paybox-emulator …`.
Without Node, the same thing as a container:

```bash
docker run --rm -p 127.0.0.1:8080:8080 dsasante1/paybox
```

```
  paybox — local payment emulator
  ───────────────────────────────────────────────
  API         http://127.0.0.1:8080
  Dashboard   http://127.0.0.1:8080/dashboard
  API docs    http://127.0.0.1:8080/docs

  Test credentials (local only — these are not real keys)
    secret    sk_test_local_a1b2c3...
```

Point your app at it:

```env
PAYSTACK_BASE_URL=http://127.0.0.1:8080/paystack
PAYSTACK_SECRET_KEY=sk_test_local_a1b2c3...
```

Or any of the others — `paybox status` prints the credentials each one issued:

```env
STRIPE_API_BASE=http://127.0.0.1:8080/stripe
FLW_BASE_URL=http://127.0.0.1:8080/flutterwave      # v3, FLWSECK_TEST-… keys
KORA_BASE_URL=http://127.0.0.1:8080/kora
```

Then initialize a payment exactly as you would against Paystack:

```bash
curl -X POST http://127.0.0.1:8080/paystack/transaction/initialize \
  -H "Authorization: Bearer sk_test_local_a1b2c3..." \
  -H "content-type: application/json" \
  -d '{"email":"dev@example.com","amount":10000,"currency":"GHS","reference":"order_1"}'
```

```json
{
  "status": true,
  "message": "Authorization URL created",
  "data": {
    "authorization_url": "http://127.0.0.1:8080/paystack/checkout/48zrdrkbqv7e",
    "access_code": "48zrdrkbqv7e",
    "reference": "order_1"
  }
}
```

Open that URL — it is a real checkout page with the test instruments listed on
it. Or drive it from the CLI:

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
paybox payment success order_1
```

Your app receives a signed `charge.success` webhook, and `verify` now returns
`"status": "success"`.

---

## The interesting part

```bash
# A mobile-money charge answers immediately; the customer has not approved yet.
paybox payment create --amount 25000 --method mobile_money --reference momo_1
#   → requires_action, "Please approve the payment prompt on your phone"

# Fast-forward instead of waiting. Every job that comes due runs before this returns.
paybox time advance 5s
#   → successful, charge.success delivered

# Make every webhook fail, then watch the retry ladder run to exhaustion.
paybox webhook fail http_500
paybox time advance 2h
paybox webhook list

# Replay a delivery with a byte-identical signed payload — does your handler
# double-credit the customer?
paybox webhook replay whd_...

# Duplicate and reorder every webhook.
paybox webhook chaos --duplicate true --out-of-order true

# Hold the API response open so the webhook lands before the call returns.
paybox network latency 3000
```

---

## Documentation

The [documentation index](docs/README.md) maps every page to a question.
The ones most people need first:

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, point an app at it, first payment, first webhook |
| [Concepts](docs/concepts.md) | Canonical statuses, the event log, virtual time, determinism |
| [Providers](docs/providers.md) | Base URL, credential, webhook verification and SDK settings for each of the six |
| [Contracts](docs/paystack.md) | What each adapter does and does not implement: [Paystack](docs/paystack.md), [Stripe](docs/stripe.md), [Flutterwave](docs/flutterwave.md), [Kora](docs/kora.md), [WeWire](docs/wewire.md), [Wise](docs/wise.md) |
| [Test instruments](docs/test-instruments.md) | Which card or phone number produces which outcome |
| [Payment lifecycle](docs/payment-lifecycle.md) | Statuses, transitions, refunds, transfers, subscriptions, disputes |
| [Time control](docs/time.md) | What `time advance` runs, and what it does not |
| [Webhooks](docs/webhooks.md) | Signing, retries, replay, failure simulation |
| [Scenarios](docs/scenarios.md) | Reusable multi-step flows |
| [CLI](docs/cli.md) | Every command |
| [Control API](docs/control-api.md) | Every `/api` route the CLI and dashboard use |
| [Configuration](docs/configuration.md) | Every key and environment variable |
| [Testing with paybox](docs/testing.md) | A complete automated test, CI blocks, and a recipe per failure mode |
| [Dashboard](docs/dashboard.md) | The five views and the live event stream |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms and what to do |
| [Docker](docs/docker.md) | The published image, compose, CI services |
| [Architecture](docs/architecture.md) | How it works and why it is built this way |
| [Releasing](docs/releasing.md) | How a tag becomes an npm package and a container image |
| [Security](SECURITY.md) | The safety guarantees and their limits |

---

## Development

```bash
npm install
npm start                        # the server, straight from the TypeScript source
npm run cli -- time advance 5s   # the CLI, likewise — nothing is built

npm test               # unit, integration, provider compatibility
npm run typecheck      # strict, project references
npm run lint           # includes the determinism rules
npm run build          # bundles the publishable package into apps/paybox/dist
npm run smoke:package  # installs that package into an empty directory and runs it
```

The lint rules are load-bearing, not cosmetic: `Date.now()`, `new Date()`,
`Math.random()` and raw timers are **banned** outside `packages/core/src/time/`.
Everything reads from an injected `Clock` and a seeded `Random`. That is what
makes `time advance` work and what makes `PAYBOX_SEED=x` reproduce a run
byte for byte.

A release is a tag. Pushing `v0.2.0` runs the full verification again and then
publishes that one version to npm, to Docker Hub and as a GitHub Release from a
single workflow — [docs/releasing.md](docs/releasing.md) has the one-time setup.

## Design notes

Source comments cite design decisions as `spec §N`. Those refer to a build
brief that is not published with the code; [docs/spec-references.md](docs/spec-references.md)
indexes every section the code cites, and `docs/architecture.md` explains the
three decisions everything else follows from.

## Licence

MIT. Not affiliated with, endorsed by, or connected to Paystack, Stripe,
Flutterwave or Kora. Provider names are used only to describe API compatibility.

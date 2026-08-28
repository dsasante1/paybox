# paybox

A local payment infrastructure emulator. Point an existing Paystack, Stripe,
Flutterwave or Kora integration at `localhost` and test the parts of payments
that are hard to test: pending transactions, asynchronous mobile-money
authorization, duplicate webhooks, retries, timeouts, refunds, idempotency and
flaky networks.

> **If your production payment integration can hit it, you should be able to
> reproduce it locally.**

paybox is not a mock server. Every request drives a real state machine, appends
to an append-only event log, and produces the same events and webhooks the
equivalent organic flow would.

**No real money can move through this process.** It has no code path that
reaches a payment network, and it refuses live API keys.

---

## Status

| Provider | Coverage |
|---|---|
| Paystack | **Partial** — [what works](docs/paystack.md) |
| Stripe | **Partial** — [what works](docs/stripe.md) |
| Flutterwave | Not implemented |
| Kora | Not implemented |

The engine is provider-independent, and two adapters now sit on it. Anything a
provider needs from the engine reaches it as an injected function — a status
mapping, an instrument table, an authorization minter — never an import, so
neither adapter can see the other and the engine sees neither.

---

## Zero to a simulated payment

```bash
npm install
npm start
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
npm run cli -- webhook add http://localhost:3000/webhooks/paystack
npm run cli -- payment success order_1
```

Your app receives a signed `charge.success` webhook, and `verify` now returns
`"status": "success"`.

---

## The interesting part

```bash
# A mobile-money charge answers immediately; the customer has not approved yet.
npm run cli -- payment create --amount 25000 --method mobile_money --reference momo_1
#   → requires_action, "Please approve the payment prompt on your phone"

# Fast-forward instead of waiting. Every job that comes due runs before this returns.
npm run cli -- time advance 5s
#   → successful, charge.success delivered

# Make every webhook fail, then watch the retry ladder run to exhaustion.
npm run cli -- webhook fail http_500
npm run cli -- time advance 2h
npm run cli -- webhook list

# Replay a delivery with a byte-identical signed payload — does your handler
# double-credit the customer?
npm run cli -- webhook replay whd_...

# Duplicate and reorder every webhook.
npm run cli -- webhook chaos --duplicate true --out-of-order true

# Hold the API response open so the webhook lands before the call returns.
npm run cli -- network latency 3000
```

---

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, configure, first payment |
| [Architecture](docs/architecture.md) | How it works and why it is built this way |
| [Paystack compatibility](docs/paystack.md) | Exactly what is and is not implemented |
| [Webhooks](docs/webhooks.md) | Signing, retries, replay, failure simulation |
| [Scenarios](docs/scenarios.md) | Reusable multi-step flows |
| [CLI](docs/cli.md) | Every command |
| [Docker](docs/docker.md) | Container and compose |
| [Security](SECURITY.md) | The safety guarantees and their limits |

---

## Development

```bash
npm test           # 54 tests: unit, integration, provider compatibility
npm run typecheck  # strict, project references
npm run lint       # includes the determinism rules
```

The lint rules are load-bearing, not cosmetic: `Date.now()`, `new Date()`,
`Math.random()` and raw timers are **banned** outside `packages/core/src/time/`.
Everything reads from an injected `Clock` and a seeded `Random`. That is what
makes `time advance` work and what makes `PAYBOX_SEED=x` reproduce a run
byte for byte.

## Licence

MIT. Not affiliated with, endorsed by, or connected to Paystack, Stripe,
Flutterwave or Kora. Provider names are used only to describe API compatibility.

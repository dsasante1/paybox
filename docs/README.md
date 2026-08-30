# paybox documentation

Everything here is written for someone *using* the emulator. If you want to
change it instead, start with [CONTRIBUTING.md](../CONTRIBUTING.md) and
[architecture.md](architecture.md).

## Find the right page

| I want to… | Read |
|---|---|
| Install it and make a first payment | [Getting started](getting-started.md) |
| Understand the model — canonical statuses, virtual time, the event log | [Concepts](concepts.md) |
| Point a Paystack, Stripe, Flutterwave, Kora, WeWire or Wise integration at it | [Providers](providers.md) |
| Know exactly what each adapter does and does not implement | [paystack](paystack.md) · [stripe](stripe.md) · [flutterwave](flutterwave.md) · [kora](kora.md) · [wewire](wewire.md) · [wise](wise.md) |
| Pick a card number or phone number that produces a given outcome | [Test instruments](test-instruments.md) |
| Drive payments, refunds, transfers, subscriptions and disputes | [Payment lifecycle](payment-lifecycle.md) |
| Fast-forward retries, expiries and renewals | [Time control](time.md) |
| Receive, verify, retry and replay webhooks | [Webhooks](webhooks.md) |
| Script a multi-step flow and run it against a payment | [Scenarios](scenarios.md) |
| Use every CLI command | [CLI](cli.md) |
| Call the control API directly — what the CLI and dashboard call | [Control API](control-api.md) |
| Configure it — file, environment variables, precedence | [Configuration](configuration.md) |
| Use the dashboard and the live event stream | [Dashboard](dashboard.md) |
| Run it inside an automated test suite or in CI | [Testing with paybox](testing.md) |
| Run it as a container | [Docker](docker.md) |
| Fix something that is not behaving | [Troubleshooting](troubleshooting.md) |
| Understand why it is built the way it is | [Architecture](architecture.md) |
| Cut a release, or understand what CI enforces | [Releasing](releasing.md) · [CI](ci.md) |
| Know what is and is not safe | [SECURITY.md](../SECURITY.md) |
| Decode a `spec §N` citation in the source | [Spec references](spec-references.md) |

## A first afternoon, in order

1. [Getting started](getting-started.md) — ten minutes to a signed `charge.success`.
2. [Concepts](concepts.md) — the six ideas everything else assumes.
3. [Providers](providers.md), then the contract for the provider you use.
4. [Test instruments](test-instruments.md) — which number produces which outcome.
5. [Webhooks](webhooks.md) and [Time control](time.md) — the two things a
   sandbox cannot give you.
6. [Testing with paybox](testing.md) — turning all of that into a suite that
   asserts exact values.

## Conventions used throughout

- **Amounts are integer minor units** everywhere the emulator stores or
  reports them: `10000` is GHS 100.00, NGN 100.00 or USD 100.00. The
  Flutterwave and Kora adapters convert to and from the major units those
  APIs use at the boundary, and nowhere else.
- **Canonical vs provider.** The emulator stores one canonical vocabulary
  (`successful`, `requires_action`, `non_renewing`) and each adapter answers
  in its provider's own (`success`, `ongoing`, `non-renewing`). CLI, dashboard
  and `/api` speak canonical; `/paystack`, `/stripe` and the rest speak
  provider. [Concepts](concepts.md#two-statuses) has the details.
- **Id prefixes.** paybox's own ids are prefixed tokens: `pay_` payments,
  `whe_` webhook endpoints, `whd_` webhook deliveries, `evt_` events, `job_`
  scheduled jobs, `run_` scenario runs. Provider-shaped ids (`pi_…`,
  `chg_…`, a Paystack numeric id) are minted alongside and are what the
  provider endpoints return.
- **Emulator-only** marks a route, field or flag that exists here and not at
  the provider. Each one is listed in [Concepts](concepts.md#emulator-only-controls)
  and must never be relied on in production code.
- `paybox …` in examples means the installed command. `npx paybox-emulator …`
  and, from a clone, `npm run cli -- …` are equivalent.

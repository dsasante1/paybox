# Architecture

```
   your application
          │
          ▼
  ┌───────────────────────────────────────────────┐
  │  provider adapter   (packages/providers/*)    │  Paystack's wire format
  │  routes · schemas · mappers · signatures      │  lives only here
  └───────────────────────┬───────────────────────┘
                          ▼
  ┌───────────────────────────────────────────────┐
  │  payment engine     (packages/core)           │  knows nothing about
  │  state machine · event log · refund maths     │  any provider
  └───────────────────────┬───────────────────────┘
                          ▼
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  ┌───────────┐                     ┌───────────────┐
  │ event bus │────────────────────▶│ webhook engine│
  └─────┬─────┘                     └───────┬───────┘
        ▼                                   ▼
  ┌───────────────────────────────────────────────┐
  │  storage  (SQLite via node:sqlite + Kysely)   │
  │  payments · events · jobs · deliveries        │
  └───────────────────────────────────────────────┘
```

Everything runs in **one process**. There is no Redis, no queue broker, and no
second service.

---

## The three decisions everything else follows from

### 1. Virtual time, enforced by lint

Nothing outside `packages/core/src/time/` may call `Date.now()`, `new Date()`,
`Math.random()`, `setTimeout` or `crypto.randomUUID()`. This is an ESLint error,
not a convention — see `eslint.config.js`.

Every timestamp, every webhook backoff deadline, every payment expiry and every
scenario step reads from an injected `Clock`. That is what makes this work:

```bash
paybox time advance 2h    # runs 2 hours of scheduled jobs, instantly
```

The scheduler executes each due job **at the instant it was scheduled for**, not
at whatever time the clock has since reached (`VirtualClock#at`). Without that,
advancing two hours would fire a retry due at T+4s but stamp it T+2h and compute
its next attempt from there — so a five-attempt ladder would need five separate
advances. With it, the whole ladder collapses into one call and the event log
timestamps are correct.

This cannot be retrofitted. It was the first thing built.

### 2. A durable job table, not a queue broker

Webhook retries, payment expiries and scenario steps are rows in a `jobs` table
with a `run_at` compared against **virtual** time.

BullMQ was the obvious choice and is the wrong one here: its delays live in
Redis on the wall clock, so `time advance` could never fire a retry scheduled
five minutes out. A table also survives a restart, is inspectable in the
dashboard, and needs no infrastructure.

Leasing uses `BEGIN IMMEDIATE` so the select-then-update is atomic, and expired
leases are reclaimed on each tick.

### 3. An append-only event log as the source of truth

`events` is append-only and is the history. The `payments` row is a projection,
updated **in the same transaction** as the event append.

This is not full event sourcing — the mutable row stays, for fast queries. But
it means the §23 timeline, the state history, Paystack's `log.history`, and
webhook replay all come from one mechanism instead of three.

Events reach the bus only *after* the transaction commits. Publishing
mid-transaction would let a webhook describe a state that then rolls back —
exactly the class of bug this tool exists to help people find.

---

## Package layout

| Package | Responsibility | Depends on |
|---|---|---|
| `@paybox/shared` | Canonical model, statuses, currency, seeded `Random`, id factory, error taxonomy, `Clock` port | — |
| `@paybox/core` | Payment engine, state machine, event bus, storage ports, `VirtualClock`, `Scheduler` | shared |
| `@paybox/storage` | SQLite via `node:sqlite`, hand-written migrations, repositories | core |
| `@paybox/webhooks` | Dispatcher, retry policy, transports, chaos | core |
| `@paybox/simulator` | Test instruments, outcome→transition plans, scenario runner | core |
| `@paybox/paystack` | Routes, schemas, mappers, signature, checkout page, error mapper | core, webhooks, simulator |
| `@paybox/api` | Fastify assembly, control plane, dashboard, config | all |
| `@paybox/cli` | Thin REST client over the control plane | api |

**Dependencies point one way.** `core` cannot import a provider. A provider
cannot import another provider.

---

## How provider isolation is enforced

Each adapter registers as an encapsulated Fastify plugin with its own prefix,
error serialiser, idempotency store and network hooks. Fastify's encapsulation
means those hooks apply to that provider's routes and nothing else — isolation
enforced by the framework rather than by convention.

(That encapsulation has a sharp edge: a plugin registered as a *sibling* does
not share hooks with its siblings. `idempotencyPlugin` and `networkPlugin` are
wrapped in `fastify-plugin` precisely to escape it. Getting this wrong makes the
hooks silently do nothing.)

Provider-specific status vocabulary reaches the engine as an **injected
function** (`ProviderStatusResolver`), not an import. The engine calls it; each
adapter owns its own mapping. That is how the stored `providerStatus` says
`success` for Paystack while the canonical status says `successful`, without
`core` ever learning Paystack exists.

---

## Why no DI container

The injectable surface is five process-wide singletons: `Clock`, `Random`,
`Storage`, `EventBus`, and the delivery transport. They are swapped exactly
once, in test setup. `apps/api/src/context.ts` is the entire wiring story and
you can read it top to bottom.

A container solves combinatorial wiring complexity; five singletons is not
combinatorial. And for the determinism guarantee you actively **do not** want
per-module clock overrides — there must be exactly one clock in the process, or
`time advance` produces nondeterministic results.

## Why Kysely, not an ORM

The two load-bearing queries are an atomic upsert-and-return for event
sequences, and a `BEGIN IMMEDIATE` job lease. Both are raw-SQL-shaped. The
schema is eleven flat tables with almost no relational traversal. And dual
dialect (SQLite now, Postgres later) is a first-class requirement, which Kysely
handles with one codebase.

## Why `node:sqlite`, not better-sqlite3

`npm install -g paybox` has to work on a machine with nothing but Node. A native
addon means node-gyp fallbacks wherever a prebuild is missing, which is the most
common "your tool won't install" report for CLI tools. `node:sqlite` has shipped
since Node 22.5 and needs no compiler. The Kysely dialect for it is ~140 lines
in `packages/storage/src/node-sqlite-dialect.ts`.

**The caveat:** `node:sqlite` is stable from Node 24 and *experimental* on Node
22, where it prints an `ExperimentalWarning` on every start. The API used here
(`DatabaseSync`, `prepare`, `all`, `run`, `exec`) has been stable in practice,
and the dialect is the only place that touches it — so if the API ever moves,
one file changes. The Docker image suppresses that single warning category for
log readability; local runs still show it, which is correct.

---

## Adding a provider

1. Create `packages/providers/<name>/` with `routes`, `schemas`, `mappers`,
   `serializers`, `signature`, `webhook`, `errors`, `status`, `fixtures`.
2. Implement `WebhookFormatter` — the body shape and the signing scheme.
3. Map canonical statuses to the provider's vocabulary and register the mapper
   in `context.ts`.
4. Register the plugin in `app.ts` under its own prefix.
5. Write a `docs/<name>.md` compatibility matrix. **Verify against the live
   documentation — do not write it from memory.**
6. Add fixtures and a compatibility test.

Nothing in `packages/core` should need to change.

## Provider escape hatches on the state machine

The payment state machine is deliberately strict, but two providers can
legitimately do things it forbids. Both are opt-in flags on
`transitionPayment`, refused unless an adapter explicitly asks — so a provider
that has no such behaviour is unaffected by construction.

| Flag | Allows | Why it exists |
|---|---|---|
| `reversal: true` | any terminal state → anything | A provider can overturn a settled decision: a late settlement, a chargeback reversal. |
| `retry: true` | `failed` → `pending` / `processing` / `requires_action` | Some providers have no terminal failure. |

`retry` exists because **Stripe's PaymentIntent never fails terminally**. A
decline returns it to `requires_payment_method` "so that the payment can be
retried" — the same intent is confirmed again with another payment method.
Paystack has no equivalent: a failed charge there is over.

The narrowness is the point. `retry` only resumes the flow; claiming a failed
payment actually succeeded is a *reversal*, a different claim with a different
flag. And it applies only to `failed` — `cancelled`, `expired` and `refunded`
stay terminal, because no provider we model reopens those.

Canonical `failed` therefore means "the last attempt failed", not "this payment
is dead". The attempt history lives in the event log, which already records
every transition — so a payment that failed twice and then succeeded is fully
auditable without a separate attempts table.

## Webhook signatures that cover a timestamp

`WebhookFormatter.sign(rawBody, secret, context)` receives a `SigningContext`
carrying the **virtual-time** instant of the attempt and its attempt number.
It is passed in rather than read inside the formatter so signing stays a pure
function that cannot reach for `Date.now()`.

A formatter that sets `resignsPerAttempt: true` is re-signed on every delivery
attempt instead of replaying its stored headers. Stripe needs this: it signs
`${timestamp}.${payload}`, and its documentation is explicit that a retry gets
a new timestamp and signature. Replaying a stale one would fail any correct
verifier's tolerance window — a failure the emulator would have invented, and
then taught developers to work around.

The default is off. A body-only signature is identical on every attempt, so
Paystack retries stay byte-identical, which is what makes the delivery log
trustworthy. Only the signature headers are recomputed; the payload never
changes.

## One canonical event, several provider events

`WebhookFormatter.format()` may return an array. Each entry becomes its own
delivery: its own event type, its own endpoint match, its own signature, its
own row in the delivery log.

Paystack never needs this — one canonical event is one Paystack webhook. Stripe
does, because it reports one occurrence on several objects: a settled payment
is both `payment_intent.succeeded` (carrying the intent) and `charge.succeeded`
(carrying the charge), and a merchant may subscribe to either.

Matching endpoints **per formatted webhook** rather than once per canonical
event is what makes that work. An endpoint subscribed to only
`charge.succeeded` gets exactly one delivery, not two, and not one of the wrong
type.

Providers that return a single webhook are unaffected: the dispatcher
normalises one or many into the same loop.

## Recurring billing is provider-neutral

`SubscriptionRunner` was written for Paystack and later carried Stripe with two
changes, both of which were Paystack constants that should never have been
constants:

- **The invoice lead time.** Paystack raises `invoice.create` three days before
  the debit; Stripe finalises about an hour after creating one. Hardcoding
  either lands the other provider's webhook at the wrong time, which is exactly
  the timing a dunning integration is built around. It is now injected
  per-provider.
- **`interval_count`.** Stripe writes "every three months" as
  `interval: month, interval_count: 3`. Paystack has no equivalent and always
  means 1, so the canonical `Plan` gained a count that defaults to 1 and
  `addInterval` multiplies by it.

Everything else -- the self-enqueuing cycle, the invoice-limit check, the
`attention` state on a failed renewal, the anchoring on `VirtualClock#at` --
carried across untouched. Both providers now produce twelve monthly invoices
one calendar month apart from a single `time advance 360d`.

## FX without the engine ever converting

WeWire and Wise are payout providers built around a rate: you quote a pair,
then move money across it. `CLAUDE.md` states a non-negotiable that appears to
be in the way — *"No FX conversion ever happens; `formatAmount` is
display-only."* It is worth being precise about what that rule protects,
because the answer determines whether an FX provider can be modelled at all.

It protects two things: the engine must never **invent** a rate, and money must
never lose precision by round-tripping through a float. Neither requires the
engine to refuse cross-currency movement outright.

So the WeWire adapter follows the same shape as every other provider-specific
fact:

- **The rate lives in the adapter.** `providers/wewire/src/rates.ts` is a fixed
  table with a fixed spread, exactly as Paystack's status vocabulary and
  Stripe's fee schedule live in theirs. Core never sees it, never asks for one,
  and has no code path that could produce one.
- **A conversion is two integer amounts and a recorded rate.** The payout is
  stored in minor units of the source currency; the destination amount and the
  rate that produced it go on the transfer's metadata. The float exists for one
  multiplication inside `convertMinor` and is rounded away before anything is
  written.
- **`getBalance` still folds per currency.** There is no cross-currency
  arithmetic anywhere in `packages/core`, and a wallet is still one balance per
  currency per holder.

The engine still never converts. The adapter quotes, and the ledger records
what was quoted — which is the same injection pattern as `ProviderStatusResolver`,
applied to a number instead of a string.

The rates are **fixed rather than live** for the usual reason: a rate that moved
between two runs would make the same inputs produce different output. WeWire
refreshes on a 30-minute cycle and paybox cannot follow it without giving up the
one property the whole project rests on. `docs/wewire.md` says so plainly, so
nobody mistakes the table for market data.

## One canonical event, several provider *names*

Stripe forced webhook fan-out: one settlement is both
`payment_intent.succeeded` and `charge.succeeded`. WeWire forced the
neighbouring case — one canonical event that is a *different single event*
depending on which product produced the resource.

`transfer.successful` on the Ghana corridor is `disbursement.completed`,
carrying WeWire's flat Africa object. The same canonical event offshore is
`transaction.status_updated`, carrying a wallet-transaction object with
different field names (`transactionId`, not `id`), a different channel string
(`PAYOUT`, not `AUTOMATED_PAYOUT`) and extra `walletId` / `businessId` fields.

This needed no new seam. The formatter already receives the resource, and the
corridor is recorded on the transfer's metadata when it is created — so the
adapter reads a fact it wrote rather than inferring one from the currency. The
lesson is the same one the `InvoiceLeadTimes` injection taught: when two
providers disagree, the disagreement belongs on the resource, not in a
conditional in `core`.

## A `transfer.settle` job, and why transfers needed one

Until WeWire, transfers had no scheduled settlement path — they were moved by
the control API, the CLI, or an adapter transitioning them inline. WeWire
cannot work that way: it returns `PENDING` and settles asynchronously, and its
own sandbox documents the outcome arriving "within seconds".

`transfer.settle` is registered in `context.ts` beside `payment.simulate` and
`refund.settle`, and follows the same rule as both: **the outcome is decided
when the job is enqueued, never when it runs.** The adapter reads WeWire's
published sandbox number at request time and writes the answer into the job
payload. A `paybox time advance` therefore delivers a result that was already
determined, which is what keeps the whole thing reproducible under a fixed
seed.

## Two seams Wise needed, and why they are general

Flutterwave, Kora and WeWire each slotted into the existing design without
changing `packages/core` at all. Wise did not, and the two things it needed are
worth recording because both turned out to be general rather than
Wise-specific.

### `createTransfer({ reserve: false })`

paybox reserves a transfer's amount when the transfer is **created**, not when
it settles. That is deliberate and documented: a queued payout has already
committed the funds, and waiting would let two queued payouts spend the same
money.

Wise does not work that way. `POST /transfers` produces an intent — it commits
nothing — and a separate `POST /…/payments` call is what debits the balance.
Reserving at creation would make an unfunded Wise transfer hold money a real
one does not, which is exactly the sort of quiet infidelity this project is
supposed to catch rather than commit.

So `reserve` is an option on `createTransfer`, defaulting to true. It does
three things, all in core:

- skips the balance check at creation,
- skips the ledger debit at creation,
- records `paybox_reserved: false` on the transfer, so the release-on-failure
  path knows not to credit back money that was never given up.

The Wise adapter passes `false` and calls `debitBalance` at funding, flipping
the flag as it goes. Nothing about Wise reached the engine: the flag describes
*when money is committed*, which is a property several providers could
plausibly differ on.

### `provider_state` (migration 0019)

A Wise quote lives 30 minutes, is consumed exactly once, carries the rate a
transfer is built from, and has no counterpart in `shared/src/model.ts`. It
needed somewhere to live, and two obvious homes both failed for instructive
reasons:

- **The idempotency store.** `IdempotencyRepository.put` is an insert, not an
  upsert — correctly, because a genuine replay must never overwrite the
  response it returns. A quote is mutable (`PATCH` attaches a recipient;
  creating a transfer marks it consumed), so it needs an upsert. Making the
  idempotency store upsert to accommodate it would have broken idempotency for
  every other provider.
- **A canonical `Quote` model.** The engine would gain a concept it never uses.
  New canonical resources earn their place by being shared across providers and
  driven by engine logic; a Wise quote is neither.

So `provider_state` is a provider-scoped key/value table with an upsert, read
by nothing in `packages/core`. An adapter owning its own short-lived state is
the same principle as an adapter owning its own status vocabulary.

## RSA webhook signatures

Wise is the only provider here that signs asymmetrically. Every other adapter
shares one secret with the subscriber, so signing and verifying are the same
operation with the same input. Wise holds a private key, publishes the public
one, and the subscriber holds nothing secret at all.

That needed no new seam — `WebhookFormatter.sign` already receives the raw body
and returns headers, and what it does in between was never constrained. But it
did surface a distinction worth naming: `resignsPerAttempt` is about **what a
signature covers**, not how it is computed. Wise's RSA signature covers the
body alone, so it is identical on every retry and stored headers can be
replayed. WeWire's HMAC covers a timestamp, so it must be recomputed. The
asymmetric one is the *less* attempt-dependent of the two.

paybox's Wise keypair is embedded in the adapter with its private key in plain
sight. That is not an oversight:

- It is not Wise's key. paybox cannot sign as Wise and does not try.
- Because the private key is published, a paybox signature proves nothing —
  which is the same bargain as every `sk_test_local_` secret in the project.
- It is embedded rather than generated at boot because `generateKeyPairSync`
  cannot be seeded, and a fresh key per run would make signatures differ
  between two runs at the same seed.

The public key is served from `GET /wise/paybox/webhook-public-key`, and a
signature from the emulator verifies under plain `openssl dgst -verify`.

## The ledger needed a sequence too

Migration 0018 gave `jobs` an explicit `sequence` because ordering by `run_at`
alone was nondeterministic under a frozen clock. Migration 0020 does the same
for `balance_ledger`, for the same reason and with a sharper symptom.

`ledger.list` ordered by `created_at` then `id`. Under a frozen clock every
entry written in one request shares a `created_at`, so the tie fell to `id` — a
token from the seeded random stream, deterministic but unrelated to insertion
order.

For a **balance** that is invisible: a sum does not care about order. For a
**running** balance it is not. WeWire puts `balanceBefore` and `balanceAfter`
on every wallet transaction, and those are a fold — so a payout could report
the balance from before the top-up that funded it. `tests/ledger-ordering.test.ts`
pins it, and fails if the tiebreak is removed.

The general lesson, now twice learned: in an append-only table under a frozen
clock, a timestamp is not an ordering and an id is not a sequence.

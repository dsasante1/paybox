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

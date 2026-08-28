# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**paybox** is a local payment-infrastructure emulator: a developer points an existing Paystack/Stripe/Flutterwave/Kora integration at localhost and exercises realistic payment flows — pending mobile-money authorization, webhook retries, duplicate deliveries, timeouts, refunds, idempotency — deterministically, with no provider sandbox.

`idea.txt` is the full product spec. Source comments cite it as "spec §N" (e.g. `spec §18` = refunds). Read the relevant section before changing behaviour it describes.

`docs/architecture.md` explains the three decisions everything follows from (virtual time, the job table, the event log). `docs/paystack.md` is the coverage contract. `CONTRIBUTING.md` lists the non-negotiables.

## Current state

All packages are implemented and the vertical slice runs end to end: `shared`, `core`, `storage`, `webhooks`, `simulator`, `providers/paystack`, `apps/api`, `apps/cli`. `npm start` serves the API, dashboard and OpenAPI docs; `npm run cli -- …` drives it.

**Paystack and Stripe are the implemented adapters.** Flutterwave and Kora are not.

_(historical note, kept because the invariants below were written under it)_ **Paystack was the only provider adapter.** Flutterwave and Kora are unimplemented and reported as such by `paybox provider` and the startup banner. Stripe's coverage is documented in `docs/stripe.md`, which is a contract on the same terms as `docs/paystack.md`. Coverage is documented honestly in `docs/paystack.md` — that file is a contract, not marketing.

Paystack coverage is now broad: transactions, all five documented `/charge` channels, stored authorizations (`charge_authorization`, the PIN/OTP loop), plans/subscriptions/invoices, subaccounts and splits, a balance ledger, disputes, dedicated virtual accounts, and reporting endpoints. **The authoritative source is Paystack's official OpenAPI spec** — `PaystackOSS/openapi`, `dist/paystack.yaml`, pinned at blob `efa5c8d25611a60f01fd8ce59352fb38b7edfbfb` — because `paystack.com/docs` returns HTTP 403 to automated fetches. Cite the `operationId` and that SHA next to anything derived from it. Where the spec types a response generically (every `/charge` envelope; all of `/settlement`), `docs/paystack.md` says so rather than inventing a shape.

Three endpoints are **emulator-only** and must never be presented as Paystack surface: `POST /paystack/dispute` (a chargeback originates with the payer's bank), `POST /api/dedicated-accounts/:number/credit`, and `POST /api/balance/credit`. Each exists because the flow would otherwise be untestable locally.

The dashboard is a single self-contained HTML document served from `apps/api/src/dashboard.ts`, not a React/Vite app. That was a deliberate trade to keep `npm install -g` free of build artifacts; a React dashboard is the intended upgrade.

Not built yet: transport interception for SDKs with a hardcoded host, the Postgres dialect, `paybox stop` (start runs in the foreground), and settlements — the OpenAPI spec gives `/settlement` no response schema at all, so there is nothing to emulate faithfully.

The default branch is `main`. `feat/paystack-coverage` carries the six-phase Paystack build-out described above.

## Commands

```bash
npm test                          # vitest run
npm run test:watch
npx vitest run tests/engine.test.ts          # a single file
npx vitest run -t 'enforces total_refunded'  # a single test by name
npm run typecheck                 # tsc -b across all project references
```

Node **≥ 22.5** is required — storage uses the built-in `node:sqlite`.

`npm run lint` works and the determinism rules genuinely fire — `typescript-eslint`'s parser is wired in `eslint.config.js`. (It was previously broken: no parser meant every `.ts` file failed with `Parsing error` and the rules silently enforced nothing. If you touch the ESLint config, re-verify by adding a temporary `Date.now()` and confirming it errors.)

## Architecture

Dependency direction is strict and one-way:

```
shared ──> core ──> (storage, webhooks, simulator) ──> providers/* ──> apps/api ──> apps/cli

providers/ now holds two adapters. Anything a provider needs from core reaches
it as an injected function -- ProviderStatusResolver, AuthorizationMinter,
InstrumentResolver -- never an import. Adding Stripe was the test of that, and
it needed three new seams rather than a rewrite: see docs/architecture.md.
```

- **`packages/shared`** — types and pure helpers with no runtime deps: canonical statuses, the domain model, seeded `Random`, `IdFactory`, the `Clock` *port* (interface only), currency, and the `PayboxError` taxonomy.
- **`packages/core`** — `PaymentEngine`, the state machine, `EventBus`, `VirtualClock`, `Scheduler`, and `ports.ts` (the `Storage` interface and all repository interfaces).
- **`packages/storage`** — the only implementation of the `Storage` port: SQLite via a hand-written Kysely dialect over `node:sqlite`.

### Invariants that hold the design together

**The engine knows nothing about providers.** `provider` is just a discriminator on a row. Adapters translate provider wire format → engine calls → provider wire format. Provider-specific logic must never leak into `core` (spec §30).

**Two statuses are always stored.** `status` is canonical and drives the state machine; `providerStatus` is the verbatim provider string ("success" vs "succeeded" vs "successful") so an adapter can echo exactly what the real API would return.

**The event log is the source of truth; the payment row is a projection.** `events` is append-only — there is deliberately no UPDATE path. Every state change appends an event and updates the row *inside one transaction* (`PaymentEngine.#appendEvent`). This is what makes the timeline, webhook replay, and audit free rather than three separate mechanisms.

**Events reach the `EventBus` only after commit.** Publishing mid-transaction would let a webhook describe a state that then rolls back.

**All payment mutation goes through `PaymentEngine.transitionPayment`.** CLI, dashboard, adapters, scenario steps, and expiry jobs all funnel there, so the state machine cannot be sidestepped.

**The state machine is a table, not code** (`core/src/state-machine.ts`). Terminal states have empty transition lists; `failed → successful` is reachable only via an explicit `reversal: true` simulation.

**Amounts are integer minor units, always.** No FX conversion ever happens; `formatAmount` is display-only.

**The balance is a fold over an append-only ledger** (`balance_ledger`), never a stored mutable number — the same reasoning as the event log. A transfer *reserves* its amount when queued, not when it settles, so two queued payouts cannot spend the same money; a failed or reversed transfer credits the reservation back. The opening test float is a config value, deliberately **not** a ledger row, so `paybox reset` cannot wipe it.

**Recurring billing uses no new scheduler primitive.** A `subscription.charge` handler enqueues its own next occurrence, exactly the way a failed webhook schedules its retry. This is the single most load-bearing consequence of `VirtualClock#at`: because the scheduler runs each job at the instant it was *due*, one `time advance 1y` on a monthly plan yields twelve renewals with twelve correct dates. Billing periods use **calendar arithmetic** with day-of-month clamping (`core/src/time/recurrence.ts`), never a fixed 30 days.

**Provider-specific behaviour reaches the engine as an injected function, never an import.** `ProviderStatusResolver` (`core/src/engine.ts`) is how the stored `providerStatus` reads `success` for Paystack while the canonical status reads `successful` — without `core` learning that Paystack exists. `AuthorizationMinter` follows the same pattern: which channels mint a reusable handle is provider knowledge. Follow it for anything else core needs from an adapter.

**Canonical vocabularies are snake_case; adapters do the punctuation.** Paystack writes `non-renewing` and `awaiting-merchant-feedback`; the canonical statuses are `non_renewing` and `awaiting_merchant_feedback`, mapped in `providers/paystack/src/status.ts`.

**Never invent provider behaviour.** Read the live docs, cite the URL and date in a comment, and record anything unverifiable in `docs/<provider>.md`. Where a provider does *not* do something, neither do we — see the deliberate absence of `charge.failed` in `providers/paystack/src/webhook.ts`, which Paystack does not send.

### Time and determinism

The core promise is that the same inputs plus the same seed produce byte-identical output, and that advancing virtual time fires everything scheduled in that window *instantly*.

- `VirtualClock` (`core/src/time/clock.ts`) has `system` and `frozen` modes; `advance`/`freeze`/`set` move virtual time. It refuses to move backwards.
- `Scheduler` (`core/src/time/scheduler.ts`) is a durable job queue in the `jobs` table, comparing `runAt` against *virtual* time. It subscribes to `clock.onChange`, so an advance triggers `drain()` immediately. This is why there is no Redis/BullMQ: BullMQ delays live on the wall clock and could never fire under a time advance. `drain()` loops because draining enqueues newly-due work (a failed webhook schedules its own retry).
- `Random` (`shared/src/random.ts`) is xoshiro128**. `fork(label)` is load-bearing: each subsystem takes its own labelled stream so an extra webhook retry cannot shift the id stream and break unrelated tests.

Nothing outside `core/src/time/`, `core/src/random.ts`, `shared/src/ids.ts`, and `*.test.ts` may use `Date.now()`, zero-arg `new Date()`, `Math.random()`, `setTimeout`/`setInterval`, or `crypto.randomUUID()`. Inject a `Clock` and call `clock.now()`; draw from an injected `Random`. (`new Date(clock.now() + delta).toISOString()` is fine — only the zero-arg form is banned.) `eslint.config.js` documents the rationale, and its exemption list is the authoritative one.

`PAYBOX_SEED` is wired through `apps/api/src/config.ts`, along with `PAYBOX_FREEZE_CLOCK` and `PAYBOX_START_AT`. A frozen clock plus a fixed seed makes ids, timestamps and retry jitter reproducible, which is what the integration suite relies on.

**`VirtualClock#at` is load-bearing.** The scheduler runs each due job at the instant it was *scheduled for*, not at the time the clock has since reached. Without it, `time advance 2h` would fire a retry due at T+4s but stamp it T+2h and compute the next attempt from there — so a five-attempt ladder would need five separate advances, and event-log timestamps would be wrong.

### Storage conventions

- Rows are `snake_case` (`storage/src/schema.ts`); the domain model is `camelCase` (`shared/src/model.ts`). `storage/src/mappers.ts` is the **only** place the two meet, and the only place JSON columns are parsed/serialized. JSON reads are deliberately tolerant of hand-edited databases.
- Migrations in `storage/src/migrations.ts` are hand-written, forward-only, and applied at boot by `openStorage`. **Never edit an applied migration — append a new one.** There is no migration CLI.
- `Storage.transaction()` is reentrant: nested calls join the outer transaction, because the engine composes operations that each open one and SQLite has no true nesting.
- Repositories are plain objects closing over a Kysely handle, so identical code runs against a connection or a transaction.
- `event_sequences` is bumped by an upsert-and-return in the same transaction as the append, keeping per-resource sequences gapless.
- The custom dialect exists to avoid `better-sqlite3` — a native addon would break `npm install -g` on machines without a matching prebuild. `node:sqlite` is synchronous, so one connection serves everything and the driver serializes access with a queue.

### Fastify encapsulation

Each provider registers as an encapsulated plugin with its own prefix, error serialiser and hooks — that isolation is why this is Fastify rather than Express.

The sharp edge: a plugin registered as a **sibling** does not share hooks with its siblings. `idempotencyPlugin` and `networkPlugin` are wrapped in `fastify-plugin` specifically to escape encapsulation and reach the provider routes beside them. Getting this wrong makes the hooks silently do nothing — idempotency appeared to work and was a no-op until this was found.

Network latency is applied on the **response** (`onSend`), not the request. That is deliberate: it is what lets a webhook reach the developer's app before the API call that created it returns (spec §41).

### Errors

The engine only raises `PayboxError` with a code from the `ERROR_CODES` list. Each adapter owns the mapping to its provider's wire format (Paystack's `{status:false,message}`, Stripe's `{error:{type,code}}`). Note that decline-style codes default to HTTP 200: the request succeeded, the payment did not.

## Testing

Ten suites, 145 tests. The load-bearing one is in `tests/paystack-subscriptions.test.ts`: a monthly subscription plus a single `advance` must yield twelve invoices one calendar month apart, each payment stamped at its own period start. If that breaks, `VirtualClock#at` has broken.

`tests/helpers.ts` exposes `createHarness()` — in-memory SQLite, clock frozen at a fixed instant, fixed seed. Assertions can therefore be exact (literal ids, exact timestamps, gapless sequence numbers) rather than approximate. Prefer it over ad-hoc setup.

Vitest picks up `packages/**/*.test.ts`, `apps/**/*.test.ts`, and `tests/**/*.test.ts`.

## Adding a package

1. `packages/<name>/package.json` with `"exports": { ".": "./src/index.ts" }` — packages publish **TypeScript source**, not build output. `tsx` and Vitest resolve it directly; there is no build step in the dev loop.
2. `tsconfig.json` extending `../../tsconfig.base.json` with `composite`, `rootDir: src`, `outDir: dist`, and a `references` entry per dependency.
3. Add a `references` entry in the root `tsconfig.json`.
4. Workspace globs are `packages/*`, `packages/providers/*`, `apps/*`.

`tsconfig.base.json` sets `verbatimModuleSyntax` (type-only imports must say `import type`), `NodeNext` resolution (relative imports need the `.js` extension even from `.ts`), and `noUncheckedIndexedAccess` (indexing yields `T | undefined`).

`packages/*/dist/` is gitignored build output from `tsc -b`; it is never what runs.

## Safety rules (spec §29)

Never make the emulator capable of reaching a real provider or charging a real card. No real credentials, no real card data, never store a CVV. Generated credentials are labelled TEST/LOCAL. Bind to `127.0.0.1` by default and warn on `0.0.0.0`.
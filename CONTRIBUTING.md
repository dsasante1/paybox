# Contributing

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build          # the publishable package; fails on dependency drift
npm run smoke:package  # installs that package somewhere empty and runs it
```

## Non-negotiables

**1. Never call `Date.now()`, `new Date()`, `Math.random()` or a raw timer.**
Outside `packages/core/src/time/` this is an ESLint error. Inject a `Clock` and
a `Random`. This is what makes `paybox time advance` work and what makes
`PAYBOX_SEED` reproduce a run exactly.

**2. Provider logic never enters `packages/core`.** The engine must not learn
that Paystack exists. If core needs provider-specific behaviour, inject it as a
function (see `ProviderStatusResolver`).

**3. Never invent provider behaviour.** Read the live documentation, cite the
URL and the date you checked, and record anything you could not verify in that
provider's compatibility matrix. If a provider does not send a webhook for
something, we do not send one either — see the deliberate absence of
`charge.failed` in `packages/providers/paystack/src/webhook.ts`.

**4. Never claim coverage you do not have.** `docs/<provider>.md` is a contract.
"Partially compatible" with the gaps listed beats "compatible".

**5. No real card data, ever.** Test instruments are synthetic and fail Luhn.
CVV is not read, not stored, and not in the data model.

## Adding a provider

See [docs/architecture.md](docs/architecture.md#adding-a-provider). Nothing in
`packages/core` should need to change; if it does, that is the design telling
you something.

## Verifying against a large database

The repository caps a single page at 500 rows, so reporting endpoints and
lookups by a derived id behave differently either side of that boundary. Bugs
there are invisible to a suite that works with a handful of rows, and there is
no way to stage volume over the HTTP API.

`scripts/seed-volume.ts` writes settled payments straight through the engine
into a file-backed database. Serve that file and the HTTP surface is then
exercised over a realistic dataset:

```bash
npm run seed:volume -- ./data/volume.db 520 1000
PAYBOX_DATABASE=./data/volume.db npm start

curl -H "Authorization: Bearer sk_test_local_x" \
  localhost:8080/paystack/transaction/totals     # total_volume must be 520000
curl -H "Authorization: Bearer sk_test_local_x" \
  localhost:8080/paystack/transaction/export     # must return all 520 rows
```

Seeding 520 payments takes about a second. Use it whenever you touch an
endpoint that aggregates, exports, or resolves an id by scanning.

## Adding a runtime dependency

The workspace packages are private and export TypeScript source; what
developers install is `apps/paybox`, a bundle of the `@paybox/*` code with
third-party packages left as ordinary dependencies. So a new runtime dependency
goes in two places: the workspace that imports it, and
`apps/paybox/package.json`. `npm run build` fails if those disagree in either
direction — a package the bundle imports but does not declare would only show
up as a crash on someone's machine after `npx`.

## Releasing

A release is a tag: `v0.2.0` runs [docs/releasing.md](docs/releasing.md)'s
workflow, which verifies everything again and then publishes to npm, Docker
Hub and a GitHub Release. That document also has the one-time setup.

## Tests

Three levels, all offline:

- **Unit** — state machine, refund arithmetic, signatures, mappers
- **Integration** — the real HTTP stack via `fastify.inject()`
- **Provider compatibility** — responses carry the documented field set

Never test against a live provider API. If sandbox testing is useful, keep it as
a separate, opt-in suite.

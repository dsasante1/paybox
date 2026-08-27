# Contributing

```bash
npm install
npm test
npm run typecheck
npm run lint
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

## Tests

Three levels, all offline:

- **Unit** — state machine, refund arithmetic, signatures, mappers
- **Integration** — the real HTTP stack via `fastify.inject()`
- **Provider compatibility** — responses carry the documented field set

Never test against a live provider API. If sandbox testing is useful, keep it as
a separate, opt-in suite.

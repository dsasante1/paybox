# Spec references

Source comments throughout this repository cite design decisions as `spec §N`
— for example `spec §29` beside anything that refuses a live API key.

The numbers refer to a design brief that is not published with the code. It is
a working document written to drive the build, not documentation written to be
read, and publishing it would add noise rather than clarity. What it decided,
though, is worth being able to look up — so this file names every section the
code actually cites.

Where a section governs behaviour you can observe, the *reasoning* is already
in the code comment beside the citation, in `CLAUDE.md`, or in the relevant
`docs/<provider>.md`. Those are the places to look; this table is the index.

| § | Section | Cited |
|---|---|---|
| 2 | Core Architecture | 1× |
| 3 | Provider Adapter Architecture | 1× |
| 4 | Canonical Payment Model | 3× |
| 5 | Payment Methods | 8× |
| 7 | Payment State Machine | 5× |
| 8 | Event System | 2× |
| 9 | Webhook Engine | 4× |
| 10 | Webhook Failure Simulation | 3× |
| 11 | Payment Simulation Engine | 3× |
| 12 | Scenario System | 2× |
| 13 | API Compatibility | 5× |
| 15 | API Keys | 6× |
| 16 | Idempotency | 3× |
| 17 | Currency | 1× |
| 18 | Refunds | 5× |
| 19 | Transfers / Payouts | 2× |
| 20 | Customers | 1× |
| 21 | Dashboard | 2× |
| 23 | Timeline | 1× |
| 26 | Docker | 1× |
| 27 | Persistence | 1× |
| 28 | Seed Data | 2× |
| 29 | Security | 36× |
| 30 | Provider Isolation | 25× |
| 31 | Provider Documentation | 8× |
| 33 | Paystack | 4× |
| 37 | Testing Strategy | 1× |
| 38 | Example Developer Experience | 2× |
| 39 | Advanced Feature: Time Control | 6× |
| 40 | Advanced Feature: Network Simulation | 3× |
| 41 | Advanced Feature: Chaos Testing | 4× |
| 42 | Observability | 2× |
| 43 | Localhost Safety | 1× |
| 44 | API Documentation | 1× |
| 45 | Developer Examples | 6× |
| 49 | Dashboard UX | 1× |
| 53 | Quality Requirements | 1× |

## The three cited most

**§29 Security** — the emulator must never be able to reach a real provider or
charge a real card. No real credentials, no real card data, never a stored CVV;
generated credentials are labelled TEST or LOCAL; it binds to `127.0.0.1` by
default. Every live API key is refused with HTTP 403, and that is not
configurable.

**§30 Provider Isolation** — provider-specific behaviour must never leak into
the engine. Anything a provider needs from core arrives as an injected function
— a status resolver, an instrument table, an authorization minter — never an
import. It is why `packages/core` contains no provider name.

**§31 Provider Documentation** — coverage is documented honestly and never
overstated. Each `docs/<provider>.md` is a contract, and
`tests/coverage-drift.test.ts` now enforces it: an adapter cannot serve a route
it has not declared, or declare one it does not serve.

# Wise coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Every shape below was verified against the **Wise Platform API OpenAPI 3.1.0
document**, version `2026Q3`, sha256 `a571c1f981ef9701a52a9cccfcf11e164196462f`,
fetched from `docs.wise.com/_bundle/api-reference/@latest/index.json` and read
**2026-08-29**. Source comments cite the `operationId`. Webhook details come
from `docs.wise.com/guides/developer/webhooks/event-handling`, read the same
day.

Note for anyone re-verifying: `docs.wise.com/api-reference/openapi.json`
returns the documentation site's HTML shell, not a spec. The bundle URL above
is the real thing.

Base path: `/wise`. Wise's production servers are
`https://api.wise.com/2026Q3` and `https://api.wise-sandbox.com/2026Q3`, and
its paths are versioned per resource (`/v1/transfers`, `/v3/quotes`,
`/v4/…/balances`) rather than globally — those per-resource versions are
preserved here, so an existing client changes only its host.

## The flow

Wise is stricter than any other provider in paybox, and the adapter enforces
all of it, because each rule is one a real integration has to satisfy:

```
profile ──> quote ──> recipient ──> transfer ──> fund
```

- A transfer **cannot exist without a quote**. The quote carries the rate.
- A quote can be used **once**: *"You can only create one transfer per one
  quote."*
- A quote **expires** after 30 minutes; its rate after three days.
- Creating a transfer reserves nothing. **Funding** it is a separate call, and
  that is what debits the balance.

## Authentication

`Authorization: Bearer <token>`. Wise accepts a Personal API Token or an OAuth
user access token, both declared in the spec as JWT bearer credentials. paybox
issues a `wise_test_local_…` token and prints it in the startup banner.

The live-credential guard is shaped differently here from the other adapters,
and it is worth being precise about why. Wise tokens carry no `sk_live_`-style
marker, so there is nothing to pattern-match on. What paybox refuses instead is
anything **JWT-shaped** — three base64url segments separated by dots. A real
Wise access token always is; a locally generated one never is. That is the
honest test the format allows, and it is weaker than the guarantee the other
five adapters give.

## Endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /v2/profiles` | **Partially compatible** | Two profiles seeded; see below. |
| `GET /v2/profiles/{profileId}` | **Partially compatible** | Personal and business shapes. |
| `GET /v1/rates` | **Partially compatible** | A fixed table, not market data — see below. |
| `POST /v3/profiles/{profileId}/quotes` | **Compatible** | Enforces exactly one of `sourceAmount`/`targetAmount`. |
| `POST /v3/quotes` | **Compatible** | The unauthenticated pre-login quote. |
| `GET /v3/profiles/{profileId}/quotes/{quoteId}` | **Compatible** | |
| `PATCH /v3/profiles/{profileId}/quotes/{quoteId}` | **Compatible** | Attaches a recipient. |
| `POST /v1/accounts` | **Partially compatible** | `details` stored as sent; three routes validated. |
| `GET /v2/accounts` | **Partially compatible** | No seek pagination. |
| `GET /v2/accounts/{accountId}` | **Compatible** | |
| `DELETE /v2/accounts/{accountId}` | **Compatible** | Deactivates, as Wise does. |
| `GET /v1/quotes/{quoteId}/account-requirements` | **Partially compatible** | GBP, EUR, USD, plus a SWIFT fallback. |
| `POST /v1/transfers` | **Compatible** | Quote required, single-use, `customerTransactionId` idempotent. |
| `GET /v1/transfers` | **Compatible** | Bare array, as published. |
| `GET /v1/transfers/{transferId}` | **Compatible** | |
| `PUT /v1/transfers/{transferId}/cancel` | **Compatible** | Refused once sent. |
| `POST /v3/profiles/{p}/transfers/{t}/payments` | **Partially compatible** | Only `type: BALANCE` — see below. |
| `GET /v1/transfers/{transferId}/payments` | **Compatible** | |
| `GET /v4/profiles/{profileId}/balances` | **Compatible** | Folded from the ledger. |
| `GET /v4/profiles/{profileId}/balances/{balanceId}` | **Compatible** | |
| `POST /v4/profiles/{profileId}/balances` | **Partially compatible** | `SAVINGS` accepted, behaves as `STANDARD`. |
| `POST /v2/profiles/{profileId}/balance-movements` | **Compatible** | Conversion between your own balances. |
| `GET /v1/profiles/{profileId}/total-funds/{currency}` | **Compatible** | |
| `GET /v1/simulation/transfers/{id}/{status}` | **Compatible** | **Wise's own** sandbox driver. |
| `POST /v1/simulation/balance/topup` | **Compatible** | **Wise's own** sandbox funding. |
| `POST`/`GET /v2/profiles/{profileId}/subscriptions` | **Compatible** | Registers against paybox's webhook store. |
| `GET`/`DELETE /v2/profiles/{p}/subscriptions/{id}` | **Compatible** | |
| `GET /wise/paybox/webhook-public-key` | **Emulator-only** | The RSA public key paybox signs with. |
| Cards, spend controls, spend limits, card orders, batch groups, disputes, cases, KYC review, SCA (OTP, PIN, facemaps, device fingerprints), JOSE, digital wallets, direct debit, bank account details, address, activity, GPI tracking, comparison, claim account, payins, bulk settlement, verification, 3DS, third-party transfers, incoming transfers | **Not supported** | |

Wise's published surface is 174 paths across 50 tags. This adapter implements
the payout core. Every tag left out is named in the row above.

## What is faithful, and deliberately so

**RSA webhook signatures — the only asymmetric scheme in paybox.** Every other
adapter shares one secret, so signing and verifying are the same operation.
Wise does not: *"Signatures are generated using an RSA key and SHA256 digest of
the message body. They are transmitted using the `X-Signature-SHA256` request
header and are Base64 encoded."* A subscriber holds no secret at all — it
verifies against a published public key. That is reproduced exactly, which
means the same `crypto.createVerify('RSA-SHA256')` call a developer writes for
production works unchanged against the emulator. `X-Delivery-Id` and
`X-Test-Notification` are sent too.

**Wise's own simulation endpoints.** `GET /simulation/transfers/{id}/{status}`
and `POST /simulation/balance/topup` are Wise's, not paybox's — the company
ships a sandbox state-driver with the same purpose as `paybox simulate`. So
they are implemented as published rather than replaced, and **an existing Wise
sandbox script drives the emulator unchanged**. The five accepted statuses are
the spec's enum verbatim: `processing`, `funds_converted`,
`outgoing_payment_sent`, `bounced_back`, `funds_refunded`. This is also why
Wise needs no emulator-only funding endpoint, unlike WeWire.

**A quote is single-use and expires.** Both are real Wise rules and both are
enforced. Reusing a quote is a 409; using an expired one is a 422. A developer
who has never hit either in production will hit them here, which is the point.

**Funding is a separate call, and a rejection is a `201`.** `POST /…/payments`
returns `{type, status, errorCode, errorMessage, balanceTransactionId}` with
`status: REJECTED` on failure — **not** an HTTP error. That is Wise's design,
and reproducing it matters: a client branching on the HTTP status alone would
read a rejected funding as a success. paybox returns 201 with `REJECTED` for an
already-funded transfer, a wrong-state transfer, an unavailable pay-in type and
an insufficient balance.

**Two timestamp formats, because Wise has two.** A quote's `createdTime` is
ISO-8601 with a `Z` (`2019-04-05T13:18:58Z`); a transfer's `created` is
space-separated with no zone (`2017-11-24 10:47:49`); a rate's `time` uses
`+0000`. All three are transcribed as published rather than normalised — a
client parsing one and receiving another is a real Wise integration bug and it
should surface here.

**Mixed id types, because Wise has those too.** Profiles, recipients,
transfers, balances and payments are `int64`; quotes and webhook subscriptions
are UUIDs. Both are reproduced.

**`trigger_on`, not an event name.** Wise sends no past-tense event string. A
subscription declares `trigger_on: transfers#state-change` and each delivery
carries `event_type`, `schema_version` and a `data` block whose
`current_state` is the field a consumer branches on. That is a genuinely
different integration shape from the other five providers and it is preserved.

## What differs, and why

**FX rates are a fixed table.** The reasoning is set out in
`docs/architecture.md` and is the same as WeWire's: a rate that moved between
two runs would make the same inputs produce different output, and determinism
is the property this project will not trade away. The mid rates in
`providers/wise/src/rates.ts` are plausible round numbers, **not market data**.

Unlike the WeWire adapter, there is **no spread**: Wise quotes a single
mid-market rate and charges a visible fee, and `GET /rates` returns one `rate`
per pair with no bid or ask. Adding a spread would misrepresent how Wise
prices.

**The "no FX conversion" invariant still holds.** The rate lives in the
adapter, exactly as Paystack's status vocabulary lives in its own. A quote
stores two integer minor-unit amounts and the rate that produced them; a
balance conversion is two integer ledger entries, a debit and a credit. Core
never converts and `getBalance` still folds per currency.

**Fees are always zero.** Wise's real pricing is a percentage plus a fixed
component that varies by corridor and pay-in method. Inventing a schedule would
produce numbers a developer might build against and that would be wrong
everywhere.

**Numeric ids are hashed, not sequential.** paybox ids are prefixed base32
tokens and Wise's are `int64`, so something has to bridge them. A monotonic
counter would be deterministic but **order-fragile** — insert one transfer at
the head of a test and every later id shifts. A hash is stable under
reordering, which is what lets tests assert literal ids. Ids are therefore not
sequential, which no Wise client should depend on.

**Only `type: BALANCE` can fund a transfer.** Wise supports several pay-in
methods, but every other one requires money to arrive from outside the
emulator. Any other type is rejected with `payment.option-unavailable`.

**Two profiles are seeded, not created.** Wise's flow begins with choosing a
profile, so an emulator with none would strand a developer at step one. paybox
lazily creates one `PERSONAL` and one `BUSINESS` profile on first use — which
keeps `paybox reset` meaningful, since reset really does empty everything and
the next request rebuilds them. Profile creation, KYC, directors, UBOs and
verification documents are not modelled.

**Quotes are stored as idempotency records, not a table.** A quote is
short-lived, immutable except for `targetAccount`, and consumed exactly once —
which is what that store already is. It is written under both its paybox id
and the UUID the client was given, so lookup is O(1) from either direction. A
migration for something with a 30-minute life would have been the wrong trade.

**`funds_converted` has no canonical status.** It is a real Wise milestone —
the FX leg has settled — that does not change whether the money has left.
paybox maps it to canonical `processing` and records a flag on the transfer so
the reported status can still tell the two apart. Inventing a canonical status
for one provider's intermediate step is exactly the leak spec §30 forbids.

**Account requirements cover three routes.** Wise serves required fields
dynamically per currency and has dozens; paybox publishes GBP (`sort_code`),
EUR (`iban`) and USD (`aba`), with a SWIFT fallback for everything else. The
`details` object on `POST /accounts` is stored as sent rather than validated
against a subset, so an account Wise would accept is not rejected here.

**Errors use one envelope of Wise's several.** Wise has accumulated at least
three: `{timestamp, errors:[…]}`, `{error, message, timestamp, path}`, and an
RFC-7807-style `{type, status, code, detail}`. paybox uses the first, because
it is the one the spec documents on these endpoints — `POST /accounts` types
its 400 as exactly that. Worth knowing: **the transfer and quote endpoints
carry no error schema in the spec at all**, so their error shape here is
inferred from the recipient envelope rather than transcribed.

Responses carry a `paybox_code` alongside Wise's code, so a failure can be
traced back to the canonical error without changing how a real client parses
the body.

## Webhooks

| Canonical event | Wise `event_type` | `data.current_state` |
| --- | --- | --- |
| `transfer.processing` | `transfers#state-change` | `processing` or `funds_converted` |
| `transfer.successful` | `transfers#state-change` | `outgoing_payment_sent` |
| `transfer.failed` | `transfers#state-change` | `bounced_back` |
| `transfer.reversed` | `transfers#state-change` | `funds_refunded` |
| `transfer.cancelled` | `transfers#state-change` | `cancelled` |

One trigger, five outcomes — the consumer reads `current_state`. Headers are
`X-Signature-SHA256` and `X-Delivery-Id`.

**Not emitted:** every other trigger in Wise's catalogue —
`balances#credit`, `balances#update`, `profiles#state-change`,
`cards#transaction-state-change`, `kyc-reviews#state-change`,
`transfers#payout-failure`, `transfers#refund`, `transfers#active-cases`, and
the rest. paybox has no cards, KYC lifecycle, or case management to report on.
Where a provider does not send something, neither does paybox — and where
paybox cannot produce something a provider does send, this file says so.

## The signing keypair

paybox signs webhooks with an RSA keypair **embedded in
`providers/wise/src/signature.ts`, private key included**. That is deliberate
and worth stating plainly:

- It is **not Wise's key**. Wise's private key is theirs; paybox cannot sign as
  Wise and does not try.
- The private key is published, so a paybox signature proves nothing about
  authenticity. It is not meant to. It exists so a developer's verification
  code can be exercised end to end — the same reasoning as the
  `sk_test_local_` secrets everywhere else in this project.
- It is embedded rather than generated at boot because `generateKeyPairSync`
  cannot be seeded, and a fresh key per run would make signatures differ
  between two runs at the same seed — breaking the guarantee in spec §7.

Fetch the public key from `GET /wise/paybox/webhook-public-key`.

## Not supported

Cards and card orders, spend controls and limits, batch groups, disputes,
support cases, KYC review flows, all SCA surfaces (OTP, PIN, facemaps, device
fingerprints, sessions, OTT), JOSE, digital wallets, direct-debit accounts,
bank account details, addresses, activity feeds, GPI tracking, the comparison
API, claim-account, pay-in deposit details, bulk settlement, verification,
3DS, third-party transfers, incoming transfers, link requests, hold-limit
breaches, excess-money accounts, balance statements, and multi-currency
account configuration.

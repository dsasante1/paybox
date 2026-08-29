# WeWire coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Every shape below was verified against the published documentation at
`docs.wewire.com`, read **2026-08-29**, via the site's own `llms-full.txt`
export. Where WeWire publishes an example response, the adapter reproduces it
field for field; where it does not, this file says so rather than letting a
guess pass as transcription.

Base path: `/wewire` — WeWire's own paths already begin `/v1/...`, so an
existing client only changes its host.

## Authentication

WeWire does **not** use a bearer token. The key goes in a `ww-api-key` header,
verbatim, with no prefix. That is reproduced exactly rather than also
accepting `Authorization: Bearer` out of politeness — a client sending the
wrong header should find out here, where the fix is one line.

Keys are `sk_test_` for sandbox and `sk_live_` for production. paybox
generates an `sk_test_local_…` key on first start and prints it in the
startup banner. **A key beginning `sk_live_` is refused with HTTP 403 and this
is not configurable** (spec §29).

## Endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/transactions/initiate-payout` | **Partially compatible** | Full request validation; `supportingDocuments` counted, not stored. Fee is always 0. |
| `GET /v1/transactions` | **Compatible** | All eight filters, `createdAt` descending, WeWire's pagination envelope. |
| `GET /v1/transactions/{transactionId}` | **Compatible** | Resolves payouts, collections and reversals. |
| `GET /v1/wallets` | **Partially compatible** | Shape inferred — see below. |
| `GET /v1/subcustomers/{id}/wallets` | **Partially compatible** | Same caveat. |
| `GET /v1/rates` | **Partially compatible** | A fixed table, not market data — see below. |
| `GET /v1/rates/{pair}` | **Partially compatible** | Accepts `USD-GHS` or `USD/GHS`. |
| `POST /v1/rates/conversion/preview` | **Partially compatible** | `fee` is always 0. |
| `POST /v1/beneficiaries` | **Compatible** | Real IBAN, BIC, sort-code and ABA checksums. |
| `GET /v1/beneficiaries`, `GET /v1/beneficiaries/{id}` | **Compatible** | |
| `PATCH /v1/beneficiaries/{id}` | **Compatible** | |
| `DELETE /v1/beneficiaries/{id}` | **Partially compatible** | Soft — see below. |
| `GET`/`POST /v1/beneficiaries/{id}/accounts` | **Compatible** | |
| `GET /v1/beneficiaries/{id}/accounts/{accountId}` | **Compatible** | |
| `POST /v1/subcustomers` | **Partially compatible** | Created `APPROVED`; no KYC review lifecycle. |
| `GET /v1/subcustomers`, `GET /v1/subcustomers/{id}` | **Compatible** | |
| `PATCH /v1/subcustomers/{id}/archive` | **Compatible** | |
| `POST /v1/collections` | **Compatible** | Ghana mobile money, `202 Accepted`, published sandbox numbers. |
| `POST /v1/disbursements` | **Compatible** | Ghana mobile money and bank, `202 Accepted`. |
| `GET /v1/account-lookup` | **Partially compatible** | Name is derived, not looked up — see below. |
| `POST /wewire/paybox/wallets/credit` | **Emulator-only** | Fund a wallet. Not WeWire surface. |
| `GET /wewire/paybox/ghana-codes` | **Emulator-only** | WeWire publishes these as a reference page. |
| Crypto wallets, virtual accounts, business KYC, beneficial owners, sweeping, sub-customer money movement, auto-sweep, supported assets | **Not supported** | |

## What is faithful, and deliberately so

**The Standard Webhooks specification, including its sharp edge.** WeWire is
the first provider in paybox that does not roll its own signature scheme. It
sends `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64>`,
signs `{id}.{timestamp}.{body}`, and — the part that trips people up — uses
**the base64-decoded portion after `whsec_`** as the HMAC key, not the literal
secret string. All of that is reproduced, along with the five-minute replay
tolerance and multiple space-separated signatures during rotation. Because the
signature covers a timestamp, it is recomputed on every delivery attempt, so a
retry after `paybox time advance 10m` carries a fresh timestamp and a fresh
signature — which is exactly what a consumer's tolerance check needs in order
to be worth testing.

**Per-rail reference validation.** The `reference` on a payout travels to the
receiving bank, so the payment network sets the rules. WeWire publishes both
patterns and the adapter enforces them: SEPA allows 1–140 characters from a
generous set with no leading or trailing space; Faster Payments allows 1–18
characters from a much smaller one. A reference that is fine on EUR and
rejected on GBP is exactly the failure a developer would otherwise discover in
production.

**Real bank-detail checksums.** Beneficiary accounts are validated at write
time, as WeWire documents: IBAN mod-97, BIC format, six-digit sort code with an
eight-digit account number, and the ABA routing number's weighted 3-7-1
checksum. A transposed digit fails here, not at payout time.

**WeWire's published sandbox numbers.** Six Ghana mobile-money numbers drive
deterministic outcomes (`0240000001` succeeds, `0240000002` fails, and so on).
These take priority over paybox's own conventions, because a developer's
existing WeWire sandbox suite then drives the emulator with no changes at all.
The `accountCode` must match the number's network, so a typo cannot silently
inherit a deterministic outcome.

**Two different shapes for the same money.** WeWire's wallet transaction types
`amount` as a JSON number (`2500.00`); its Africa collection and disbursement
objects type it as a string (`"100.00"`). Its API object has `id`,
`settledAt` and `channel: "AUTOMATED_PAYOUT"`; its webhook payload for the
same transaction has `transactionId`, no `settledAt`, `channel: "PAYOUT"`, and
extra `walletId` / `businessId` / `quoteId` / `memo` fields. Both are
transcribed as published. Unifying them would be tidier and wrong — a handler
reading `data.id` needs to find out here that WeWire sends `transactionId`.

**Idempotency is a body field on three endpoints, not a header on all of
them.** WeWire's docs say it supports idempotency on
`POST /v1/transactions/initiate-payout` only, with `idempotencyKey` in the
body; the two Africa endpoints document the same replay semantics on their own
pages. The adapter implements exactly those three. Replaying a key with a
different body is a `409 RESOURCE_ALREADY_EXISTS`, not a cache hit. paybox's
shared idempotency hook reads a header, so it is deliberately **not**
registered for WeWire — the quirk stays in the adapter that has it.

**`balanceBefore` and `balanceAfter` are folded, not stored.** Every wallet
transaction carries them, and they come from the same append-only ledger that
answers `GET /v1/wallets`. The two can therefore never disagree.

**The corridor decides the event name.** The same canonical
`transfer.successful` becomes `disbursement.completed` for a Ghana payout and
`transaction.status_updated` for an offshore one, because those are two
different products with two different payload shapes. The corridor is recorded
on the transfer at creation, so the formatter reads it rather than guessing
from the currency.

## What differs, and why

**FX rates are a fixed table.** WeWire refreshes rates on a 30-minute cycle
from its liquidity providers. paybox cannot: a rate that moved between two runs
would make the same inputs produce different output, and determinism is the one
property this project will not trade away. The mid rates in
`providers/wewire/src/rates.ts` are plausible round numbers, **not market
data**, and the 0.5% spread is a documented stand-in rather than a claim about
WeWire's pricing. Do not use these figures for anything but testing that your
code reads a rate.

**About the "no FX conversion" invariant.** `CLAUDE.md` states that no FX
conversion ever happens in the engine. That still holds. The rate lives in the
adapter, exactly like Paystack's status vocabulary; a cross-currency payout is
recorded as an integer minor-unit amount in the source currency, with the
destination amount and the rate that produced it stored as metadata. The ledger
stays integers end to end and `getBalance` still folds per currency. The
adapter quotes; core only records what was quoted.

**Fees are always zero.** paybox models no pricing for any provider. WeWire's
example responses show a non-zero `fee`, and the adapter returns `0` rather
than inventing a schedule that would be wrong in a way a developer might build
against.

**`GET /v1/wallets` has an inferred shape.** WeWire documents that the endpoint
"returns your business wallets" and that there is one wallet per currency per
holder, but publishes no example body. The fields returned here are the minimum
that statement implies. Treat the shape as unverified.

**`pendingBalance` is always 0.** paybox settles instantly, so there is no
window in which money is collected but unavailable. Reporting a plausible
non-zero figure would invite a "wait for funds" flow that could never complete.

**Account lookup derives the name.** There is no operator to ask, so
`GET /v1/account-lookup` returns a name generated deterministically from the
account number — the same number always resolves to the same name, which is
what makes a test assertable. It is not a real lookup, and a number that WeWire
would reject as non-existent will resolve here.

**A `reference` must be unique per provider.** paybox enforces one payment per
reference for every adapter, so a second collection reusing a reference is a
`409 RESOURCE_ALREADY_EXISTS`. WeWire does not document such a rule — its
`reference` is described as yours, for reconciliation. Send distinct
references, or omit the field and take the generated 16-digit id.

**Deleting a beneficiary is soft.** The accounts survive so that a historical
payout still resolves the destination it was sent to. Rewriting the past is
something an append-only system should never do.

**Sub-customers are created `APPROVED`.** WeWire has an extensive KYC lifecycle
— individual and business flows, document upload, beneficial owners, hosted
links, enhanced due diligence, rejection labels. None of it is modelled, so a
sub-customer is usable immediately and the `subcustomer.kyc_status_updated`
webhook is never emitted.

**A sub-customer is stored as a canonical subaccount, and a beneficiary as a
canonical customer** whose accounts are transfer recipients. Both are honest
fits for models that already existed — a sub-customer is a party whose balance
the platform holds and settles on its behalf, which is what a subaccount is —
which is why this adapter needed no migration.

**The payout lifecycle diagrams disagree with each other.** WeWire's payout
page shows `PENDING → SUCCESSFUL | FAILED | REVERSED | CANCELLED`; its webhook
page shows `PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED`. paybox
follows the webhook version, since it is the one attached to the event a client
actually receives, and passes through `PROCESSING`. Both are recorded here
because the discrepancy is WeWire's, not a paybox choice.

**`POST /v1/transactions/initiate-payout` returns 200.** WeWire's docs show the
response body but never state the status code, unlike the Africa endpoints
which say `202 Accepted` explicitly. 200 is a guess; treat it as unverified.

## Webhooks

| Canonical event | WeWire event | Payload |
| --- | --- | --- |
| `payment.successful` | `collection.completed` | Africa object + `reason: null`, `occurredAt` |
| `payment.failed`, `payment.expired` | `collection.failed` | Africa object + non-null `reason` |
| `transfer.processing` (GH) | `disbursement.initiated` | Africa object |
| `transfer.successful` (GH) | `disbursement.completed` | Africa object |
| `transfer.failed`, `transfer.reversed` (GH) | `disbursement.failed` | Africa object + `reason` |
| `transfer.*` (offshore) | `transaction.status_updated` | Wallet-transaction webhook object |

**Not emitted, deliberately:**

- `transaction.pay_in` — fires when a virtual account is credited. paybox does
  not provision WeWire virtual accounts, so nothing can produce it. Emitting it
  for a Ghana collection would be wrong: WeWire sends `collection.completed`
  for that.
- `subcustomer.*` and `virtual_account.status_updated` — there is no KYC review
  lifecycle or virtual-account provisioning to report on.

Where a provider does not send something, neither does paybox.

## Errors

WeWire's envelope is `{ success: false, error: { code, message, statusCode } }`,
with a `details` array naming each offending field on a validation failure.
Its docs are explicit that `success` is the single source of truth: *"If
`success` is missing or `true`, treat the response as a success regardless of
status."* Simulated network failures carry the same envelope for that reason.

Responses also carry a `paybox_code` alongside WeWire's own code, so a failure
can be traced back to the canonical error without changing how a real client
parses the body.

## Emulator-only endpoints

Two endpoints exist here that WeWire does not have. Both are namespaced under
`/paybox/` so they can never be mistaken for provider surface:

- **`POST /wewire/paybox/wallets/credit`** — put money in a wallet. WeWire funds
  a wallet by someone paying into a virtual account, which cannot happen
  locally. Without this a fresh emulator has a zero balance and every payout
  fails on `INSUFFICIENT_BALANCE`, so the whole payout flow would be
  untestable.
- **`GET /wewire/paybox/ghana-codes`** — the mobile-money and GhIPSS bank code
  tables. WeWire publishes these as a documentation page, not an endpoint.

## Not supported

Crypto wallets and deposit addresses, virtual accounts, business KYC in all its
parts (company details, document upload, beneficial owners, submission for
review), hosted KYC links, sub-customer accounts (request, suspend, reactivate,
simulate deposit), sub-customer money movement (convert, collect, disburse,
sweep in/out, transfer between sub-customers), auto-sweep configuration,
supported-asset listings, and `GET /v1/wallets/supported-assets`.

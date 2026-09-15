# Quid Payments coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Every shape below was verified against Quid Payments' **published OpenAPI
document** (`docs.quiddpayments.com/openapi.json`, public contract `2026-06`),
the merchant guide (`/merchant-api.md`), and the payouts, webhooks and testing
pages — all read **2026-09-15**. Where the document types something loosely,
this file says so rather than inventing a shape.

Base path: `/quiddpay/api/v1` — the `api/v1` segment is part of Quid's own
published URLs, so an existing client's paths work unchanged.

Quid Payments is a **hosted-checkout** product: the merchant creates a session,
redirects the payer to `checkout_url`, and waits for a signed webhook. Its
guide is explicit that a merchant backend "does not start payment-method
calls". The emulator therefore serves both halves — the merchant API *and* the
public checkout API the hosted page itself calls — so the whole documented
integration can be exercised locally.

## Endpoints

### Checkout sessions and service codes

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /sessions` | **Compatible** | Returns a `checkout_url`. `201`. |
| `GET /sessions/{reference}` | **Compatible** | The backend fallback confirmation path. |
| `POST /invoice-lines` | **Compatible** | Honours `Idempotency-Key`. |
| `GET /invoice-lines` | **Partially compatible** | `invoice_ref` required; no paging. |
| `POST /revenue-lines` | **Compatible** | Bulk sync with `deactivate_missing`. |
| `GET /revenue-lines` | **Partially compatible** | No paging or filtering. |

### Public checkout (what the hosted page calls)

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /checkout/options` | **Partially compatible** | Fixed rail, branch and bank lists. |
| `GET /checkout/sessions/{reference}` | **Compatible** | The payer-facing view. |
| `GET /checkout/sessions/{reference}/quote` | **Partially compatible** | No surcharges; see below. |
| `GET /checkout/sessions/{reference}/bank-transfer-banks` | **Partially compatible** | paybox's bank list. |
| `POST /checkout/sessions/{reference}/momo-account-verification` | **Partially compatible** | Never resolves a real wallet. |
| `POST /checkout/sessions/{reference}/provider-attempts` | **Compatible** | All three rails; `replayed` honoured. |
| `GET /checkout/sessions/{reference}/provider-attempts/{ref}` | **Compatible** | Carries `finalized`. |
| `POST …/provider-attempts/{ref}/authorize` | **Compatible** | The wallet PIN. Mobile money only. |
| `POST …/provider-attempts/{ref}/resend` | **Partially compatible** | Echoes the attempt; no new prompt. |
| `POST …/provider-attempts/{ref}/payment-declarations` | **Compatible** | Records the claim; does not confirm it. |
| `GET /checkout/sessions/{reference}/receipt` | **Compatible** | After the session is paid. |
| `PUT /checkout/sessions/{reference}/receipt-email` | **Partially compatible** | No mail is sent. |
| `POST /checkout/cash-slips` | **Compatible** | One slip per session; re-request replays. |

### Test mode

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /test/payment-attempts/{reference}/simulate` | **Compatible** | Quid's own endpoint. All eight outcomes. |

### Payouts

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /payouts/capabilities` | **Partially compatible** | Fixed channels and fees. |
| `GET /payouts/balance` | **Compatible** | Folded from the ledger. |
| `POST /payouts/recipients` | **Compatible** | `201`, `pending_verification`, not idempotent. |
| `GET /payouts/recipients` | **Compatible** | Paged. |
| `GET /payouts/recipients/{recipient_id}` | **Compatible** | |
| `DELETE /payouts/recipients/{recipient_id}` | **Compatible** | `204`. |
| `POST /payouts/recipients/{recipient_id}/verify` | **Partially compatible** | Resolves immediately. |
| `POST /payouts/quote` | **Partially compatible** | paybox's fee schedule; see below. |
| `POST /payouts` | **Compatible** | Idempotent on `client_reference`. |
| `GET /payouts` | **Compatible** | `page`, `limit`, `reference`. |
| `GET /payouts/{payout_id}` | **Compatible** | |
| `POST /payouts/{payout_id}/cancel` | **Compatible** | `409` once it can no longer be cancelled. |
| `GET /payouts/{payout_id}/receipt` | **Partially compatible** | A generated PDF with no branding. |
| `GET /payouts/{payout_id}/evidence/{evidence_id}` | **Partially compatible** | One receipt document per payout. |

### Emulator-only

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /quiddpay/checkout/{reference}` | **Emulator-only** | The hosted page `checkout_url` points at. |
| `POST /quiddpay/checkout/{reference}/pay` | **Emulator-only** | That page's own form. Not Quid surface. |

Not implemented: branch collections, merchant-dashboard actions (creating
integrations, API keys and webhook endpoints are dashboard operations with no
API), live mode, and anything to do with settlement to a merchant's own bank.

## What is faithful, and deliberately so

**There are no card payments.** Quid states plainly that "Card payments are not
supported. Merchants must not submit card data." So neither does paybox: there
is no card rail, no card schema and nothing that would accept a PAN. Where a
provider does not do something, neither does the emulator.

**A session is not a charge.** Quid's model is a session you can attempt to pay
more than once — a declined mobile-money prompt, then a bank transfer, against
the same invoice. Attempts are therefore plural and addressed by their own
`attempt_reference`, and the session outlives them. `paybox` stores the session
as the canonical payment and the attempts beside it.

**`open` and `pending` are different things, and both are preserved.** `open`
means payable and untried; `pending` means an attempt is in flight and the
merchant must not fulfil. Quid's own guidance — "order remains pending while
`finalized` is false" — is built on that distinction, so collapsing the two
would erase the state a merchant integration most needs to be tested against.

**`finalized` describes the session, not the attempt.** A failed attempt on a
session that is still payable is not a final answer. The attempt-status
endpoint reports both, exactly as Quid does.

**Only final checkout events are sent.** `checkout.session.completed`,
`.failed` and `.expired` — there is no pending event, because Quid does not
send one. A merchant who could subscribe to one here would be building against
something that never arrives in production.

**Payout events cover the whole lifecycle, unlike checkout events.** All six of
`payout.requested`, `.processing`, `.paid`, `.failed`, `.cancelled` and
`.returned` are emitted, and a paid payout really can later be `returned`,
which Quid warns about explicitly.

**A declaration is a claim, not a confirmation.** `POST
/payment-declarations` records *when* the payer said they had sent a bank
transfer and leaves the session pending. A merchant that fulfils on a
declaration has a bug, and this is where they should find it.

**A cash deposit stays pending until a teller confirms it.** There is no teller
here, which is exactly why Quid ships a test simulator — see below.

**Payout creation is idempotent on `client_reference`, not on a header.** An
unchanged repeat returns the original payout with `200`; a changed request
under the same reference is `409 REFERENCE_CONFLICT`. Quid's guide says not to
send `Idempotency-Key` to a payout endpoint for exactly this reason. (paybox's
shared idempotency hook would still honour the header if you sent one, which
Quid does not promise — see *Differences* below.)

**`max_fee_minor` creates neither a payout nor a hold when it is exceeded.**
`409 FEE_LIMIT_EXCEEDED`, and the balance is untouched.

**Test payouts settle immediately.** "Valid Test payouts return `paid`
immediately, without recipient verification or approval," with a `TEST-`
transaction reference and `reconciliation_status=not_required`. So creating one
queues `payout.requested` and `payout.paid`, and it can no longer be cancelled.

**The webhook signature covers a timestamp.**
`X-Payment-Platform-Signature: t=<unix>,v1=<hex>` over `<t>.<raw body>`, with
Quid's documented 300-second tolerance. The signature is recomputed on **every
retry**, so a delivery replayed after `paybox time advance 10m` carries a fresh
timestamp — which is what makes your tolerance check worth testing rather than
something the emulator quietly sidesteps. `X-Payment-Platform-Event-Id` is
stable across retries, so your deduplication really is exercised.

**Amounts never convert.** Quid speaks `amount_minor` in pesewas and paybox
speaks integer minor units. The two agree, so nothing in the adapter multiplies
or divides — unlike the Flutterwave and Kora adapters, which convert at the
boundary.

## Differences from Quid Payments

**The fee schedule is paybox's, not Quid's.** Quid never publishes payout fee
figures — its guide says to read the fee from `POST /payouts/quote`. There is
nothing to transcribe, so paybox uses a fixed table (250 pesewas for a bank
payout, 100 for a wallet) in `providers/quiddpay/src/rates`. A fixed table
rather than a moving rate, because a varying fee would break determinism. What
*is* faithful is the shape around it: the quote reserves nothing, locks no
pricing, and `max_fee_minor` caps what you will accept.

**The bank and branch directories are paybox's.** Quid publishes only one
worked example of a bank id (`gcb-bank`). The list here uses real Ghanaian
institutions under ids of that form so a payload copied from your own code
works unchanged, but nothing is ever resolved against a real institution and no
account number here belongs to anyone.

**Three test outcomes do not finalise the session.** `pending`,
`manual_review` and `amount_mismatch` move the attempt and leave the session
payable, because none of them is a decision. As a consequence **no
`checkout.session.*` webhook follows them** — there is no final state to
report. The attempt-status endpoint reflects them immediately.

**`reversed` settles the session `failed`.** `CheckoutSessionStatusEnum` has
five members and none of them describes a reversal, so there is no faithful
session status to use. The money did not stay, so the session fails and the
attempt carries `reversed` as its status and `REVERSED` as its `raw_status`.

**Mobile-money outcomes are selected by the phone number.** Quid publishes no
magic test values. paybox's shared last-four convention applies instead:
`…0000` succeeds, `…0001` is declined, `…0002` has insufficient funds, `…0006`
times out, `…0008` is rejected by the customer. See
[test-instruments.md](test-instruments.md). The **PIN is not** what decides the
outcome — it proves the payer is present, and the wallet decides whether the
money moves, which is the same split as an OTP on a card.

**`test.payment.*` events fire only for the test simulator.** They are emitted
beside the checkout event when an outcome came from `POST
/test/payment-attempts/{ref}/simulate`, never for an ordinary hosted checkout —
which would otherwise double-fire for every payer.

**A session that fails is terminal.** paybox's canonical payment state machine
makes `failed` terminal, so a failed session cannot be retried on another rail.
Quid finalises a failed session too, but does so per-attempt, so a real
integration may see a retry path this emulator does not offer.

**`Idempotency-Key` is honoured everywhere, including payouts.** paybox's
shared idempotency hook is registered for the whole adapter. Quid documents the
header for checkout and invoice-line writes and says not to use it for payouts;
sending it to a payout endpoint here replays rather than erroring, which Quid
does not promise either way. Use `client_reference`, which is implemented as
documented.

**No mail is sent.** `PUT /receipt-email` records the address and reports
`receipt_email_available: true`; a receipt's `email_status` rests at `pending`
rather than ever claiming `sent`.

**No surcharges.** `GET /checkout/sessions/{reference}/quote` returns an empty
`surcharges` map. paybox charges the payer nothing beyond the session amount,
and an invented per-rail fee table would disagree with the amount actually
collected.

**Receipts and evidence are generated PDFs.** Real one-page PDFs with correct
cross-reference tables, so code that checks the content type or writes the
bytes somewhere works — but with no branding and no layout.

**Everything is test mode.** `environment` is always `test` and `livemode` is
always `false`. An `ak_live_` key is refused outright (spec §29), and a key
that is neither `ak_test_` nor `ak_live_` is refused unless
`PAYBOX_ALLOW_ANY_KEY=1`.

## Safety

No credential here is real, nothing reaches `api.quiddpayments.com`, and the
emulator cannot move money. The merchant API key and webhook signing secret are
generated locally and labelled as such — `paybox status` prints both. Quid's
API key format is published (`ak_test_…`); its webhook signing-secret format is
not, so paybox gives that one an obviously-local shape rather than inventing a
prefix that would read as authoritative.

Card data is impossible by construction: Quid accepts none, so the adapter has
no field that could carry a PAN and no CVV appears anywhere in this package.

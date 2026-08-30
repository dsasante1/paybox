# Paystack compatibility

**Coverage: broad, and honestly bounded.** This document is the authoritative statement of what is
and is not implemented. Where behaviour is modelled rather than verified
against Paystack's documentation, it says so.

Verified on **2026-08-27** against Paystack's **official OpenAPI
specification**, which is the authoritative source used throughout this
adapter:

- <https://github.com/PaystackOSS/openapi> — `dist/paystack.yaml`, blob SHA
  `efa5c8d25611a60f01fd8ce59352fb38b7edfbfb` (repository last pushed
  2026-06-09). Request and response shapes cite their `operationId` in the
  source comments.
- Webhook event names cross-checked against the Paystack AsyncAPI mirror at
  <https://apis.io/asyncapis/paystack/paystack-webhooks-asyncapi/>.

The prose pages at <https://paystack.com/docs> are also used, and were read on
2026-08-27. They reject header-incomplete HTTP clients with a 403 — a request
carrying a full browser header set (`Sec-Fetch-*`, `Accept-Language`) is served
normally. The spec remains the authority for field shapes; the prose is what
documents behaviour the spec types generically.

Re-verify against a current SHA before relying on any of this. Provider APIs
change, and nothing here is generated from a live schema at build time.

---

## Endpoints

| Endpoint | Status | Notes |
|---|---|---|
| `POST /transaction/initialize` | **Compatible** | Returns `authorization_url`, `access_code`, `reference`. The URL points at the emulator's own checkout page. |
| `GET /transaction/verify/:reference` | **Partially compatible** | Full transaction object. See the field table below. |
| `GET /transaction/:id` | **Partially compatible** | Accepts the numeric id, the reference, or a paybox id. |
| `GET /transaction` | **Compatible** | `perPage`, `page`, `status`, `from`, `to`. |
| `GET /transaction/timeline/{id}` | **Compatible** | Built from the real event log. |
| `GET /transaction/totals` | **Partially compatible** | Volume only; no pending-transfer totals. Aggregated in SQL across every row. |
| `GET /transaction/export` | **Partially compatible** | Rows returned inline; see below. Paged to exhaustion. |
| `POST /charge` | **Partially compatible** | `mobile_money`, `card`, `bank`, `ussd`, `eft`. No QR. |
| `POST /dedicated_account` | **Compatible** | One account per customer. |
| `POST /dedicated_account/assign` | **Compatible** | Creates the customer, then assigns. |
| `GET /dedicated_account` | **Partially compatible** | No query filters. |
| `GET /dedicated_account/{id}` | **Compatible** | Accepts the numeric id, a paybox id, or the account number. |
| `GET /dedicated_account/available_providers` | **Partially compatible** | Fixed list of three banks. |
| `GET /charge/{reference}` | **Compatible** | Polls a charge that came back pending. |
| `POST /transaction/charge_authorization` | **Compatible** | Settles inline; the customer is not present. |
| `POST /transaction/partial_debit` | **Partially compatible** | Debits the full requested amount; see below. |
| `POST /charge/submit_otp` | **Compatible** | Completes or fails a parked charge. |
| `POST /charge/submit_pin` | **Partially compatible** | Answers `send_otp`; does not settle. |
| `POST /charge/submit_phone` | **Partially compatible** | Answers `send_otp`. |
| `POST /charge/submit_birthday` | **Partially compatible** | Answers `send_otp`. |
| `POST /customer/authorization/deactivate` | **Compatible** | Irreversible, as at Paystack. |
| `POST /refund` | **Compatible** | Full and partial. Enforces the remaining balance. |
| `GET /refund/:id` | **Compatible** | |
| `POST /refund/retry_with_customer_details/:id` | **Compatible** | 422 unless the refund is `needs-attention`. |
| `POST /customer` | **Compatible** | |
| `GET /customer/:code` | **Compatible** | Accepts `CUS_...` or a paybox id. |
| `GET /customer` | **Compatible** | `perPage`, `page`, `search`. |
| `POST /plan` | **Compatible** | Documented interval enum only. |
| `GET /plan`, `GET /plan/{code}` | **Compatible** | |
| `PUT /plan/{code}` | **Partially compatible** | Amount and interval are not updatable; see below. |
| `POST /subscription` | **Compatible** | Requires a reusable authorization. |
| `GET /subscription`, `GET /subscription/{code}` | **Compatible** | |
| `POST /subscription/disable` | **Compatible** | Email token is checked, not ignored. |
| `POST /subscription/enable` | **Compatible** | Resumes from now. |
| `GET /subscription/{code}/manage/link` | **Partially compatible** | Returns a link; no hosted page behind it. |
| `GET /subscription/{code}/invoices` | **Emulator-only** | Billing history; not a Paystack endpoint. |
| `GET /dispute`, `GET /dispute/{id}` | **Compatible** | |
| `GET /dispute/transaction/{id}` | **Compatible** | |
| `PUT /dispute/{id}/resolve` | **Compatible** | PUT, per the spec. |
| `POST /dispute/{id}/evidence` | **Compatible** | |
| `GET /dispute/{id}/upload_url` | **Partially compatible** | Returns a URL; nothing is stored. |
| `POST /dispute` | **Emulator-only** | Opens a dispute; see below. |
| `POST /subaccount`, `GET /subaccount` | **Compatible** | |
| `GET /subaccount/{code}`, `PUT /subaccount/{code}` | **Compatible** | |
| `POST /split`, `GET /split` | **Compatible** | Percentage and flat. |
| `GET /split/{id}`, `PUT /split/{id}` | **Compatible** | |
| `POST /split/{id}/subaccount/add`\|`remove` | **Compatible** | Re-checks the 100% ceiling. |
| `GET /balance` | **Partially compatible** | Folded from the ledger; see below. |
| `GET /balance/ledger` | **Partially compatible** | `balance` is null on each row. |
| `POST /transferrecipient` | **Partially compatible** | `nuban` shape only; resolves bank names from a fixed list. |
| `GET /bank` | **Partially compatible** | Eight banks, not Paystack's full directory. |
| `GET /country` | **Partially compatible** | Four countries. |
| `POST /transfer` | **Partially compatible** | Created in `pending`. Settle it from the dashboard or CLI. |
| `GET /transfer/:id` | **Partially compatible** | |
| Settlements, bulk transfers, integration | **Not supported** | Settlements: see limitation 1. |
| Payment requests, products, storefronts, orders, pages, terminals, virtual terminals, Apple Pay, direct debit, customer identification, transfer OTP | **Not supported** | Out of scope; not planned. |

## Authentication

`Authorization: Bearer sk_test_local_...`

- Keys starting `sk_live_` / `pk_live_` are **rejected with HTTP 403**. This is
  deliberate and is not configurable. See [SECURITY.md](../SECURITY.md).
- Keys that are neither `sk_test_` nor `sk_live_` are rejected unless
  `PAYBOX_ALLOW_ANY_KEY=1`.
- The emulator generates a key pair on each start and prints it in the banner.
  Nothing validates *which* test key you use — any `sk_test_` value works.

## Payment methods

| Method | Status |
|---|---|
| Mobile money (MTN, Telecel/Vodafone, AirtelTigo) | Implemented, asynchronous |
| Card | Implemented, synthetic test cards only |
| Bank | Implemented, minimal |
| USSD | Implemented, asynchronous |
| EFT | Implemented, asynchronous |
| Bank transfer / dedicated virtual accounts | Implemented; credited from the control API |
| QR / Apple Pay | Not supported |

### Test instruments

The **last four digits** select the outcome. These numbers are synthetic, fail
the Luhn check, and are not issued by any network.

| Instrument | Outcome |
|---|---|
| `4000 0000 0000 0000` | Succeeds |
| `4000 0000 0000 0001` | Declined by issuer |
| `4000 0000 0000 0002` | Insufficient funds |
| `4000 0000 0000 0003` | Expired card |
| `4000 0000 0000 0004` | 3-D Secure step-up, then success |
| `4000 0000 0000 0005` | 3-D Secure step-up, then failure |
| `0550000000` | Mobile money approved |
| `0550000001` | Mobile money declined |
| `0550000002` | Insufficient balance |
| `0550000006` | Prompt never answered → expires |
| `0550000008` | Customer rejects the prompt |

**CVV is never read, never stored, and appears nowhere in the data model.**
A card number is reduced to its BIN and last four before anything is persisted.

### Paystack's own published test cards also work

The numbers above are paybox's synthetic set. Paystack's **published** test
instruments are recognised too, so a number copied straight out of
`/docs/payments/test-payments/` behaves the way that page says it will.

| Paystack instrument | Behaviour here |
|---|---|
| `4084 0840 8408 4081` | Succeeds; reusable authorization |
| `5192 6027 2058 4796` | Succeeds (bank auth simulation) |
| `5078 5078 5078 5078 12` | Parks awaiting a PIN |
| `5060 6666 6666 6666 666` | Parks awaiting PIN `1234`, then OTP `123456` |
| `5078 5078 5078 5078 04` | Parks awaiting PIN `0000`, phone, then OTP |
| `4084 0800 0000 5408` | **Declined** |
| `5078 5078 5078 5078 53` | Fails — token not generated |
| `4084 0800 0067 0037` | Fails — insufficient funds |
| `055 123 498 7` (MTN) | Succeeds |
| `+254 710 000 000` (M-Pesa) | Succeeds |
| `070 000 000 0` (Orange CIV) | Parks awaiting an OTP |

Matching is on the **full number**, so these never collide with the
`4000 0000 0000 000X` suffix convention, and an unrecognised number still falls
through to success as before.

The refund-outcome cards work too: `…1803` charges successfully and then its
refund **fails**, and `…1902` sends the refund to **needs-attention**. Orange
CIV uses its documented OTP `1234`, while the card flows use `123456`.

### Choosing an outcome where there is no instrument

USSD carries only a three-digit bank code from a fixed enum, and EFT only a
provider name — neither has last four digits to encode an outcome into. For
those channels, name the outcome directly:

```json
{ "email": "…", "amount": 40000, "ussd": { "type": "737" },
  "metadata": { "paybox_outcome": "insufficient_funds" } }
```

Accepted values are the outcome names in
`packages/simulator/src/instruments.ts`. **This is emulator-specific and is not
Paystack behaviour.** An unrecognised value is ignored rather than rejected, so
a stray metadata key in your own payload cannot break a charge.

### Dedicated virtual accounts

Account numbers are synthetic, belong to no bank, and are derived from the
customer code so they are stable under a fixed seed. A customer has exactly one
account: asking twice returns the same one.

`preferred_bank` is checked against a **fixed list of three** —
`titan-paystack`, `wema-bank`, `paystack-mfb`. Anything else emits
`dedicatedaccount.assign.failed` and returns an error, which is the failure
path a real integration has to handle. The real list varies by integration and
country.

Nothing in the Paystack API can make money arrive in a DVA — in production
someone makes a bank transfer. The emulator therefore exposes an
**emulator-only control**, outside the provider surface:

```
POST /api/dedicated-accounts/{account_number}/credit  { "amount": 250000 }
```

The credit walks the ordinary state machine, so it appends the same events and
fires the same `charge.success` webhook as any other payment.

## Stored authorizations

A successful charge mints a reusable handle, exactly as Paystack does, and it
comes back on every later `verify` as `authorization.authorization_code`.

| Channel | `reusable` | Why |
|---|---|---|
| Card | `true` | Chargeable off-session via `charge_authorization`. |
| Mobile money | `false` | The payer must approve a prompt on their handset every time. |
| Bank, USSD, other | `false` | No off-session mandate is modelled. |

Charging a non-reusable or deactivated code is **refused**, because it would
also fail in production. That refusal is the point: it is the failure mode a
developer should find locally.

The `authorization_code` is derived from the instrument, not the transaction,
so charging the same test card twice returns **one** authorization rather than
accumulating a new one per payment. The instrument fingerprint includes the
expiry, as a card fingerprint does: Paystack requires `expiry_month` and
`expiry_year` on a card charge, and paybox accepts their absence as a
convenience — but the same number sent once with them and once without is two
fingerprints and mints two authorizations, so send them consistently. Only
masked fragments are ever stored — there is no column that could hold a PAN,
and none for a CVV.

### The PIN/OTP conversation

Paystack's card flow can come back asking for a PIN and then an OTP. The
`4000 0000 0000 0004` and `...0005` test cards park a charge in that state.

| Value | Accepted |
|---|---|
| OTP | `123456` — anything else fails the charge with `authentication_required` |
| PIN | `1234` — anything else fails the charge |

**These are Paystack's own documented test values**, not emulator inventions:
their PIN + OTP test card (`5060 6666 6666 6666 666`) is documented with
`Pin 1234` and `OTP 123456`. An earlier version of this file claimed they were
emulator-specific, which was wrong.

What *is* emulator-specific is that paybox accepts them on **any** card that
parks awaiting a step-up, rather than only on the specific cards Paystack
pairs them with.

`submit_pin`, `submit_phone` and `submit_birthday` answer `send_otp` and leave
the payment parked — only `submit_otp` settles it. `submit_otp` returns the
full transaction object plus `redirect_url`, a superset of the documented
`ChargeSubmitOtpResponse` fields.

`partial_debit` debits the full requested `amount`: the emulator models no
balance behind a card, so it can only enforce the arithmetic in the request
itself (`at_least` above `amount` is rejected). Do not use it to test
partial-collection logic that depends on a real card balance.

## Subscriptions

Recurring billing runs on virtual time. A subscription's `next_payment_date` is
a virtual-time instant, and the scheduler compares it against virtual time, so:

```bash
paybox time advance 365d     # a year of billing, instantly and in order
```

Each cycle's job enqueues the next one — there is no cron. Because the
scheduler runs every job inside `VirtualClock#at`, a renewal's payment is
stamped **at the instant it was due**, not at the time the clock has since
reached. Twelve monthly renewals in one advance produce twelve payments dated
one calendar month apart.

Periods use **calendar arithmetic**, not a fixed 30 days, and the day of month
is clamped rather than rolled over — a subscription starting on the 31st bills
on the 28th in February and stays on the 31st thereafter.

| Behaviour | Detail |
|---|---|
| First charge | Immediate, unless `start_date` is in the future. |
| `invoice.create` | Raised **3 days before** the debit, as Paystack documents. |
| `invoice_limit` | `0` means unlimited. On reaching it the subscription becomes `complete`. |
| Failed renewal | Invoice `failed`, `invoice.payment_failed` fires, subscription moves to `attention` — and **keeps trying**. `attention` is recoverable, not terminal. |
| `disable` / `enable` | The `token` must be the subscription's real `email_token`; a wrong one is rejected. |

The renewal debits the subscription's stored authorization, so the outcome
comes from the instrument behind it: a subscription backed by a card that
requires a step-up fails every renewal, because nobody is present to complete
it. That is the dunning scenario, reproduced locally.

`PUT /plan/{code}` deliberately will **not** change `amount` or `interval`.
Repricing a plan with live subscriptions would silently reprice them.

### Canonical vs Paystack status

| Canonical | Paystack |
|---|---|
| `active` | `active` |
| `non_renewing` | `non-renewing` |
| `attention` | `attention` |
| `completed` | `complete` |
| `cancelled` | `cancelled` |

## Splits and the balance

A transaction carries a split by passing `split_code` (or `subaccount`) to
`/transaction/initialize`, `/charge` or `/transaction/charge_authorization`.
The breakdown appears on the transaction as `fees_split`, and **only once the
transaction has succeeded** — showing shares of a payment that never settled
would misrepresent what was actually divided.

| Split type | Behaviour |
|---|---|
| `percentage` | Each share is rounded **down**, so the parts can never sum to more than the whole. |
| `flat` | Taken as-is, but **capped at the transaction amount**. |

Shares totalling more than 100% are rejected at creation *and* on
`subaccount/add`, so a split cannot be pushed past the ceiling one subaccount
at a time.

### Balance

The balance is a **fold over an append-only ledger**, never a stored number —
the same reasoning as the event log. Movements:

| Event | Direction |
|---|---|
| Payment succeeds | credit |
| Refund settles | debit |
| Transfer created | debit — **amount plus fee**, reserved immediately |
| Transfer fails or is reversed | credit — releases exactly what was reserved |

A transfer is **reserved when it is queued**, not when it settles. Waiting
would let two queued payouts spend the same money; reserving inside the same
transaction as the balance check is what stops that.

**Transfers are refused when the balance cannot cover them** (HTTP 400,
`insufficient_funds`), which is what a provider does. Paystack checks for
"the transfer amount **plus the transfer fee**" and deducts both, so paybox
does too — a check against the amount alone would let through a transfer that
Paystack would refuse for being a few units short. To make that usable, the
emulator starts with an opening test float per currency:

```yaml
balance:
  enforce: true
  opening: 10000000   # PAYBOX_OPENING_BALANCE
  transferFee: {}     # override the published schedule per currency
```

A transfer's `reference` is unique per integration, exactly as a transaction's
is. Reusing one is refused with `duplicate_reference` (HTTP 400) rather than
creating a second payout; omit the field to have one generated.

### Transfer fees

The fee follows Paystack's **published schedule**, taken from their per-country
pricing pages on **2026-08-28**. It is tiered by amount, and in GHS and KES it
also depends on where the money is going — derived from the recipient's `type`,
where only `mobile_money` counts as a wallet.

| Currency | Schedule |
|---|---|
| **NGN** | ≤5,000 → ₦10 · 5,001–50,000 → ₦25 · >50,000 → ₦50 |
| **GHS** | mobile money → GHS 1 · bank → GHS 8 (flat) |
| **ZAR** | ZAR 3 flat — **charged whether the transfer succeeds or fails** |
| **KES** | wallet: ≤1,500 → 20 · ≤20,000 → 40 · above → 60<br>bank: ≤10,000 → 80 · ≤50,000 → 120 · ≤999,999 → 140 · above → 350 |
| anything else | 0 — no schedule, so nothing is guessed |

South Africa is the odd one: because the fee is charged on failure, a failed
ZAR transfer returns the **amount only** and keeps the fee. Everywhere else the
whole reservation comes back.

> ⚠️ **These come from a commercial pricing page, not the API contract.**
> Unlike the pinned OpenAPI spec, those pages carry no version, no changelog
> and no stability guarantee, and your negotiated rates may differ entirely.
> Treat the figures as a plausible default that will go stale, and set
> `balance.transferFee.<CURRENCY>` to pin your own — an override replaces the
> schedule for that currency outright.

The float is **not a ledger row**, so `paybox reset` cannot wipe it and the
ledger stays a pure record of what the run actually did. Set `opening: 0` to
start empty and exercise the insufficient-funds path from the first transfer,
or `enforce: false` to switch the check off entirely.

`GET /balance` reports every currency that has seen movement; on a fresh
emulator that is nothing, so it reports the opening float in NGN rather than an
empty list.

## Disputes

A chargeback originates with the payer's bank, so Paystack has **no endpoint to
open one**. The emulator adds `POST /dispute` because otherwise a dispute could
never come into being locally and the whole flow would be untestable. It is
emulator-only and must not be read as Paystack API surface.

Only a payment that actually collected money can be disputed, and the disputed
amount cannot exceed it.

| Resolution | Effect |
|---|---|
| `merchant-accepted` | Raises and settles a **real refund** for `refund_amount`, so the payment moves to `refunded` / `partially_refunded` and the balance is debited through the ordinary path. |
| `declined` | Closes the dispute; no money moves. `refund_amount: 0` is accepted here. |

The response deadline is a **scheduled job**, not a timer, so "nobody answered
in time" is one `paybox time advance` away:

```bash
paybox time advance 7d     # fires charge.dispute.remind
```

Default window is 7 days with the reminder a day before. A resolved dispute
cancels its own reminder. `resolved` is terminal — a reopened chargeback is a
new dispute, not a revived one.

### Canonical vs Paystack status

| Canonical | Paystack |
|---|---|
| `awaiting_merchant_feedback` | `awaiting-merchant-feedback` |
| `awaiting_bank_feedback` | `awaiting-bank-feedback` |
| `pending` | `pending` |
| `resolved` | `resolved` |

`GET /dispute/{id}/upload_url` returns a URL of the documented shape so an
integration's upload step need not be branched around, but **the emulator
stores no files** and nothing is ever uploaded there.

## The refund lifecycle

Refunds are asynchronous, and paybox settles them rather than leaving them
`pending` forever: a queued refund walks `pending → processing → outcome` over
virtual time, firing each webhook on the way.

| Refund status | Paystack | Transaction becomes |
|---|---|---|
| `pending` | `pending` | unchanged (reversal pending) |
| `processing` | `processing` | unchanged (reversal pending) |
| `needs_attention` | `needs-attention` | unchanged (reversal pending) |
| `failed` | `failed` | **stays `success`** — the money is back with you |
| `successful` | `processed` | `reversed` |

Which outcome a refund takes comes from the instrument behind the payment, so
Paystack's two published refund-outcome cards behave as documented.

### needs-attention

The processor could not find an account to credit. The refund **stops** and
stays stopped however far time advances — it needs bank details:

```
POST /refund/retry_with_customer_details/{id}
{ "refund_account_details": { "currency": "NGN",
                              "account_number": "1234567890",
                              "bank_id": "9" } }
```

The account currency must match the refund's, which Paystack also requires, and
the retry re-resolves the outcome from the instrument — so a card documented as
failing its refund fails the retry too, rather than the retry always
succeeding.

Calling it on a refund that is *not* in `needs-attention` returns **422**, as
Paystack does — their docs say to use it "only when you receive a
`refund.needs-attention` webhook event", and calling it speculatively is a bug
worth surfacing.

## Status mapping

The emulator stores a canonical status and answers with Paystack's.

| Canonical | Paystack | Note |
|---|---|---|
| `created`, `pending` | `pending` | |
| `processing` | `processing` | |
| `requires_action` | `ongoing` | Awaiting a customer action — the momo prompt or an OTP. |
| `authorized` | `processing` | Paystack has no distinct authorized state on a charge. |
| `successful` | `success` | |
| `failed` | `failed` | |
| `cancelled`, `expired` | `abandoned` | |
| `refunded` | `reversed` | |
| `partially_refunded` | `success` | **A partial refund does not change the transaction's status at Paystack.** The refund is a separate object. |

## Webhooks

Signature: **`x-paystack-signature`, HMAC-SHA512 of the raw request body, keyed
with your secret key.** Verified against Paystack's webhook documentation.

Envelope: `{ "event": "<name>", "data": { ... } }`

### Events emitted

| Canonical event | Paystack event |
|---|---|
| `payment.successful` | `charge.success` |
| `refund.created` | `refund.pending` |
| `refund.processing` | `refund.processing` |
| `refund.needs_attention` | `refund.needs-attention` |
| `refund.successful` | `refund.processed` |
| `refund.failed` | `refund.failed` |
| `transfer.successful` | `transfer.success` |
| `transfer.failed` | `transfer.failed` |
| `transfer.reversed` | `transfer.reversed` |
| `dedicated_account.assigned` | `dedicatedaccount.assign.success` |
| `dedicated_account.assign_failed` | `dedicatedaccount.assign.failed` |
| `subscription.created` | `subscription.create` |
| `subscription.non_renewing` | `subscription.not_renew` |
| `subscription.cancelled`, `subscription.completed` | `subscription.disable` |
| `invoice.created` | `invoice.create` |
| `invoice.success` | `invoice.update` |
| `invoice.payment_failed` | `invoice.payment_failed` |
| `dispute.created` | `charge.dispute.create` |
| `dispute.reminder` | `charge.dispute.remind` |
| `dispute.resolved` | `charge.dispute.resolve` |

### Events deliberately **not** emitted

A failed **renewal** is different from a failed charge and does have a
webhook: `invoice.payment_failed`. That is what a dunning flow listens for.

**There is no `charge.failed`.** Paystack's documented event list does not
include one, so neither does the emulator. If your integration is waiting for a
failure webhook, it will wait forever here — and in production. Detect failures
by verifying, not by webhook.

`subscription.expiring_cards` is not emitted: the emulator's synthetic test
cards have no meaningful expiry horizon to warn about.

### Retry behaviour

Paystack's documented schedule is: **test mode** — hourly for 10 hours;
**live mode** — every 3 minutes for the first 4 attempts, then hourly for up to
72 hours. Requests time out after 30 seconds.

The emulator defaults to 5 attempts with exponential backoff. Paystack's real
ladder is available opt-in:

```yaml
webhooks:
  retry:
    schedule: paystack   # PAYBOX_WEBHOOK_SCHEDULE
```

which forces 10 attempts an hour apart, ignoring `maxAttempts` — half a ladder
is neither schedule. It is not the default because ten hours is unhelpful when
you are watching it happen; under a frozen clock it costs nothing, and
`paybox time advance 12h` runs it to exhaustion instantly.

## Response fields

`verify` returns every key the documented response carries. Values differ in
fidelity:

| Field | Fidelity |
|---|---|
| `id`, `reference`, `amount`, `currency`, `status`, `channel`, `gateway_response`, `paid_at`, `created_at` | Accurate |
| `log.history` | **Real** — built from the canonical event timeline |
| `authorization.*` | Synthetic; masked instrument data only |
| `customer.*` | Accurate for customers created through the API |
| `fees` | **Emulated approximation.** A flat percentage per currency, not Paystack's real pricing, which varies by country, channel, card origin and negotiated rate. Do not use for reconciliation testing. |
| `split`, `fees_split` | **Real** when the transaction carries a `split_code` |
| `gateway_response_code` | **Real** for outcomes paybox simulates; `unknown` otherwise |
| `response_code` | ISO 8583, **card channel only**; `null` elsewhere, as Paystack does |
| `ip_address`, `receipt_number`, `fees_breakdown`, `plan`, `subaccount`, `pos_transaction_data`, `source`, `connect`, `order_id` | Always `null` / `{}` |

## Response envelopes: verified against prose, not against the spec

Paystack's OpenAPI specification types **every `/charge` response as a generic
transaction object** — it contains no `pay_offline`, `send_otp`, `open_url` or
`ussd_code` field anywhere. Those envelope strings therefore cannot be checked
against the spec.

They **have** been checked against Paystack's prose documentation
(`/docs/payments/payment-channels/`, read 2026-08-27), which confirms
`pay_offline`, `send_otp`, `send_pin`, `send_phone`, `send_birthday`,
`open_url`, `ussd_code` and `display_text`, and states that a `pay_offline`
response carries `data.ussd_code` for the payer to dial. That is exactly what
this adapter returns.

One difference remains. Paystack's real dial string is session-specific —
`*737*33*4*18791#` — and its `display_text` embeds it verbatim
(*"Please dial \*737\*33\*4\*18791# on your mobile phone to complete the
transaction"*). paybox emits a simplified `*{bank_code}*000#` and a generic
`display_text`. The shape is right; the middle digits are not modelled.

## Known limitations

1. **Settlements are not implemented.** Paystack's OpenAPI specification types
   `GET /settlement` as a generic `Ok` with no response schema at all, so there
   is nothing to emulate faithfully; inventing a shape would be worse than the
   gap.
2. **Charge response envelopes are modelled, not verified** (above): `status`,
   `display_text` and `ussd_code` cannot be checked against the spec.
3. Fees are approximate (above). `fees_split` reports the **split** breakdown,
   not a breakdown of processing fees, and `bearer_type` is stored and echoed
   but does not change who absorbs the emulated fee.
4. `partial_debit` does not model a card balance, so it always debits the full
   requested amount.
5. Dispute attachments are not stored; `upload_url` returns a URL that accepts
   nothing.
6. `GET /transaction/export` returns rows inline under `data.rows` with a
   `total` beside them; the `path` it reports is **not fetchable**, because the
   emulator writes no files. Paged reads stop at 100,000 rows.
7. `GET /transaction/totals` reports volume only; pending-transfer totals are
   always zero.
8. `GET /bank` and `GET /country` return short fixed lists, not Paystack's full
   directories. `GET /dedicated_account` ignores the documented query filters.
9. `gateway_response_code` maps only the failures paybox can actually
   simulate. Paystack's table is ~60 ISO 8583 codes; anything unmapped
   resolves to `unknown`, which is what Paystack documents for unlisted codes.
10. Transfer fees come from Paystack's **commercial pricing pages**, not the
    API contract (above). They will go stale silently. Kenya publishes three
    ladders — M-PESA wallet, M-PESA Paybill/Till, and bank — but a transfer
    recipient's `type` cannot distinguish a wallet from a Paybill/Till, so the
    wallet ladder is used for both. Côte d'Ivoire's page quotes GHS figures,
    which is almost certainly their error; XOF has no schedule here and is
    charged nothing.
12. The USSD dial string's middle segments are ours (above).
13. Transaction ids are derived deterministically from the reference rather than
   allocated by a counter, so they are stable but not monotonic over time. This
   is deliberate: hash-derived ids stay stable when operations are reordered,
   which is what lets the test suite assert literal ids. A monotonic counter
   would be more faithful to Paystack and less useful here.
14. Opening a dispute (`POST /dispute`) and crediting a dedicated virtual
    account (`POST /api/dedicated-accounts/:number/credit`) are
    **emulator-only**. Neither exists at Paystack, because neither originates
    with the merchant — but without them the flows could not be tested locally.

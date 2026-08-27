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

Note that <https://paystack.com/docs> returns HTTP 403 to automated fetches, so
the docs site cannot be machine-verified; the OpenAPI spec above is used
instead. Re-verify against a current SHA before relying on any of this.
Provider APIs change, and nothing here is generated from a live schema at
build time.

---

## Endpoints

| Endpoint | Status | Notes |
|---|---|---|
| `POST /transaction/initialize` | **Compatible** | Returns `authorization_url`, `access_code`, `reference`. The URL points at the emulator's own checkout page. |
| `GET /transaction/verify/:reference` | **Partially compatible** | Full transaction object. See the field table below. |
| `GET /transaction/:id` | **Partially compatible** | Accepts the numeric id, the reference, or a paybox id. |
| `GET /transaction` | **Compatible** | `perPage`, `page`, `status`, `from`, `to`. |
| `GET /transaction/timeline/{id}` | **Compatible** | Built from the real event log. |
| `GET /transaction/totals` | **Partially compatible** | Volume only; no pending-transfer totals. |
| `GET /transaction/export` | **Partially compatible** | Rows returned inline; see below. |
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
accumulating a new one per payment. Only masked fragments are ever stored —
there is no column that could hold a PAN, and none for a CVV.

### The PIN/OTP conversation

Paystack's card flow can come back asking for a PIN and then an OTP. The
`4000 0000 0000 0004` and `...0005` test cards park a charge in that state.

| Value | Accepted |
|---|---|
| OTP | `123456` — anything else fails the charge with `authentication_required` |
| PIN | `1234` — anything else fails the charge |

These fixed values are **emulator-specific**. Paystack has no universal test
OTP; do not read them as provider behaviour.

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
| Transfer created | debit (reserved immediately) |
| Transfer fails or is reversed | credit (reservation released) |

A transfer is **reserved when it is queued**, not when it settles. Waiting
would let two queued payouts spend the same money; reserving inside the same
transaction as the balance check is what stops that.

**Transfers are refused when the balance cannot cover them** (HTTP 400,
`insufficient_funds`), which is what a provider does. To make that usable, the
emulator starts with an opening test float per currency:

```yaml
balance:
  enforce: true
  opening: 10000000   # PAYBOX_OPENING_BALANCE
```

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
| `ip_address`, `receipt_number`, `fees_breakdown`, `plan`, `subaccount`, `pos_transaction_data`, `source`, `connect`, `order_id` | Always `null` / `{}` |

## Response envelopes are modelled, not verified

Paystack's OpenAPI specification types **every `/charge` response as a generic
transaction object**. It contains no `pay_offline`, `send_otp`, `open_url` or
`ussd_code` field anywhere. Those envelope strings — the `status` and
`display_text` a charge returns, and the USSD dial code — are therefore
**modelled from Paystack's prose documentation and cannot be machine-checked**
against the authoritative source. Treat their exact values as approximate; the
state transitions behind them are what this tool is actually asserting.

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
6. `GET /transaction/export` returns rows inline under `data.rows`; the `path`
   it reports is **not fetchable**, because the emulator writes no files.
7. `GET /transaction/totals` reports volume only; pending-transfer totals are
   always zero.
8. `GET /bank` and `GET /country` return short fixed lists, not Paystack's full
   directories. `GET /dedicated_account` ignores the documented query filters.
9. Transaction ids are derived deterministically from the reference rather than
   allocated by a counter, so they are stable but not monotonic over time. This
   is deliberate: hash-derived ids stay stable when operations are reordered,
   which is what lets the test suite assert literal ids. A monotonic counter
   would be more faithful to Paystack and less useful here.
10. Opening a dispute (`POST /dispute`) and crediting a dedicated virtual
    account (`POST /api/dedicated-accounts/:number/credit`) are
    **emulator-only**. Neither exists at Paystack, because neither originates
    with the merchant — but without them the flows could not be tested locally.

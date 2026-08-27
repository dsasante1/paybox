# Paystack compatibility

**Coverage: partial.** This document is the authoritative statement of what is
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
| `GET /transaction` | **Partially compatible** | Supports `perPage`, `page`, `status`. No date filters. |
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
| `GET /customer` | **Partially compatible** | No pagination or search. |
| `POST /transferrecipient` | **Partially compatible** | `nuban` shape only; no bank-name resolution. |
| `POST /transfer` | **Partially compatible** | Created in `pending`. Settle it from the dashboard or CLI. |
| `GET /transfer/:id` | **Partially compatible** | |
| Plans, subscriptions, invoices, split payments, disputes, settlements, bulk transfers, balance, integration | **Not supported** | |

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
| `refund.successful` | `refund.processed` |
| `transfer.successful` | `transfer.success` |
| `transfer.failed` | `transfer.failed` |
| `transfer.reversed` | `transfer.reversed` |
| `dedicated_account.assigned` | `dedicatedaccount.assign.success` |
| `dedicated_account.assign_failed` | `dedicatedaccount.assign.failed` |

### Events deliberately **not** emitted

**There is no `charge.failed`.** Paystack's documented event list does not
include one, so neither does the emulator. If your integration is waiting for a
failure webhook, it will wait forever here — and in production. Detect failures
by verifying, not by webhook.

Subscription and invoice events are not emitted because subscriptions are not
implemented.

### Retry behaviour

Paystack's documented schedule is: **test mode** — hourly for 10 hours;
**live mode** — every 3 minutes for the first 4 attempts, then hourly for up to
72 hours. Requests time out after 30 seconds.

The emulator defaults to 5 attempts with exponential backoff, configurable via
`webhooks.retry.maxAttempts`. It does **not** reproduce Paystack's exact
schedule by default, because a 10-hour ladder is unhelpful interactively — use
`paybox time advance 12h` to run one to exhaustion instantly.

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
| `ip_address`, `receipt_number`, `fees_split`, `fees_breakdown`, `split`, `plan`, `subaccount`, `pos_transaction_data`, `source`, `connect`, `order_id` | Always `null` / `{}` |

## Response envelopes are modelled, not verified

Paystack's OpenAPI specification types **every `/charge` response as a generic
transaction object**. It contains no `pay_offline`, `send_otp`, `open_url` or
`ussd_code` field anywhere. Those envelope strings — the `status` and
`display_text` a charge returns, and the USSD dial code — are therefore
**modelled from Paystack's prose documentation and cannot be machine-checked**
against the authoritative source. Treat their exact values as approximate; the
state transitions behind them are what this tool is actually asserting.

## Known limitations

1. `GET /transaction` has no date-range filtering.
3. Transfers do not model a balance — a transfer never fails for insufficient
   funds unless you make it.
4. Fees are approximate (above).
5. Transaction ids are derived deterministically from the reference rather than
   allocated by a counter, so they are stable but not monotonic over time. This
   is deliberate: hash-derived ids stay stable when operations are reordered,
   which is what lets the test suite assert literal ids. A monotonic counter
   would be more faithful to Paystack and less useful here.
6. `partial_debit` does not model a card balance (above).
7. `GET /dedicated_account` ignores the documented query filters.

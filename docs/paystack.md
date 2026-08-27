# Paystack compatibility

**Coverage: partial.** This document is the authoritative statement of what is
and is not implemented. Where behaviour is modelled rather than verified
against Paystack's documentation, it says so.

Verified against Paystack's public documentation on **2026-08-27**:

- Transaction API reference — <https://paystack.com/docs/api/transaction/>
- Webhooks — <https://paystack.com/docs/payments/webhooks/>

Re-verify before relying on any of this. Provider APIs change; nothing here is
generated from a live schema.

---

## Endpoints

| Endpoint | Status | Notes |
|---|---|---|
| `POST /transaction/initialize` | **Compatible** | Returns `authorization_url`, `access_code`, `reference`. The URL points at the emulator's own checkout page. |
| `GET /transaction/verify/:reference` | **Partially compatible** | Full transaction object. See the field table below. |
| `GET /transaction/:id` | **Partially compatible** | Accepts the numeric id, the reference, or a paybox id. |
| `GET /transaction` | **Partially compatible** | Supports `perPage`, `page`, `status`. No date filters. |
| `POST /charge` | **Partially compatible** | `mobile_money`, `card`, `bank`. No USSD, QR, EFT or bank_transfer. |
| `POST /refund` | **Compatible** | Full and partial. Enforces the remaining balance. |
| `GET /refund/:id` | **Compatible** | |
| `POST /customer` | **Compatible** | |
| `GET /customer/:code` | **Compatible** | Accepts `CUS_...` or a paybox id. |
| `GET /customer` | **Partially compatible** | No pagination or search. |
| `POST /transferrecipient` | **Partially compatible** | `nuban` shape only; no bank-name resolution. |
| `POST /transfer` | **Partially compatible** | Created in `pending`. Settle it from the dashboard or CLI. |
| `GET /transfer/:id` | **Partially compatible** | |
| `POST /charge/submit_otp` | **Not supported** | |
| `POST /transaction/charge_authorization` | **Not supported** | No stored-authorization reuse. |
| Plans, subscriptions, invoices, split payments, disputes, settlements, bulk transfers, balance, integration, dedicated virtual accounts | **Not supported** | |

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
| USSD | Not supported |
| Bank transfer / virtual accounts | Not supported |
| QR / EFT / Apple Pay | Not supported |

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

## Known limitations

1. No stored-authorization reuse (`charge_authorization`), so recurring card
   flows cannot be tested.
2. No USSD or bank-transfer/virtual-account channels.
3. `GET /transaction` has no date-range filtering.
4. Transfers do not model a balance — a transfer never fails for insufficient
   funds unless you make it.
5. Fees are approximate (above).
6. Transaction ids are derived deterministically from the reference rather than
   allocated by a counter, so they are stable but not monotonic over time.

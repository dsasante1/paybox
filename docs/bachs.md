# Bachs coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Bachs publishes its API as an **OpenAPI document**
(`docs.bachs.io/docs/openapi/openapi.json`, sha256
`9c2265585c2bade2b5b9de48f1c258973e4b35470d244a039b54a500e9334810`) and its
webhook payloads as **event pages** under `docs.bachs.io/guides/webhooks/events/`.
Both were read **2026-10-10**, along with the guides they link to. The two
sources disagree often (see [Contradictions](#contradictions-in-bachs-documentation)),
so paybox follows one rule throughout:

- **The OpenAPI document wins for REST shapes**: request and response bodies,
  status codes, enums.
- **The event pages win for webhook payloads**, because the OpenAPI document
  has no `webhooks` section at all.

Base path: `/bachs`. Bachs' own paths begin `/v1/`, so set your client's base
URL to `http://localhost:8080/bachs` and every path works unchanged.

This is the first phase of Bachs: **collection**. That covers checkout
sessions, the hosted page, payments, products, customers, refunds, balances
and the webhook-endpoint API. [Not implemented](#not-implemented) lists
what comes later.

## Endpoints

### Checkout sessions and payments

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/checkout-sessions` | **Partially compatible** | Cart or raw `pricing`; fixed, free and pay-what-you-want. No subscriptions, saved cards or Connect splits (`501`). Corridors that would need live FX are not offered. |
| `GET /v1/checkout-sessions/{checkout_id}` | **Compatible** | `charge` is `null` until the payer starts paying. |
| `GET /v1/payments` | **Compatible** | `status_filter`; default page 50 (the spec's; the pagination guide says 20). |
| `GET /v1/payments/{payment_id}` | **Compatible** | `PaymentResponse`. |
| `GET /v1/payments/charges/{charge_id}` | **Compatible** | `ChargeStatusResponse`: same id, a different shape, as published. |

### Products and customers

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/products` | **Partially compatible** | No media. |
| `GET /v1/products` | **Compatible** | Newest first; `include_archived`. |
| `GET /v1/products/{product_id}` | **Compatible** | |
| `PATCH /v1/products/{product_id}` | **Partially compatible** | `media` is accepted and ignored. |
| `POST /v1/products/{product_id}/archive` | **Compatible** | Idempotent. |
| `POST /v1/products/{product_id}/unarchive` | **Compatible** | Idempotent. |
| `POST /v1/customers` | **Compatible** | An existing email is an upsert that fires `customer.updated`. |
| `GET /v1/customers` | **Compatible** | `search` on email or name; default page 50. |
| `GET /v1/customers/{customer_id}` | **Compatible** | |
| `PATCH /v1/customers/{customer_id}` | **Compatible** | `billing_address` replaces, never merges. |

### Refunds and balances

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/refunds` | **Partially compatible** | One live refund per charge; `simulated_outcome`. An underpaid charge cannot be refunded. |
| `GET /v1/refunds` | **Compatible** | `{ total, items }`, as the spec has it. |
| `GET /v1/refunds/{refund_id}` | **Compatible** | |
| `GET /v1/refunds/by-charge/{payment_id}` | **Compatible** | The live refund, else the latest. |
| `GET /v1/balances` | **Partially compatible** | One balance per collected currency; see [differences](#differences-from-bachs). |

### Webhook endpoints and events

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/webhooks/endpoints` | **Compatible** | Returns `signing_secret` once. |
| `GET /v1/webhooks/endpoints` | **Compatible** | |
| `GET /v1/webhooks/endpoints/{endpoint_id}` | **Compatible** | |
| `PATCH /v1/webhooks/endpoints/{endpoint_id}` | **Compatible** | `enabled: true` clears `disabled_at`. |
| `DELETE /v1/webhooks/endpoints/{endpoint_id}` | **Compatible** | `{ "status": "deleted", ... }`. |
| `GET /v1/webhooks/endpoints/{endpoint_id}/secret` | **Compatible** | |
| `POST /v1/webhooks/endpoints/{endpoint_id}/rotate-secret` | **Compatible** | 24-hour overlap; see [contradictions](#contradictions-in-bachs-documentation). |
| `GET /v1/webhooks/endpoints/{endpoint_id}/metrics` | **Compatible** | `day`, `week`, `month`; zero-filled. |
| `GET /v1/webhooks/endpoints/{endpoint_id}/events` | **Compatible** | |
| `GET /v1/webhooks/endpoints/{endpoint_id}/events/{event_id}` | **Compatible** | |
| `POST /v1/webhooks/endpoints/{endpoint_id}/events/{event_id}/resend` | **Compatible** | A single try. |
| `GET /v1/webhooks/events` | **Compatible** | Every event, delivered or not. |
| `GET /v1/webhooks/events/{event_id}` | **Compatible** | The exact payload sent, and every attempt. |
| `POST /v1/webhooks/replay` | **Compatible** | By `event_id`, `charge_id` or `reference`; a single try. |

### Emulator-only

Bachs hosts its checkout at `checkout.bachs.io`. paybox serves its own at
`/bachs/c/{token}`, and `checkout_url` points there. These routes belong to that
page and are **not Bachs API**:

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /c/{token}` | **Emulator-only** | The hosted page. |
| `POST /c/{token}/identify` | **Emulator-only** | A guest gives an email and name. |
| `POST /c/{token}/amount` | **Emulator-only** | A pay-what-you-want amount. |
| `POST /c/{token}/complete` | **Emulator-only** | Completes a free checkout. |
| `POST /c/{token}/pay` | **Emulator-only** | Starts an attempt on one corridor. |
| `POST /c/{token}/simulate` | **Emulator-only** | paybox's test controls. |

## How a checkout behaves

Bachs is checkout-first. A merchant creates a session, sends the payer to
`checkout_url`, and learns the outcome from a webhook. There is no
documented server-to-server way to charge mobile money or a bank transfer.
(`ui_mode: custom` is mentioned in three guides but is absent from the
request schema, and no pay or confirm operation exists.) paybox emulates the
documented path only.

- **The charge appears when the payer starts paying.** Bachs: "The `charge`
  field is `null` while the session is `OPEN` and populated once the customer
  submits a payment" (getCheckoutSession). paybox creates the charge (`ch_…`) on
  the first attempt, so an unattempted session has none, and `GET
  /v1/payments` does not list it.
- **`payment_id` and `charge_id` are the same id** on every surface.
- **A failed attempt leaves the checkout open.** The payer can try another card
  or another method on the same charge. `collection.failed` fires **once per
  payment, for the first failure** (collection.failed), not once per
  attempt.
- **Expiry closes the checkout whatever state it is in.**
  - A session nobody tried to pay sends `checkout.expired` only.
  - A session whose charge never succeeded sends `collection.failed` with status
    `EXPIRED`, then `checkout.expired`. If that charge already reported a
    failure, `collection.failed` is not sent again.
  - `checkout.expired` always carries `charge: null`, because the event page
    says "An expired checkout has no charge".
  - **Money already on its way is not stopped.** A payment that is
    `processing` at expiry gets **one minute of grace** to finish, because
    "A payment that was already on its way can still complete". If it has not
    settled by then, or failed meanwhile, the checkout closes. That covers a card in its
    one-second settle window and a confirmed transfer. An *underpaid* charge
    is money held short, and it closes with the checkout.
- **Expiry is not always final.** A bank transfer that lands after expiry
  still completes the checkout, so `checkout.completed` follows
  `checkout.expired`. Use the hosted page's "Transfer arrives late" control on
  an expired bank-transfer checkout.
- **A free checkout creates no charge** and sends only `checkout.completed`,
  with `payment_status: "no_payment_required"` and `amount: "0"`.
- **A paid checkout sends `collection.succeeded` and `checkout.completed`.**
  Bachs says either can arrive first. paybox always sends `collection.succeeded`
  first, but your handler should not depend on that.
- **`success_url` must be public.** "`localhost` and private network addresses
  are refused, in the sandbox too." paybox refuses them as well (`400
  VALIDATION_ERROR`), because an integration that passes one fails against
  the real sandbox. `?checkout_id=` is appended on redirect.
- **`reference` is unique for good**, including references used on checkouts
  that later expired. A repeat is `409 CONFLICT`, even when two requests race
  for it.
- **`cancel_url` must be an `http` or `https` URL**, because the payer is shown
  it as a link. Unlike `success_url`, it may be a private address.
- **Customers.** `customer: { email }` creates or matches a customer.
  Matching is by the exact email string, because Bachs does not say whether
  it folds case.
  `customer_creation` decides whether a guest identified on the hosted page
  joins the directory: `if_required`, the default, keeps them on
  `customer_details` only and fires no `customer.*` event.

### Test instruments

Card numbers are Bachs' own sandbox numbers (integrate/sandbox):

| Card | Result |
| --- | --- |
| `4000000000000002` | Declined |
| `4000000000009995` | Insufficient funds |
| `4000000000000069` | Expired card |
| `4000000000000119` | Processing error |
| any other | Succeeds about a second later ("finalizes on its own") |

Every successful payment, whether a card or an approved test control, is
`processing` until **one second of virtual time** passes. Run `paybox time
advance 1s` to settle it.

Bachs says to "use the test controls on the sandbox checkout page to make the
payment succeed, fail, or arrive underpaid" for every other rail, and never
describes those controls. The controls below are **paybox's**, and the page
labels them that way:

| Rail | Controls |
| --- | --- |
| NGN bank transfer | Transfer received · Transfer arrives short · Transfer fails · Transfer arrives late (after expiry) |
| Mobile money | Payer approves · Payer declines |
| Crypto | Payment arrives · Arrives underpaid · Arrives overpaid · Payment fails |
| Underpaid crypto, or a short transfer | Payer sends the rest · Merchant accepts the underpayment |

An underpaid crypto charge sends `collection.underpaid`. A short bank transfer
does not: Bachs says "A bank transfer that arrives short does not send this
event", and the checkout stays open.

Refunds take Bachs' own `simulated_outcome` (`success`, the default, or
`failed`) and settle one second after they are created.

## Webhooks

Every delivery carries the three documented headers:

- `X-Bachs-Timestamp`: Unix seconds.
- `X-Bachs-Signature`: the hex HMAC-SHA256 of `"{timestamp}.{raw_body}"`.
- `X-Bachs-Signature-V2`: `t=…,v1=…`.

The HMAC key is the signing secret's own UTF-8 bytes, `whsec_` prefix
included, as in Bachs' samples. Each attempt is signed at its own virtual
instant, so a retry an hour later passes a 300-second tolerance check.

| Behaviour | What paybox does |
| --- | --- |
| Retries | 5 tries: once, then about +1m, +5m, +15m and +1h after each failure. |
| Timeout, connection failure, `5xx`, `408`, `429` | Retried. |
| Any other `4xx`, or a `3xx` | **Not retried.** The delivery is recorded as `failed`; Bachs treats it as a refusal and does not follow redirects. |
| Resend and replay | A single try; the event keeps its original `id`. |
| A disabled endpoint | Receives nothing, "not even retries that were already queued". |
| A changed URL | Queued retries go to the new URL. |
| 72 hours of unbroken failure | The endpoint is turned off: `enabled: false`, `disabled_reason: "consecutive_failures"`, at least 48 hours after a warning at 24 hours. paybox sends no email, so the warning is only recorded. |
| Rotation | The old secret keeps signing for 24 hours. V2 carries a `v1=` for each valid secret, newest first, and `X-Bachs-Signature` uses the new one. |
| `event_source: "connect"` | Receives nothing: paybox has no connected accounts yet. |

Events emitted: `checkout.completed`, `checkout.expired`, `collection.succeeded`,
`collection.failed`, `collection.underpaid`, `customer.created`,
`customer.updated`, `refund.created`, `refund.paid` and `refund.failed`.

Refunds made with paybox's own tools (`paybox refund`, the dashboard) on a
Bachs charge are Bachs refunds too. They appear in `/v1/refunds`, count
against the one-refund rule and send `refund.*` webhooks. A refund that had
no Bachs `reference` uses its paybox id as one.

Every Bachs event is built once, when it happens, and stored. That is what lets
`GET /v1/webhooks/events/{id}` return "the exact JSON body sent to your
endpoint, byte for byte", and what keeps an event's `id` stable across resends.

Bachs reports one payment in several vocabularies, and paybox keeps each one
rather than reconciling them:

| Where | Field | Values |
| --- | --- | --- |
| Payment object | `status` | `created`, `processing`, `succeeded`, `accepted`, `failed`, `expired`, `cancelled`, `refunded`, `partially_refunded`, `underpaid`, `overpaid` |
| Checkout | `status` | `open`, `completed`, `expired`, `cancelled` |
| Checkout | `payment_status` | `requires_payment_method`, `requires_action`, `processing`, `succeeded`, `failed`, `canceled` (one L, as published) |
| Webhooks | `data.status` | the payment status, **uppercase** (`SUCCEEDED`) |
| Refund object | `status` | `processing`, `success`, `failed` |
| Refund webhooks | `data.status` | `processing`, `paid`, `failed` |

The refund webhooks also say `fee_bearer: "merchant"` where the refund object
says `"org"`. Both are as published.

## Request conventions

- **Money is a decimal string**: `"29.00"`, never a number and never minor
  units. Up to two decimal places are accepted, and none for a zero-decimal
  currency (XAF, XOF). Anything finer is refused (`400 VALIDATION_ERROR`),
  never rounded. Every amount is returned with two places, including
  `"5000.00"` XAF.
- **Errors are flat**: `{ detail, error_code, doc_url }`, plus `errors[]` on
  validation failures, e.g. `{ "field": "name", "message": "Field required",
  "type": "missing" }`. Every `error_code` is one from Bachs' error reference,
  at the status it lists.
- **Lists** return `{ items, pagination }` with `cur_<offset>` cursors. A limit
  above 100 is clamped, and a malformed cursor is `400 BAD_REQUEST`. Refunds
  return `{ total, items }`, and webhook event lists return `{ items, total,
  limit, offset }`, because the spec gives them those shapes.
- **`Idempotency-Key`** covers `POST` and `PATCH` under `/v1/`, never `GET` or
  `DELETE`.
  - Only a `2xx` response is cached, for 24 hours of virtual time; a hit does
    not extend that.
  - The same key with a different body is `409 IDEMPOTENCY_CONFLICT`.
  - A retry while the first request is still running is `409
    IDEMPOTENCY_IN_PROGRESS`.
  - `POST /v1/refunds` also honours its own body field, `idempotency_key`.
- **`x-request-id`** is on every response, and **`X-RateLimit-*`** headers
  report the sandbox budget of 100 requests a minute.

## Differences from Bachs

Each of these exists because a paybox invariant makes the faithful version
impossible, not to save work.

- **Rate limiting is reported, not enforced.** The headers count against 100
  requests per virtual minute. Under a frozen clock that minute never rolls
  over, so refusing requests would lock a test suite out for good after its
  hundredth. To exercise Bachs' `429 TOO_MANY_REQUESTS`, use paybox's network
  simulation, which answers in Bachs' envelope.
- **No currency conversion.**
  - Bachs converts: a USD price can be paid in NGN at a live rate, and every
    collection settles into a USD or NGN balance. paybox never converts, and a
    live rate would break determinism.
  - So a checkout offers only the corridors that can charge one of its
    currencies, meaning the base currency or one given in `currency_options`.
    Crypto is offered on USD checkouts.
  - Balances are folded per collected currency, so a GHS mobile-money
    collection shows as a GHS balance, and `total_balance_usd` counts USD
    balances alone.
  - `fee_usd` is set only on USD payments.
- **An underpaid charge cannot be refunded.** Bachs allows it. paybox's engine
  refunds only payments it has collected in full, so this answers `501
  NOT_IMPLEMENTED`, and `is_refundable` reads `false` on such a charge so the
  flag does not promise a refund the API refuses.
- **An accepted or overpaid charge counts what arrived.** Settlement credits
  the requested amount, so paybox then debits an accepted shortfall, or
  credits an overpaid excess, from the balance. An accepted underpayment
  refunds at most what was paid. An overpaid charge is not refundable,
  because the refunds guide lists only `succeeded`, `accepted` and
  `underpaid`.
- **API keys hold every scope.** Bachs keys carry scopes chosen in its
  dashboard, and a missing scope is `403 FORBIDDEN`. paybox has no dashboard to
  choose them in, so it never returns that `403`.
- **Webhook endpoints may be local.** Bachs requires a public HTTPS URL and
  forwards to `localhost` through its CLI. Delivering to your local app is
  what paybox is for, so any `http` or `https` URL is accepted.
- **Every card is domestic.** Bachs adds 1.5% to an international USD card. A
  test card number carries no country, so that surcharge never applies.

## Contradictions in Bachs' documentation

Recorded so a difference between paybox and a Bachs page can be traced to its
cause. Where a choice was needed, the rule at the top of this file decided it.

| Topic | One source says | Another says | paybox |
| --- | --- | --- | --- |
| Payment status | Statuses guide: `open`/`incomplete` plus `substatus` | Spec: 12 values, no substatus | Spec |
| Refund id | `RefundResponse` example: a UUID | Property example `rfnd_…`; webhooks and `PaymentResponse.refunds`: `ref_…` | UUID |
| Refund status | REST: `success` | `refund.paid` page: `paid` | Each on its own surface |
| `fee_bearer` | REST: `org`/`customer` | Refund events: `merchant`/`customer` | Each on its own surface |
| Secret rotation | Guide: old secret valid 24h, both sign | rotate-secret operation: "stops working immediately" | 24-hour overlap |
| List envelope | Guide: every list is `{ items, pagination }` | Spec: refunds `{ total, items }`; events `{ items, total, limit, offset }` | Spec |
| `GET /v1/payments` default limit | Spec: 50 | Pagination guide: 20 | 50 |
| Card `payment_method` | Guides: `CARD` | 2026-09-21 changelog: `USD_CARD`/`NGN_CARD` | `CARD` on the checkout and `USD_CARD`/`NGN_CARD` on the payment, as each field's description says |
| `VALIDATION_ERROR` status | Error reference: `400` | Webhook-endpoint spec: `422` | `400` |
| Bank-transfer refunds | Refunds guide table: not refundable | Same page lists a bank-transfer timing; underpaid page says refundable | Not refundable |
| `IDEMPOTENCY_CONFLICT` | Idempotency guide | Missing from the error reference | Returned, with no `doc_url` |
| Subscribable events | Events overview lists `payment_method.saved` | `event_types` enum omits it | Enum |

## Not implemented

These are later phases of Bachs. They are not shortcuts.

- **Subscriptions**, invoices and the customer portal. A recurring product in
  a cart is `501`.
- **Saved cards**: `save_payment_method`, `POST /v1/charges`,
  `payment_method.saved`.
- **Payouts**: destinations, quotes, schedules.
- **Conversions**, **transfers**, **virtual accounts** and **disputes**.
- **Connect**: accounts, persons, capabilities, platform fees, `X-Account-Id`.
- Product groups, uploads and media, reference data, payment-method and
  currency listings, and checkout settings.

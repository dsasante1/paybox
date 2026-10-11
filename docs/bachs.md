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

Four of Bachs' phases are here, and the first part of a fifth.

- **Collection**: checkout sessions, the hosted page, payments, products,
  customers, refunds, balances and the webhook-endpoint API.
- **Billing**: subscriptions, saved cards, off-session charges, product groups
  and the customer portal.
- **Money out**: payouts, payout destinations, quotes and schedules,
  conversions, the virtual account, and balances held in USD and NGN.
- **Disputes**: disputes, evidence and submission, file uploads and product
  media.
- **Connect, part one**: connected accounts, persons, documents,
  capabilities, requirements, onboarding links, and `X-Account-Id`, which
  runs any request as a connected account and keeps everything it creates its
  own.

[Not implemented](#not-implemented) lists what comes later.

## Endpoints

### Checkout sessions and payments

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/checkout-sessions` | **Partially compatible** | Cart or raw `pricing`; fixed, free and pay-what-you-want; a recurring product starts a subscription; `save_payment_method` with or without a price. No Connect splits (`501`). Corridors that would need live FX are not offered. |
| `GET /v1/checkout-sessions/{checkout_id}` | **Compatible** | `charge` is `null` until the payer starts paying. |
| `GET /v1/payments` | **Compatible** | `status_filter`; default page 50 (the spec's; the pagination guide says 20). |
| `GET /v1/payments/{payment_id}` | **Compatible** | `PaymentResponse`. |
| `GET /v1/payments/charges/{charge_id}` | **Compatible** | `ChargeStatusResponse`: same id, a different shape, as published. |
| `POST /v1/charges` | **Partially compatible** | A saved card, off-session: `201` with `processing`, settled a second later, or already `failed`. The processing fee is always absorbed; the customer-pays account setting is not modelled yet. |

### Subscriptions, product groups and the portal

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /v1/subscriptions` | **Compatible** | Newest first; `customer_id`, `status`; default page 50. |
| `GET /v1/subscriptions/{subscription_id}` | **Compatible** | `SubscriptionResponse`. |
| `PATCH /v1/subscriptions/{subscription_id}` | **Compatible** | Exactly one intent: `product_id` (with `proration_behavior`), `trial_end`, `payment_method_id` or `metadata`. |
| `DELETE /v1/subscriptions/{subscription_id}` | **Compatible** | Immediately, or `cancel_at_period_end`. |
| `POST /v1/customers/{customer_id}/portal-sessions` | **Compatible** | `200` with `id` and `url`; the link lives one virtual hour. |
| `POST /v1/product-groups` | **Compatible** | |
| `GET /v1/product-groups` | **Compatible** | Default page 20. |
| `GET /v1/product-groups/{group_id}` | **Compatible** | `include_archived`. |
| `PATCH /v1/product-groups/{group_id}` | **Compatible** | `product_ids` replaces the list and its order. |
| `DELETE /v1/product-groups/{group_id}` | **Compatible** | `204`; member products are unaffected. |

### Products and customers

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/products` | **Compatible** | `media` is not on the create request; set it with `PATCH`. |
| `GET /v1/products` | **Compatible** | Newest first; `include_archived`. |
| `GET /v1/products/{product_id}` | **Compatible** | |
| `PATCH /v1/products/{product_id}` | **Compatible** | `media`: up to five upload ids, in order, replacing the list. |
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
| `GET /v1/balances` | **Partially compatible** | USD and NGN, as Bachs holds them; other currencies settle into USD at fixed rates. Nothing is ever pending. |

### Money out

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/payouts/destinations` | **Compatible** | Bank, mobile money or crypto wallet; approved at once, as in the sandbox. |
| `GET /v1/payouts/destinations` | **Compatible** | `{ destinations, total, limit, offset }`; default page 20. |
| `GET /v1/payouts/destinations/{destination_id}` | **Compatible** | |
| `PATCH /v1/payouts/destinations/{destination_id}` | **Compatible** | `name`, `is_default`, or the routing restated. |
| `DELETE /v1/payouts/destinations/{destination_id}` | **Compatible** | Deactivates: `{ id, deleted: true }`. |
| `POST /v1/payouts/quotes` | **Compatible** | Cross-currency only; 30 seconds; single use. |
| `POST /v1/payouts` | **Partially compatible** | `200`. No first-payout review hold and no withdrawal limits. |
| `GET /v1/payouts` | **Compatible** | `{ total, items }`; `status_filter`; default page 50. |
| `GET /v1/payouts/{withdrawal_id}` | **Compatible** | |
| `GET /v1/payouts/mobile-money-providers` | **Partially compatible** | Not in the pinned spec; shape from the payouts guide. |
| `GET /v1/balance_settings` | **Compatible** | Payout schedules, per currency. |
| `POST /v1/balance_settings` | **Compatible** | A named currency is replaced in full; others are kept. |
| `POST /v1/conversions/quotes` | **Compatible** | USD <-> NGN; 30 seconds; single use. |
| `POST /v1/conversions` | **Compatible** | Completes at once. |
| `GET /v1/conversions` | **Compatible** | `{ total, limit, offset, items }`; default page 50. |
| `GET /v1/conversions/{conversion_id}` | **Compatible** | |
| `POST /v1/virtual-accounts` | **Compatible** | NGN only; `200`, and the same account again on a repeat. |
| `GET /v1/virtual-accounts` | **Compatible** | `?currency=NGN`. |
| `GET /v1/currencies/payout-supported` | **Compatible** | |
| `GET /v1/reference/banks` | **Partially compatible** | A representative list of banks, with Bachs' sandbox test codes. |
| `GET /v1/reference/momo` | **Partially compatible** | Not in the pinned spec; same shape as the payouts guide's list. |
| `POST /v1/misc/bank-accounts/resolve` | **Partially compatible** | Names are synthetic; a failed lookup is `200` with `resolved: false`. |

Transfers are not here. They move money only between a platform and its
connected accounts, so they arrive with Connect.

### Disputes and uploads

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /v1/disputes` | **Compatible** | `{ total, items }`, newest first; `status`, `from_date`, `to_date`; default page 50. |
| `GET /v1/disputes/{dispute_id}` | **Compatible** | With the evidence draft and `latest_submission`. |
| `PATCH /v1/disputes/{dispute_id}/evidence` | **Compatible** | Partial; `null` clears a field. `409 DISPUTE_NOT_EDITABLE`, `410 DEADLINE_PASSED`. |
| `POST /v1/disputes/{dispute_id}/submit` | **Compatible** | Locks the evidence; `under_review`. |
| `POST /v1/disputes/uploads` | **Compatible** | `multipart/form-data`; PDF, JPEG, PNG or GIF by content, up to 10 MB. |
| `POST /v1/utilities/uploads` | **Compatible** | `multipart/form-data` with `file` and `scope`; up to 20 MB; `201`. |
| `GET /v1/utilities/uploads/{upload_id}` | **Compatible** | `url` is served by paybox; `null` for a dispute document. |
| `DELETE /v1/utilities/uploads/{upload_id}` | **Compatible** | `409` once the upload is attached to something. |

### Connect: accounts

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/accounts` | **Compatible** | `201`; requested capabilities are granted at once, as in the sandbox. |
| `GET /v1/accounts` | **Compatible** | `{ items, total, limit, offset }`, newest first; default page 20. |
| `GET /v1/accounts/me` | **Compatible** | The platform, or the account acted as. |
| `GET /v1/accounts/{account_id}` | **Compatible** | `include=requirements.values`. |
| `POST /v1/accounts/{account_id}` | **Partially compatible** | Requirements follow paybox's own catalogue, because Bachs publishes none. See [Requirements](#requirements). |
| `GET /v1/accounts/{account_id}/capabilities` | **Compatible** | Every applicable capability, `unrequested` included. |
| `POST /v1/accounts/{account_id}/account-links` | **Compatible** | `200`; single use; expires in 30 days. |
| `POST /v1/accounts/{account_id}/documents` | **Compatible** | `201`; a certificate of incorporation goes to review. |
| `GET /v1/accounts/{account_id}/persons` | **Compatible** | Oldest first; default page 50; a limit outside 1–100 is `422`. |
| `POST /v1/accounts/{account_id}/persons` | **Compatible** | `201`. |
| `GET /v1/accounts/{account_id}/persons/{person_id}` | **Compatible** | |
| `POST /v1/accounts/{account_id}/persons/{person_id}` | **Compatible** | Omitted keys kept; `null` clears. |
| `DELETE /v1/accounts/{account_id}/persons/{person_id}` | **Compatible** | `204`; the representative cannot be removed. |
| `POST /v1/accounts/{account_id}/persons/{person_id}/documents` | **Compatible** | `201`; a primary ID puts the person in review. |
| `GET /v1/reference/business-structures` | **Partially compatible** | Nigeria's three, the only ones published. |
| `GET /v1/reference/product-categories` | **Partially compatible** | The two published categories. |

Split payments, platform fees and transfers come with the next part of
Connect; checkout settings and the payment-method listings after that.

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

Bachs hosts its customer portal at `portal.bachs.io/s/{token}`; paybox's is at
`/bachs/portal/s/{token}`, and a portal session's `url` points there.

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /portal/s/{token}` | **Emulator-only** | Subscriptions, invoice history and saved cards. |
| `POST /portal/s/{token}/subscriptions/{subscription_id}/cancel` | **Emulator-only** | Cancels at the end of the period. |
| `POST /portal/s/{token}/subscriptions/{subscription_id}/resume` | **Emulator-only** | Undoes a scheduled cancellation. |
| `POST /portal/s/{token}/subscriptions/{subscription_id}/pay` | **Emulator-only** | A recovery payment for a `past_due` or `unpaid` subscription. |

Bachs says of its virtual accounts that "there is no way to simulate a deposit
into it today". paybox has one, and it is paybox's test control, **not Bachs
API**:

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/virtual-accounts/{virtual_account_id}/deposits` | **Emulator-only** | A bank transfer into the account: `{ amount, sender_name?, sender_bank?, sender_account_number?, narration? }`. |

A chargeback is filed by the payer's bank and ruled on by the card network,
and Bachs documents no sandbox trigger for either (its CLI's `trigger` list
has no dispute event). These two are paybox's test controls, **not Bachs
API**:

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/disputes` | **Emulator-only** | Opens a dispute: `{ charge_id, amount?, reason?, response_deadline_at?, warning? }`. `201`, or `200` when it escalates an open warning. |
| `POST /v1/disputes/{dispute_id}/network` | **Emulator-only** | The network's side: `{ status?: "won" \| "lost" \| "closed", response_deadline_at? }`. A deadline only moves earlier. |

An upload's `url` points at paybox, which serves the bytes there; Bachs serves
its own from `cdn.bachs.io`.

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /files/{upload_id}/{file_name}` | **Emulator-only** | A public upload's bytes. A dispute document is never served. |

Bachs hosts onboarding at `connect.bachs.io` and never describes the page.
Its sandbox also reviews nothing ("Sandbox grants do not exercise the
complete live requirements and review flow"). The page an account link opens,
and the reviewer's decisions, are paybox's own, **not Bachs API**:

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /connect/setup/c/{account_id}/{token}` | **Emulator-only** | The onboarding page: a form for what is currently due. |
| `POST /connect/setup/c/{account_id}/{token}` | **Emulator-only** | Submits it, then redirects to `return_url`. |
| `POST /v1/accounts/{account_id}/requirements/review` | **Emulator-only** | A reviewer's decision: `{ field, outcome: "accept" \| "reject", code?, reason? }`. |
| `POST /v1/accounts/{account_id}/capabilities/{capability}` | **Emulator-only** | An administrator enabling or restricting a capability: `{ status: "active" \| "restricted" }`. |

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
| `4000000000000341` | Succeeds, is saved, and declines every later off-session charge |
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

## How billing behaves

Sources: guides/subscriptions/{overview, manage, failed-payments, trials,
proration}, guides/payments/charge-a-saved-card,
guides/customer-portal/*, build/use-cases/saas-subscriptions, read
2026-10-10.

### Subscriptions

There is no create endpoint. A checkout whose cart holds one recurring
product becomes a subscription checkout, and Bachs' rules apply:

- It needs a `customer`.
- It sells exactly one recurring catalog product
  (`SUBSCRIPTION_REQUIRES_CATALOG_PRODUCT`).
- It is priced in USD. NGN is `403 NGN_SUBSCRIPTIONS_NOT_ENABLED`, and any
  other currency is `422 BASE_CURRENCY_NOT_HELD_BY_ORG`.
- It is paid by USD card only (`SUBSCRIPTION_METHOD_NOT_SUPPORTED`).

When it completes, the card is saved, the first cycle is billed by the
checkout's own charge, and the subscription starts. The checkout's `metadata`
is copied onto the subscription with the system key `checkout_id`.

A product with a `trial_period` collects the card without charging and
starts the subscription `trialing`. `checkout.completed` then says
`payment_status: "no_payment_required"`. The first cycle is billed when the
trial ends.

Renewals run on paybox's clock: one `time advance 1y` on a monthly plan bills
twelve times, each at its own instant. Bachs' sandbox cannot do that, because
subscriptions there renew in real time. Every renewal opens an invoice
(`invoice.created`), charges the saved card (`collection.succeeded` or
`collection.failed`), and reports the new period with
`customer.subscription.updated`.

Periods are counted from the start, or from the trial's end, in calendar
units. A subscription that starts on 31 January renews on 28 February and then
on 31 March, never drifting to the 28th. Bachs does not document month-end
handling; this is paybox's choice.

| Status | When |
| --- | --- |
| `trialing` | Before the trial ends, including an active subscription given a future `trial_end`. |
| `active` | Billing normally. |
| `past_due` | A charge failed and recovery is running. |
| `unpaid` | Recovery ran out and the account keeps unpaid subscriptions. |
| `canceled` | Terminal. |

`paused` is in the OpenAPI enum but no endpoint reaches it, so paybox never
produces it.

### Recovery

When a renewal fails:

- the invoice stays open, `invoice.payment_failed` fires, and the
  subscription goes `past_due`;
- Bachs retries **1, 4 and 9 days** after the first failure, each failed try
  firing `invoice.payment_failed` again with `attempt_count` and
  `next_payment_attempt`;
- a success at any point pays the invoice (`invoice.paid`) and moves the
  subscription back to `active`.

When the third retry fails, the invoice becomes `uncollectible` and the
account setting decides what happens next. That setting is dashboard-only at
Bachs, so in paybox it is configuration: `bachs.subscriptionRecovery` in
`paybox.yml`, or `PAYBOX_BACHS_SUBSCRIPTION_RECOVERY`.

- `cancel`, the default, cancels the subscription with reason `payment_failed`
  and fires `customer.subscription.deleted`.
- `unpaid` keeps the subscription `unpaid` and fires
  `customer.subscription.updated`.

Changing the card with `PATCH payment_method_id` on a `past_due` or `unpaid`
subscription retries at once, and so does the portal's recovery payment.

To make renewals fail, subscribe with `4000000000000341`; Bachs' sandbox has
no other way. A renewal charge settles at the instant it is made, because
nobody is waiting on it, so there is no in-flight payment for `paybox
simulate` to steer.

### Changing a subscription

`PATCH` takes exactly one intent; more than one, or none, is `400
VALIDATION_ERROR`. A canceled subscription is `SUBSCRIPTION_NOT_MODIFIABLE`.

- **`product_id`**: the target must recur at the same interval and frequency
  (`SUBSCRIPTION_PLAN_INTERVAL_MISMATCH`) and have a fixed price in the
  subscription's currency (`PLAN_NOT_PRICED_IN_CURRENCY`). `reset` is
  `PRORATION_BEHAVIOR_NOT_SUPPORTED`.
  - The charge is `new × remaining` minus `old × remaining`, where `remaining`
    is the share of the current period still ahead, to the millisecond. Each
    term is rounded half-up to the cent, in integer arithmetic.
  - `invoice_now` (the default) charges a positive difference now on a
    proration invoice, with the payment's `billing_reason` set to
    `subscription_update`.
  - `next_cycle` adds it to the next renewal invoice.
  - `none` changes the terms only.
  - During a trial nothing is prorated.
  - While `past_due` or `unpaid` a plan change is refused with
    `SUBSCRIPTION_NOT_MODIFIABLE`. Prorating a period nobody paid for would
    credit time that was never bought. For the same reason, a period that
    began while recovery was running, and so was never invoiced, is not
    prorated after the subscription recovers. Bachs does not say; this is
    paybox's choice.
- **`trial_end`**: a future date adds or extends a trial. A past or present one
  ends the trial and bills now, starting a fresh cycle. That is
  `SUBSCRIPTION_NOT_TRIALING` when no trial is running.
- **`payment_method_id`**: must be a card saved by this customer.
- **`metadata`**: merged. A key sent as `""` is deleted, `metadata: ""` clears
  everything, and `checkout_id` is kept.

### Credit

A downgrade under `invoice_now` or `next_cycle` becomes **customer credit**,
per customer and currency. Credit is applied to the next invoice before the
card is charged, shown as the gap between `subtotal` and `total`. An invoice
that credit covers in full is paid without charging the card. There is no
API to read the balance, at Bachs or here.

### Cancelling

- `DELETE` cancels now and fires `customer.subscription.deleted`. An invoice
  still owed becomes `uncollectible`, and its retries stop.
- `DELETE` with `cancel_at_period_end: true` fires
  `customer.subscription.updated` and ends the subscription at the period end,
  with no further charge. While a cancellation is scheduled, `next_billed_at`
  is `null`.
- Only the portal can undo a scheduled cancellation, as at Bachs.

paybox's own tools can cancel a Bachs subscription too, for example
`POST /api/subscriptions/{id}/disable` with `cancelled`. Bachs' renewal jobs
re-read the subscription each time they run, so they stop. A
`non_renewing` set that way reads as a cancellation at period end.

### Saved cards and off-session charges

- A card is saved only when a checkout asks: `save_payment_method`, or a
  subscription.
  - With a price, the customer pays and the card is kept.
  - Without one, the checkout is `setup` mode: it collects a USD card,
    charges nothing, and needs an existing `customer.customer_id`.
  - A checkout that offers no card is refused with
    `CHECKOUT_CANNOT_SAVE_PAYMENT_METHOD`.
  - A guest saving a card joins the customer directory, because a card needs
    an owner.
- `payment_method.saved` fires when the card is saved.
  - The first card a customer saves is the default.
  - Saving the same card again returns the same `pm_` and fires nothing. A
    later expiry date replaces the old one, as for a reissued card. A card
    entered with an expiry already past is refused ("Your card has
    expired.") and is not saved.
  - A card paid by another rail saves nothing.
- `POST /v1/charges` charges the named card, or the default one.
  - It answers `201` with `processing`, then `collection.succeeded` a second
    later. A refused card answers `201` with `failed`.
  - The documented refusals each have their code: `NO_SAVED_PAYMENT_METHOD`,
    `SAVED_PAYMENT_METHOD_NOT_FOUND` (another customer's card reads as
    missing), `PAYMENT_METHOD_UNUSABLE` (expired, or removed with paybox's
    tools) and `PAYMENT_METHOD_NOT_ENABLED` (a currency other than USD or
    NGN).
  - A charge in the other of USD and NGN converts at the fixed rate below,
    and the payment records the card amount and the rate.

### The customer portal

A portal session's `url` opens paybox's portal for one customer, for one
virtual hour; after that it shows an expiry page. Bachs' portal settings live
only in its dashboard, so paybox offers what an account with the default
settings offers:

- viewing subscriptions, invoices and saved cards;
- cancelling at the end of the period;
- undoing a scheduled cancellation;
- a recovery payment for a `past_due` or `unpaid` subscription.

Switching plans, adding or removing cards, and editing name or phone are off
by default at Bachs, so they are not offered. A session reaches only its own
customer's subscriptions.

### Product groups

Product groups are stored and returned as published. `CreateCheckoutSessionRequest`
has no field that names a group, so a group cannot yet be offered at
checkout, and `session_mode` is always `CART`.

## How money out behaves

Sources: the pinned OpenAPI document, guides/payouts/{overview,
payout-using-api, global-payouts, payout-schedules}, connect/{payouts,
testing, balances}, for-you/{fees, supported-currencies} and
guides/virtual-accounts/overview, read 2026-10-10.

### Balances

Bachs holds money in USD and NGN only. An NGN collection stays NGN, and a
collection in any other currency "is converted when it settles" into USD. The
sandbox settles at once, so nothing is ever pending.

paybox does this whatever moved the money: the hosted page, `paybox simulate`,
a scenario, the dashboard, or a refund made with paybox's own tools. Whatever
a GHS, KES or other collection (or its refund) leaves in its own currency is
swept into USD before anything reads or moves a balance. A balance read
reports anything not yet swept, without writing.

What lands is the amount net of Bachs' processing fee, the collection's
`settlement_amount`; the fee comes off as the collection settles.

Both balances are always listed, each holding paybox's opening float.
`total_balance_usd` is both in dollars at the fixed rate, "display only".

A refund made through `POST /v1/refunds` holds its amount the moment it is
created, so a payout made before it settles cannot spend the same money. It
needs that amount available in the balance it settled into, which is net of
fees: a full refund of the only collection in an empty balance is refused,
because the fee did not come back. While
any balance is negative, for example after a refund made with paybox's own
tools or a lost dispute, every payout is refused with `ORGANIZATION_IN_DEBT`.

### Rates

Every conversion uses one fixed rate per currency, against the US dollar:

| Currency | Per US dollar |
| --- | --- |
| NGN | 1,500 |
| GHS | 15 |
| KES | 130 |
| TZS | 2,600 |
| UGX | 3,700 |
| XAF, XOF | 600 |
| RWF | 1,400 |
| MWK | 1,750 |
| ZMW | 26 |
| GBP | 0.79 |
| EUR | 0.92 |
| CAD | 1.37 |
| USDT, USDC (every network) | 1 |

1,500 NGN is the figure Bachs' own examples use most often. The others are
round figures of the right size, chosen for paybox, not taken from Bachs.

### Payouts

A payout goes to a saved destination and debits the balance the moment it is
created, fee included.

- **Same currency** (NGN to an NGN bank, USD to a USD bank): send `amount`,
  which is what arrives; "the fee is charged on top". `total_debited` is
  `amount` plus `fee`.
- **Stablecoins** are paid from USD one to one: send `amount`, and the fee
  goes on top.
- **Any other currency** is funded from USD through a quote.
  - `POST /v1/payouts/quotes` sets `from_amount`, what leaves the balance.
  - The withdrawal fee comes out of that before converting, as the spec's
    example shows (`to_amount` = (100.00 − 1.00) × 1,500).
  - A quote lasts 30 seconds and pays one payout.
  - The fee depends on the rail, so a quote is priced for one: send
    `payout_method` (`MOBILE_MONEY` for mobile money; anything else is
    bank). Paying a destination of the other rail with it is
    `QUOTE_DESTINATION_MISMATCH`.
  - NGN cannot fund another currency (`PAYOUT_SOURCE_CURRENCY_UNSUPPORTED`).

Fees follow the published schedule:

| Paid from | Rail | Fee |
| --- | --- | --- |
| NGN | bank | NGN 50 flat |
| USD | bank | 1%, min $1, cap $15 |
| USD | mobile money, crypto | 1%, min $1 |

A payout is `pending`, then `processing` a second later, then `completed` or
`failed` a second after that. A failure gives back the amount and the fee.
Bachs' test destinations decide the outcome:

| Destination | Outcome |
| --- | --- |
| Bank `999` / `0001112223` | completed |
| Bank `998` / `0001112224` | failed |
| Wallet `0x1111111111111111111111111111111111111111` | completed |
| Wallet `0x2222222222222222222222222222222222222222` | failed |
| Mobile money on a listed network | completed |
| Mobile money on any other network | failed ("accepted when you save the destination, but the payout fails when it is sent") |
| Anything else | completed |

A `reference` is unique for the account (`409 CONFLICT`). The documented
refusals each have their code:
- `DESTINATION_NOT_FOUND`, which a deleted destination also gets;
- `QUOTE_REQUIRED` and `QUOTE_NOT_APPLICABLE`;
- `QUOTE_NOT_FOUND`, which a quote already used also gets (`400`, not `404`);
- `QUOTE_EXPIRED` and `QUOTE_DESTINATION_MISMATCH`;
- `AMOUNT_REQUIRED` and `AMOUNT_NOT_ALLOWED_WITH_QUOTE`;
- `INSUFFICIENT_BALANCE`, checked against `total_debited`.

### Destinations

Destinations are approved at once, as Bachs' sandbox does it. The type is
inferred from the currency. GHS, KES and TZS have both bank and mobile money,
so they need `type` (`DESTINATION_TYPE_REQUIRED`).

Each route's required fields are checked (`BANK_ROUTING_DETAILS_INVALID`). An
NGN bank resolves the account name itself, and a supplied one is ignored.

The first destination in a currency is its default; `is_default` moves it.
DELETE deactivates: the destination can still be read, is no longer usable,
and a second DELETE is `404`.

### Conversions

USD <-> NGN only. A quote lasts 30 seconds and converts once. The conversion
completes at once, with no fee ("no hidden markup"), and sends
`conversion.completed`.

### Payout schedules

`/v1/balance_settings` holds one schedule per held balance:
- `manual`, `instant` (a minute after money settles), `daily`, `weekly` or
  `monthly`, at `anchor_hour_utc` (default 10);
- days 29 to 31 land on the last day of a shorter month;
- day arrays on the wrong interval, and the legacy `cadence`, `enabled` and
  `anchor_day`, are `400`;
- only a USD balance can pay out in another currency.

A run pays the default destination for the payout currency.
- It takes settled collections whole, oldest first, each for what it actually
  left: what arrived, less its fee and anything refunded or being refunded.
- It stops at the first collection the balance cannot cover with the fee.
- Each collection is paid only once. A payout that fails, by any path,
  releases its collections, and an `instant` schedule then looks again.
- Its payout's `reference` begins `auto_`.

A run below `minimum_amount` pays nothing, and so does a run with nothing to
pay; neither counts as a failure. Three runs in a row that have money to pay
but cannot pay it, for example with no default destination, return the
schedule to `manual` with a `disabled_reason`. An `instant` schedule runs once
for each settlement, not on a timer.

### The virtual account

One permanent NGN number for the account, starting `90`, at "Sandbox Test
Bank". Asking again returns the same account with `200`.

A deposit, made with paybox's test control, is a collection like any other:
- `collection.succeeded` with no checkout;
- the virtual-account fee, 1% capped at NGN 300, so 250,000 settles 249,700;
- available at once.

## How disputes behave

Sources: the pinned OpenAPI document, guides/disputes/overview,
connect/disputes, for-you/fees and the dispute-created and dispute-updated
event pages, read 2026-10-10.

### The lifecycle

A dispute opens as `needs_response`, with a deadline 14 days out at
23:59:59 UTC, as in Bachs' own example, unless the test control names
another. `customer_email_address`, `customer_name` and `billing_address`
arrive filled in from the charge's customer; they are ordinary evidence.

- **Evidence** is saved any number of times while `needs_response`. Each save
  changes only the fields sent, and `null` clears one. An attachment field must
  name an upload, which is then attached to the dispute.
- **Submitting** locks the evidence and moves the dispute to `under_review`.
- **After the deadline** a save or a submit answers `410 DEADLINE_PASSED`, and
  a locked dispute answers `409 DISPUTE_NOT_EDITABLE` whatever the time.
  Nothing happens on its own at the deadline: the ruling is the network's,
  given with the test control.
- **A ruling** is `won`, `lost` or `closed`, from `needs_response` or
  `under_review`. All three are final, and `is_response_editable` is then
  `false`. While a refund of the same money is still in flight, a loss is
  refused with `409`: the refund prevents the dispute when it settles.
- **A refund prevents it.** Suppose a refund of the charge succeeds while a
  dispute on it is undecided, and the charge's refunds now cover the disputed
  amount. The dispute moves to `prevented`: "the customer was refunded before
  any ruling". A smaller refund leaves the dispute standing.

`dispute.created` is sent when a dispute opens. `dispute.updated` is sent when
the status changes on the network side: a ruling or a prevention. Saving or
submitting evidence sends nothing, and neither does a deadline moving.

One charge holds one undecided dispute at a time; opening another answers
`409 CONFLICT`. A dispute covers at most what is left of the charge: its
amount less what has been refunded and what earlier disputes lost. A lost
amount has "gone back to the customer", so it cannot be refunded either.

A dispute opened with paybox's own tools has a bare token where a Bachs id
would be. The Bachs API gives it a `dsp_` id derived from paybox's id, and
finds it by either. Those tools are paybox's escape hatch and are not held to
these rules. A refund made through the control API does not know about a
lost dispute, a dispute opened there does not know about one already open,
and a resolution given there can rule on a warning.

### What a dispute does to the balance

| When | What moves |
| --- | --- |
| Opened | The $15 fee is taken, and the disputed amount is set aside. |
| `won`, `closed` or `prevented` | The amount comes back. The fee does not. |
| `lost` | The amount stays gone: it "goes back to the customer". The fee is not charged again. |

Both move in the charge's settlement currency, the currency a lost dispute
lands in: NGN for an NGN charge ($15 is NGN 22,500 at the fixed rate), USD for
everything else. A loss can take a balance negative, and while any balance is
negative every payout is refused with `ORGANIZATION_IN_DEBT`. Future
collections heal it.

A refund of a disputed charge needs its own funds, like any refund: until it
settles, both its own hold and the dispute's are taken. connect/disputes says
"an unfundable refund is refused".

The movements are worked out from the dispute records, not from the call that
changed each one. So a dispute opened or settled with paybox's own tools
(`paybox dispute`, the control API) moves the balance too. A merchant-accepted
resolution from those tools raises a real refund, which reads as `lost`; the
refund takes the money, so the amount set aside comes back and nothing is
counted twice. A crash between a dispute and its ledger entry loses nothing:
balance reads report what is owed until it is written.

### Early dispute warnings

Bachs charges $29 for an early dispute warning, once per payment. The API has
no field that tells a warning from a dispute, so `warning: true` on the test
control opens one. A warning is `needs_response` like any dispute and sends
`dispute.created`, but sets nothing aside: no chargeback has been filed yet.
It cannot be won or lost, only closed.

Opening a dispute on a payment whose warning is still undecided turns that
warning into the dispute ("both fees apply"). It takes the new request's
amount, reason and deadline where given. The $15 fee and the hold follow, on
the same `dispute_id` and with no second `dispute.created`.

### Uploads

Both upload endpoints take `multipart/form-data` with a `file` part.

- **Type.** The type is detected from the file's contents ("which may differ
  from what its extension suggests"). A general upload whose type paybox cannot
  detect keeps the declared type. A dispute document must be a PDF, JPEG, PNG
  or GIF by its contents.
- **Size.** Up to 20 MB, or 10 MB for a dispute document; an oversized or
  missing file is `400 VALIDATION_ERROR` on `file`.
- **Storage.** The bytes are kept in paybox's database and served at the
  upload's `url`. A dispute document has no `url`. paybox serves its dashboard
  from the same origin, so anything other than a PDF or an image is served as
  a download, never rendered.
- **Attaching.** An upload is attached by naming it in a product's `media` or
  a dispute's evidence. It attaches to one resource; naming it on another is
  `400 INVALID_UPLOAD_REFERENCE`, and so is a dispute document named as
  product media. A request that is refused attaches nothing. An attached
  upload cannot be deleted. Replacing a product's `media`, or clearing an
  evidence attachment, frees the upload again.

## How Connect behaves

Sources: the pinned OpenAPI document and connect/{accounts, capabilities,
requirements, onboarding, testing, acting-as-an-account, balances, guides/*},
with the account-updated and capability-updated event pages, read 2026-10-10.

### Acting as an account

Send `X-Account-Id: acct_…` with the platform's key and the request runs as
that account, on any endpoint. Only the platform's own accounts can be named;
any other id, whether it exists or not, is `403 FORBIDDEN`. A header under
another name is ignored and the request runs as the platform.

What an owner creates is its own. A resource made under the header is
`404` without it, and the platform's are `404` with it. That covers:
- products and product groups, customers, checkouts and the payments they
  make, refunds, disputes, subscriptions and saved cards;
- payout destinations, quotes, payouts, schedules and conversions;
- the virtual account, uploads, webhook endpoints and the events list;
- balances.

One email can be a customer of the platform and, separately, of each account.
References are unique per owner too: checkout, refund and payout references.

A checkout created as an account is a **direct charge**: the payment is the
account's, its money lands in the account's balance, and its events happen on
the account. So is an off-session charge of an account's customer, and a
deposit into an account's virtual account. Accounts are addressed by path in
`/v1/accounts/{account_id}`, not by the header.

### Accounts and capabilities

An account is created with personas (`merchant`, `recipient`), and personas
only accumulate. A persona whose `capabilities` are left out requests its whole
set on create. Every requested capability is `active` at once, as in the
sandbox, and `conversions` comes with `recipient`. A capability cannot be
withdrawn (`capability_unrequest_unsupported`). paybox's capability control
restricts one (`status_details` `platform_disabled`) or enables it again.

Capabilities gate what an account does, "on `active` only":
- **Payouts** need `payouts` (`403 FORBIDDEN`).
- **Payment methods.** A direct charge needs the capability for the method the
  payer picks (`PAYMENT_METHOD_NOT_ENABLED` on the hosted page): card,
  NGN card, bank transfer, mobile money or crypto. So does an off-session card
  charge.
- **The virtual account** needs `virtual_accounts`.

The review and capability controls are the platform's: an account cannot use
them on itself (`403`).

**Processing fees.** On a direct charge the account pays the processing fee,
unless it was created with `responsibilities.fees.collector: "platform"`. Then
the platform pays the fee and the account settles gross. If the platform's
balance cannot cover the fee, the account pays it after all ("silently falls
back").

An account's balance starts at zero; the opening float is the platform's alone.
That has one visible consequence for an account's automatic payout schedule. A
same-currency payout's fee is "on top", and a run "stops at the first
collection it cannot cover". So with nothing else in its balance, the newest
collection waits for the next one to cover its fee.

`settlement_amount` on a charge always reports the amount net of the fee. When
the platform pays an account's fee, the account in fact settles gross;
`fee_paid_by`, which says who paid, comes with the next part of Connect.
Its balance, payouts and schedules work exactly as the platform's do, on its
own money. Any negative balance blocks its payouts with `ORGANIZATION_IN_DEBT`.

### Requirements

Bachs publishes no catalogue of requirement keys, so paybox uses the keys its
pages use, owed as its pages describe:

| Owed by | Fields |
| --- | --- |
| Every persona | `persons` (until there is one), `persons.<id>.first_name`, `persons.<id>.last_name` |
| `recipient` | `payout_destination` |
| `merchant` | `persons.<id>.dob`, `.id_number`, `.id_document`; `business_profile.product_description`, `.support_email`, `.product_category` |
| A company | `company.registered_name`, `.registration_number`, `.structure`, `company.documents.registration` |

- **Submitting.** Values arrive in `fields` on `POST /v1/accounts/{id}`
  (`persons`, `business_profile`, `company`, `payout_destination`,
  `tos_acceptance`). Everything else in the request is applied first and kept.
  Then every field is validated together; one bad value is `400
  INVALID_REQUIREMENT_FIELD`, with `errors[]` coded, and none of them is saved.
- **Incomplete values.** An incomplete payout destination is not a refusal: it
  stays due, with an error coded `required`. The documented rejection codes for
  a payout destination are all returned: `currency_required`,
  `currency_not_supported`, `type_required`, `bank_code_unknown`,
  `mobile_provider_unknown`, `asset_not_supported`.
- **Payout destination.** An accepted one becomes the account's own payout
  destination, its default for that currency.
- **Review.** Values are accepted at once, as the sandbox does. Two things go
  to review and wait for paybox's review control:
  - a person's identity, once a `primary_verification` document is attached;
  - a certificate of incorporation.
- **Events.** `account.updated` fires when what is outstanding changes;
  `capability.updated` fires whenever a capability's status is written.

### Onboarding links

An account link is single use and expires in 30 days. A new link of the same
type supersedes an open one (`previous_link_superseded: true`). Its `url` opens
paybox's onboarding page, which asks for what is currently due. Submitting it
goes through the same path as `fields`, then redirects to `return_url`. A used,
superseded or expired link redirects to `refresh_url`, where your handler mints
a new one. Documents are attached through the API: the page has no upload.

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
| Connected accounts | An event happens on one account, its origin. That account's own endpoints receive it on `event_source` `account` or `all`; the platform's receive it on `connect` or `all`. The envelope's `organization_id` is the origin, and a top-level `account` repeats it on an account's event. An endpoint registered with paybox's control API receives everything and reads as `all`. The platform's events list, read and replay cover its accounts' events too; an account sees its own. |

Events emitted:
- **Checkout and collection:** `checkout.completed`, `checkout.expired`,
  `collection.succeeded`, `collection.failed`, `collection.underpaid`.
- **Customers:** `customer.created`, `customer.updated`.
- **Refunds:** `refund.created`, `refund.paid`, `refund.failed`.
- **Subscriptions:** `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`.
- **Invoices:** `invoice.created`, `invoice.paid`, `invoice.payment_failed`.
- **Saved cards:** `payment_method.saved`.
- **Payouts:** `payout.created`, `payout.paid`, `payout.failed`.
- **Conversions:** `conversion.completed`.
- **Disputes:** `dispute.created`, `dispute.updated`.
- **Connect:** `account.updated`, `capability.updated`.

`payment_method.saved` is not in the subscribable `event_types` enum (see
[contradictions](#contradictions-in-bachs-documentation)). An endpoint created
through `POST /v1/webhooks/endpoints` therefore cannot ask for it. An endpoint
registered with paybox's control API, which receives every event, does get it.

Invoices exist only in webhooks; Bachs publishes no invoice REST object. Their
`charge` is the charge object that `checkout.completed` carries, because
Bachs gives it no shape of its own. On a payment, `invoice` names the invoice
the payment collected.

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
- **`X-Account-Id`** runs a request as a connected account (see
  [Acting as an account](#acting-as-an-account)). Idempotency keys are per key
  and acting account.

## Differences from Bachs

Each of these exists because a paybox invariant makes the faithful version
impossible, not to save work.

- **Rate limiting is reported, not enforced.** The headers count against 100
  requests per virtual minute. Under a frozen clock that minute never rolls
  over, so refusing requests would lock a test suite out for good after its
  hundredth. To exercise Bachs' `429 TOO_MANY_REQUESTS`, use paybox's network
  simulation, which answers in Bachs' envelope.
- **Fixed exchange rates.** Bachs converts at "the prevailing rate", and a
  moving rate would break determinism, so every rate is a constant (see
  [Rates](#rates)).
- **No conversion at checkout.** Bachs lets a USD price be paid in NGN at a
  live rate.
  - paybox offers only the corridors that can charge one of the checkout's
    currencies: the base currency, or one given in `currency_options`.
  - Crypto is offered on USD checkouts.
  - `fee_usd` is set only on USD payments.
- **No review holds and no withdrawal limits on payouts.** Bachs holds a first
  payout for review and enforces per-account limits. Neither has a sandbox
  trigger, so neither happens here.
- **A deposit over the limits is not held.** Bachs silently holds a virtual
  account deposit over its NGN 5,000,000 limits. paybox credits it.
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
- **Off-session charges always absorb the fee.** Whether the customer pays
  the processing fee is an account setting (`29.00` becomes `30.85`). Until
  checkout settings are emulated, the card is charged what you ask.
- **A plan change is refused while a payment is owed.** See
  [Changing a subscription](#changing-a-subscription).
- **Failed renewals do not invoice the periods that pass while unpaid.** Bachs
  does not say what happens at a period boundary during recovery. paybox opens
  no new invoice while one is still owed, and billing resumes at the next
  boundary.
- **A closed dispute's amount comes back at once.** At Bachs, "Bachs reviews
  the case and releases any amount set aside. It is not released
  automatically". That review has no sandbox trigger, so paybox releases the
  amount with the closure.
- **A requirement catalogue of paybox's own.** Bachs publishes none; see
  [Requirements](#requirements). Its review has no sandbox trigger, so
  paybox's review control decides.
- **The onboarding page takes no documents.** Bachs' hosted flow "collects
  document uploads too"; paybox's page asks for fields only, and documents are
  attached through the API.
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
| Subscribable events | Events overview and saved-card guide list `payment_method.saved` | `event_types` enum omits it | Enum |
| Subscription item id | Spec: `si_…` | Subscriptions overview: `il_…` | `si_` |
| `paused` | Spec enum: a status | Guides: "always in exactly one" of five, none `paused` | Never produced |
| Missing subscription | Spec: `404 NOT_FOUND` | Error reference: `SUBSCRIPTION_NOT_FOUND` | `NOT_FOUND` |
| Downgrade under `none` | Proration table: "no charge, no credit" | Same page: credit "regardless of the proration_behavior" | No credit |
| `next_billed_at` on a canceled subscription | Manage guide: cleared | `customer.subscription.deleted` example: still set | Cleared |
| Invoice retrieval | Changelog: invoices "you can retrieve" | No invoice endpoint or schema in the spec | Webhooks only |
| Product group size | Description: "two or more" | Schema: `minItems: 1` | One or more |
| Payout quote fee | Spec example: taken from `from_amount` before converting | Fees page: added on top; quote description: no fee; webhook example: both | Spec example |
| Payout `amount` | REST: what arrives, in the destination's currency | Webhooks: the source amount | Each on its own surface |
| `payout.paid` status | Event name says paid | `data.status` is `completed` | `completed` |
| Payout id field | REST: `id` | Webhooks: `withdrawal_id` | Each on its own surface |
| Conversion id prefixes | REST: `cqt_`, `cvt_` | Webhooks: `cq_`, `cnv_` | REST's |
| Mobile-money providers | Reference page: `GET /v1/reference/momo` | Payouts guide: `GET /v1/payouts/mobile-money-providers` | Both served |
| Automatic payouts | Fees page: "There is no automatic withdrawal" | Payout schedules guide | Schedules |
| `prevented` | Disputes guide: a status | Spec's status enums (object and filter) stop at `closed` | Served, and filterable |
| Funds at `needs_response` | Spec: "no further funds have moved beyond that fee" | Guide and connect/disputes: the disputed amount is "set aside" from the available balance | Set aside |
| `DISPUTE_NOT_EDITABLE`, `DEADLINE_PASSED` | Disputes guide | Missing from the error reference | Returned, with no `doc_url` |
| `is_response_editable` while `under_review` | Guide: `false` | `dispute.updated` example: `true` | `false` |
| Dispute id length | REST examples: `dsp_` and 12 hex | Event examples: `dsp_` and 10 | 12 |
| A requested capability's status | Spec: lands `pending` | Capabilities page: `restricted`; testing: sandbox grants `active` at once | `active`, as the sandbox does |
| Person `verification.status` | Spec: `unverified`, `pending`, `verified`, `failed` | Guides: `pending`, `passed`, `failed` | Spec |
| Person id | Spec: `per_` and 8 hex | Guides: `per_` and 20 | 8, which the requirement keys use |
| Account link lifetime | Spec example: 30 days | Guide examples: one hour | 30 days |
| `balance_currencies` | Examples: `["NGN"]` on an account, `["NGN","USD"]` on `/me` | Guide: USD "does not appear"; a new account `[]` | USD left out; `[]` until NGN is added |
| Capability names | `listCapabilities` enum: `payouts`, `transfers`, `conversions`, `connect` | Examples list merchant capabilities too | Every applicable capability |
| Connect events | Endpoint `event_types` enum: none of them | Guides subscribe endpoints to `account.updated`, `capability.updated` | Accepted |
| `VALIDATION_ERROR` on accounts | Accounts pages: `422` | Error reference: `400` | `422` for `configuration: {}`, a person's email and the persons page size; `400` elsewhere |

## Not implemented

These are later phases of Bachs. They are not shortcuts.

- **The rest of Connect**: split payments (`platform_fee`, `transfer_data`),
  platform fees and transfers, which come next.
- Checkout settings, and the payment-method, rail and currency listings.
- Offering a product group at checkout (`SELECTION` sessions): the request has
  no field for it.

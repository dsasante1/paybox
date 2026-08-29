# Stripe compatibility

**Coverage: PaymentIntents core.** This document is the authoritative statement
of what is and is not implemented. Where behaviour is modelled rather than
verified, it says so.

Verified on **2026-08-28** against:

- **<https://github.com/stripe/openapi>** — `openapi/spec3.json`, API version
  `2026-08-26.dahlia`. Request and response shapes cite it in source comments.
- <https://docs.stripe.com/payments/paymentintents/lifecycle> — status model.
- <https://docs.stripe.com/webhooks> — signature scheme and retry behaviour.
- <https://docs.stripe.com/testing> — the published test cards.

Unlike Paystack, Stripe's documentation site is reachable to automated clients,
so the prose above could be checked directly rather than through a mirror.

---

## The one thing to understand first

**A Stripe PaymentIntent has no terminal failure.** Its status enum contains no
`failed`. A declined intent returns to `requires_payment_method` with the
reason in `last_payment_error`, and is confirmed again — **on the same id** —
with another payment method. `canceled` is the only state Stripe calls
irreversible.

paybox's canonical `failed` is terminal, so the engine gained a `retry`
transition flag that only this adapter uses. See `docs/architecture.md`.

The **Charge** is different: charges are immutable attempt records, and
`charge.status: failed` genuinely is terminal even while its intent lives on.

## Endpoints

| Endpoint | Status | Notes |
|---|---|---|
| `POST /v1/payment_intents` | **Compatible** | `confirm=true` supported. |
| `GET /v1/payment_intents/{id}` | **Compatible** | |
| `POST /v1/payment_intents/{id}` | **Partially compatible** | Metadata-ish fields only; see below. |
| `GET /v1/payment_intents` | **Partially compatible** | Cursor pagination; see below. |
| `POST /v1/payment_intents/{id}/confirm` | **Compatible** | Retries a declined intent. |
| `POST /v1/payment_intents/{id}/capture` | **Compatible** | |
| `POST /v1/payment_intents/{id}/cancel` | **Compatible** | |
| `GET /v1/charges`, `GET /v1/charges/{id}` | **Compatible** | |
| `POST /v1/charges` | **Partially compatible** | Synchronous, as Stripe's is; see below. |
| `POST /v1/charges/{id}` | **Compatible** | |
| `POST /v1/charges/{id}/capture` | **Partially compatible** | No partial capture; see below. |
| `POST /v1/refunds` | **Compatible** | Full and partial. |
| `GET /v1/refunds`, `GET /v1/refunds/{id}` | **Compatible** | |
| `POST /v1/customers`, `GET /v1/customers`, `GET /v1/customers/{id}` | **Partially compatible** | No update or delete. |
| `POST /v1/payment_methods` | **Partially compatible** | `type=card` only. |
| `GET /v1/payment_methods/{id}` | **Compatible** | |
| `POST /v1/payment_methods/{id}/attach`\|`detach` | **Compatible** | |
| `POST /v1/checkout/sessions` | **Partially compatible** | `mode=payment` only; `price_data` required. |
| `GET /v1/checkout/sessions`, `GET /v1/checkout/sessions/{id}` | **Compatible** | |
| `GET /v1/checkout/sessions/{id}/line_items` | **Compatible** | |
| `POST /v1/checkout/sessions/{id}/expire` | **Compatible** | |
| `GET /stripe/checkout/{id}` | **Emulator-only** | The hosted page; see below. |
| `POST /v1/products`, `GET /v1/products`, `GET /v1/products/{id}` | **Partially compatible** | No update or delete. |
| `POST /v1/prices`, `GET /v1/prices`, `GET /v1/prices/{id}` | **Partially compatible** | Recurring prices only. |
| `POST /v1/subscriptions`, `GET /v1/subscriptions`, `GET /v1/subscriptions/{id}` | **Partially compatible** | Multi-item and trials; see below. |
| `POST /v1/subscriptions/{id}` | **Partially compatible** | `items`, `proration_behavior`, `trial_end`, `cancel_at_period_end`. |
| `POST /v1/subscription_items`, `GET`/`POST`/`DELETE /v1/subscription_items/{id}` | **Compatible** | |
| `GET /v1/subscription_items` | **Partially compatible** | `subscription` is required, as at Stripe. |
| `DELETE /v1/subscriptions/{id}` | **Compatible** | Cancels immediately. |
| `GET /v1/invoices`, `GET /v1/invoices/{id}` | **Compatible** | |
| `POST /v1/invoices` | **Partially compatible** | Draft; `collection_method` accepted, not acted on. |
| `POST /v1/invoices/{id}` | **Partially compatible** | Metadata and description. |
| `DELETE /v1/invoices/{id}` | **Partially compatible** | Voids rather than removes; see below. |
| `POST /v1/invoices/{id}/finalize` | **Compatible** | Sweeps in pending items. |
| `POST /v1/invoices/{id}/pay` | **Partially compatible** | Card and out-of-band; see below. |
| `POST /v1/invoices/{id}/void` | **Compatible** | |
| `POST /v1/invoices/{id}/mark_uncollectible` | **Compatible** | |
| `GET /v1/invoices/{id}/lines` | **Compatible** | |
| `POST /v1/invoiceitems`, `GET /v1/invoiceitems`, `GET`/`DELETE /v1/invoiceitems/{id}` | **Partially compatible** | No update; no discounts or tax rates. |
| `POST /v1/invoices/{id}/send`, `/add_lines`, `/remove_lines`, `/update_lines`, `create_preview`, `search` | **Not supported** | |
| `POST /v1/setup_intents`, `GET /v1/setup_intents`, `GET /v1/setup_intents/{id}` | **Compatible** | |
| `POST /v1/setup_intents/{id}` | **Partially compatible** | Metadata, description and customer. |
| `POST /v1/setup_intents/{id}/confirm` | **Compatible** | Retries a declined setup. |
| `POST /v1/setup_intents/{id}/cancel` | **Compatible** | |
| `GET /stripe/setup/{id}` | **Emulator-only** | The step-up page `next_action` points at. |
| `POST /v1/setup_intents/{id}/verify_microdeposits` | **Not supported** | No bank-debit methods. |
| `POST /v1/accounts`, `GET /v1/accounts`, `GET /v1/accounts/{id}` | **Partially compatible** | Onboarding lifecycle modelled; see below. |
| `POST /v1/accounts/{id}` | **Partially compatible** | Profile, email, capabilities, metadata. |
| `POST /v1/accounts/{id}/reject` | **Compatible** | |
| `DELETE /v1/accounts/{id}` | **Partially compatible** | Rejects rather than removes; see below. |
| `POST /v1/account_links` | **Compatible** | Expiry is real virtual time. |
| `GET /stripe/connect/onboard/{id}` | **Emulator-only** | The onboarding page; see below. |
| `GET /v1/balance` | **Partially compatible** | Scoped by `Stripe-Account`; `pending` always empty. |
| `GET /v1/application_fees`, `GET /v1/application_fees/{id}` | **Compatible** | |
| `POST`/`GET /v1/application_fees/{id}/refunds` | **Partially compatible** | No update; no metadata on a fee refund. |
| Terminal, Issuing, Radar, Tax, everything else | **Not supported** | Out of scope. |

## Requests are form-encoded

Every Stripe endpoint takes `application/x-www-form-urlencoded` and nothing
else — there is no JSON request body anywhere in their specification. Nested
structures travel as bracketed keys:

```
amount=2000&currency=usd
payment_method_data[type]=card
payment_method_data[card][number]=4242424242424242
metadata[order_id]=A-1
expand[]=customer
```

paybox expands those into nested objects before validation. Keys without
brackets pass through unchanged. `__proto__`, `constructor` and `prototype`
are refused anywhere in a key, because a bracket parser is otherwise a
prototype-pollution vector.

JSON bodies are **also** accepted, which Stripe does not do. Their SDKs never
send JSON, but curl users do, and rejecting it produces a baffling 415 rather
than a useful error.

## Authentication

`Authorization: Bearer sk_test_...` or `Authorization: Basic <base64 of
"sk_test_...:">` — both, because Stripe's SDKs use both.

- Keys starting `sk_live_` / `pk_live_` / `rk_live_` are **rejected with HTTP
  403**. Deliberate and not configurable. See [SECURITY.md](../SECURITY.md).
- Other key shapes are rejected unless `PAYBOX_ALLOW_ANY_KEY=1`.
- Nothing validates *which* test key you use.

## Checkout Sessions

A session returns a `url`, and paybox serves the page it points at — otherwise
the most-used Stripe integration would be untestable. The page is **card only**
and lists Stripe's published test cards on it. It carries the §29 emulator
banner, which comes from a shared hosted-page shell so it cannot drift between
this page and Paystack's.

The hosted page is **deliberately unauthenticated**: the payer visits it, not
the merchant, and Stripe's is public too.

| Session state | When |
|---|---|
| `status: open`, `payment_status: unpaid` | Created, not yet paid |
| `status: complete`, `payment_status: paid` | Paid; `url` becomes null |
| `status: expired` | Expired or cancelled; the page returns **410** |

Sessions expire **24 hours** after creation, as at Stripe. Because that is a
scheduled job against virtual time, an abandoned checkout is one command away:

```bash
paybox time advance 25h     # fires checkout.session.expired
```

A **declined** card leaves the session `open`, so the payer can try another —
which is what Stripe does, and follows from a PaymentIntent surviving its own
failure.

## Billing

A canonical **Plan is a Stripe Price** — an amount plus how often. Stripe's
**Product** (what the thing is) is a separate row, because one product can
carry several prices; Paystack folds both into a plan, so its plans have no
product.

Recurring billing runs on virtual time, on the same machinery Paystack uses:

```bash
paybox time advance 360d    # twelve monthly invoices, one calendar month apart
```

`interval_count` is honoured, so `interval: month, interval_count: 3` bills
four times a year rather than twelve.

| Canonical subscription | Stripe |
|---|---|
| `active` | `active` |
| `attention` | `past_due` |
| `non_renewing` | `active` **plus `cancel_at_period_end: true`** |
| `completed`, `cancelled` | `canceled` |

`cancel_at_period_end` is the mapping worth knowing: Stripe expresses "stops at
period end" as a **flag on an active subscription**, not a status of its own.

| Canonical invoice | Stripe |
|---|---|
| `pending` | `open` |
| `success` | `paid` |
| `failed` | **`open`** — Stripe keeps retrying, so a failed invoice is still collectible |

`invoice.created` is raised **one hour** before the debit for Stripe, against
Paystack's three days, because Stripe finalises an invoice shortly after
creating it. That lead time is per-provider.

### Checkout in subscription mode

`mode: subscription` works, given a line item pointing at a recurring `price`.
The session's own payment covers the first period, so the subscription is
anchored **one interval ahead** rather than billing immediately — otherwise the
payer would be charged twice for the same period.

## Status mapping

| Canonical | Stripe PaymentIntent | Note |
|---|---|---|
| `created` | `requires_payment_method` | Nothing attached yet. |
| `pending` | `requires_confirmation` | |
| `processing` | `processing` | |
| `requires_action` | `requires_action` | |
| `authorized` | `requires_capture` | Stripe's separate-capture state. |
| `successful` | `succeeded` | |
| **`failed`** | **`requires_payment_method`** | **Alive and retryable**; reason in `last_payment_error`. |
| `cancelled` | `canceled` | |
| `expired` | `canceled` | Stripe has no expired status; it cancels with a reason. |
| `refunded`, `partially_refunded` | `succeeded` | A refund does not change the intent's status. |

## Test cards

Stripe's own published numbers, from `/docs/testing`:

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 0002` | `card_declined` / `generic_decline` |
| `4000 0000 0000 9995` | `card_declined` / `insufficient_funds` |
| `4000 0000 0000 9987` | `card_declined` / `lost_card` |
| `4000 0000 0000 9979` | `card_declined` / `stolen_card` |
| `4000 0000 0000 0069` | `expired_card` |
| `4000 0000 0000 0127` | `incorrect_cvc` |
| `4000 0000 0000 0119` | `processing_error` |
| `4000 0025 0000 3155` | Requires 3-D Secure |
| `4000 0000 0000 3220` | Requires 3-D Secure 2 |

**CVV is never read, never stored, and appears nowhere in the data model.** A
card number is reduced to its BIN and last four before anything is persisted —
which is why `last_payment_error.decline_code` is derived from the canonical
failure code rather than by looking the number back up.

## Webhooks

Signature: **`Stripe-Signature: t=<unix seconds>,v1=<hex>`**, HMAC-SHA256 over
`${t}.${payload}`, keyed with the endpoint secret. The timestamp is signed, so
it cannot be altered independently.

**Every delivery attempt is re-signed** with a fresh timestamp, as Stripe does.
Replaying a stale signature would fail the receiver's five-minute tolerance —
a failure the emulator would have invented.

### Events emitted

| Canonical | Stripe |
|---|---|
| `payment.created` | `payment_intent.created` |
| `payment.processing` | `payment_intent.processing` |
| `payment.requires_action` | `payment_intent.requires_action` |
| `payment.authorized` | `payment_intent.amount_capturable_updated` |
| `payment.successful` | `payment_intent.succeeded` |
| `payment.failed` | `payment_intent.payment_failed` |
| `payment.cancelled`, `payment.expired` | `payment_intent.canceled` |
| `refund.created` | `refund.created` |
| `refund.successful` | `charge.refunded` |
| `refund.failed` | `refund.failed` |
| `customer.created` | `customer.created` |
| `payment.successful` (session) | `checkout.session.completed` |
| `payment.expired` (session) | `checkout.session.expired` |
| `subscription.created` | `customer.subscription.created` |
| `subscription.non_renewing`, `subscription.attention` | `customer.subscription.updated` |
| `subscription.cancelled`, `subscription.completed` | `customer.subscription.deleted` |
| `invoice.created` | `invoice.created` |
| `invoice.success` | `invoice.paid` |
| `invoice.payment_failed` | `invoice.payment_failed` |

**One canonical event fans out to several Stripe events**, because Stripe
reports one thing happening on more than one object. A settlement sends both
`payment_intent.succeeded` and `charge.succeeded`, each carrying its own
object and its own `evt_` id, and each matched against endpoint subscriptions
separately — so an endpoint subscribed to only `charge.succeeded` receives only
that. A failure fans out the same way, to `payment_intent.payment_failed` and
`charge.failed`.

Note the contrast with Paystack, which has **no** failure webhook at all.
Stripe does, because its intent survives the failure and the merchant is
expected to react.

## Known limitations

1. **A Checkout Session is stored on the payment it collects for**, with its
   own fields in metadata, rather than as an independent object. A
   `mode: payment` session and a payment are one lifecycle, and `expires_at` /
   `status: expired` map straight onto the canonical `expiresAt` / `expired`.
   `mode: subscription` will need a real session row; it is not implemented.
2. **One price per subscription.** Multi-item subscriptions are refused rather
   than silently billing only the first. There is no `subscription_items` API.
3. Invoices are **read-only**. Stripe's draft/finalise/void/pay lifecycle is
   not modelled: an invoice here is created open and settles or fails.
4. `trialing`, `paused`, `incomplete` and `incomplete_expired` subscription
   states are not modelled. Neither are trials or proration.
5. Prices must be **recurring**. A one-off price has no plan to model, so it is
   refused rather than stored as something it is not.
6. **The intent and its charge are one row.** `pi_…` and `ch_…` address the
   same payment. They are not independent objects as they are at Stripe, so a
   payment cannot have several charges — which is also why a retry reuses the
   charge id rather than minting a new one.
7. **Cursor pagination is emulated over offsets.** `starting_after` and
   `ending_before` work by scanning up to 10,000 rows for the cursor id; a
   cursor beyond that window is ignored rather than honoured.
8. `POST /v1/payment_intents/{id}` updates metadata, description and
   `receipt_email` only. Amount and currency are deliberately not updatable.
9. The legacy Charges API is implemented: `POST /v1/charges`,
   `POST /v1/charges/{id}` and `POST /v1/charges/{id}/capture`. It is
   deliberately **synchronous**, as Stripe's is -- a decline is a 402
   `card_error` carrying `charge` and `payment_intent`, not a 200 with a
   retryable object -- and a card needing SCA fails with
   `authentication_required`, because this API has no way to present a step-up.
   Three gaps: `source` accepts paybox's own `pm_` ids (there is no Tokens API,
   so `tok_`, `src_` and `card_` are not resolvable), partial capture is not
   supported (`amount` on capture is accepted and ignored; paybox stores one
   amount per payment), and `application_fee_amount`, `destination` and
   `transfer_data` are Connect fields that are not modelled.
10. Refunds settle **immediately**. Stripe's asynchronous refund path applies to
   bank-backed methods, which this slice does not implement.
11. `client_secret` is derived from the intent id and is **not** a credential.
   It keeps runs reproducible; do not treat it as unguessable.
12. `receipt_url` is always null, because the emulator serves no receipt page.
   That is what Stripe returns before one exists.
13. A customer created without an email gets a synthetic local address, because
   paybox keys customers on email and Stripe does not require one.
14. **An invoice's total is a fold over its lines**, recomputed on every change
   rather than stored alongside them -- a total that can disagree with the
   lines beneath it eventually will. Line amounts are signed, so a credit is a
   negative line and the arithmetic works out; the invoice total is clamped at
   zero, because paybox has no customer credit balance for an overall negative
   to go into. Four differences from Stripe: `DELETE /v1/invoices/{id}` **voids**
   a draft rather than removing it (the event log is append-only, and a
   vanished invoice would leave a hole in the audit trail — the response still
   reports `deleted: true`); `collection_method: send_invoice` is accepted but
   nothing is emailed, since the emulator sends no mail; there are no discounts,
   coupons or tax rates; and `invoice.finalization_failed`, `invoice.sent`,
   `invoice.upcoming`, `invoice.updated` and `invoiceitem.deleted` are not
   emitted.
15. **SetupIntents store an instrument without moving money**, and are modelled
   as their own canonical resource rather than a zero-amount payment -- a row
   that never moves money would pollute every total, list and balance with
   things that are not transactions. A card saved through a setup, created
   directly as a PaymentMethod, or left behind by a charge resolves to **one**
   PaymentMethod: all three doors compute the same instrument fingerprint.
   Gaps: no `latest_attempt` (paybox has no SetupAttempt object), no `mandate`,
   and `verify_microdeposits` is absent because no bank-debit method is
   implemented.

   **A stored instrument belongs to a customer.** One customer saving the same
   card twice has one PaymentMethod; two customers saving the same card have
   two, because that is what both providers do -- Paystack mints a separate
   `authorization_code` per customer and a Stripe PaymentMethod attaches to
   exactly one. `POST /v1/payment_methods` mints a fresh one every time, since
   it has no customer to dedupe against, and confirming a SetupIntent against a
   PaymentMethod you already hold attaches *that* one rather than minting a
   second for the same card.
16. **A subscription can carry several prices on one cycle**, and every price
   on it must share an interval and currency -- a mismatch is refused rather
   than producing a subscription whose renewal date is a lie about half its
   prices. `subscription.quantity` and `planId` remain the *first* item's, which
   is what sets the cadence.
17. **Trials are a status, not a date.** A trialing subscription reports
   `trialing` and bills nothing until `trial_end`, which is also its first
   billing date -- so the trial and its first charge can never disagree about
   when the free period stopped. `customer.subscription.trial_will_end` fires
   three days ahead, as Stripe documents, and is skipped entirely for a trial
   shorter than that rather than fired with a date in the past.
   `trial_end: now` converts immediately.
18. **Proration is two lines, not one net figure**: a credit for the unused
   time on the old shape and a charge for the remainder on the new, each
   `proration: true`, so the arithmetic on the invoice is checkable. All three
   of Stripe's behaviours work — `create_prorations` (the default) raises
   pending items that land on the next invoice, `none` changes the price and
   waives the difference, `always_invoice` bills it now. Two differences: a
   downgrade that nets to a credit is **voided** rather than charged as zero
   (paybox has no customer credit balance to carry it into), and there is no
   `pending_update` / `payment_behavior` flow, so a change always applies
   immediately.
19. **`current_period_start` moves with each renewal.** It previously reported
   the subscription's `start_date`, which was only right during the first
   cycle. Proration is measured against this window.
20. **A connected account cannot charge anything until it onboards.**
   `POST /v1/accounts` returns `charges_enabled: false`, `payouts_enabled:
   false` and a populated `requirements.currently_due` — exactly as Stripe
   does, and deliberately, because an emulator that handed back a working
   account would hide the single most common way a Connect integration ships
   broken. `POST /v1/account_links` returns a link to a page the emulator
   actually serves; completing it enables the account and activates its
   requested capabilities. Differences: the onboarding page presents the
   *decision* rather than a fake form (business details, bank accounts and
   identity documents cannot mean anything locally), `external_account` is
   generated rather than accepted (spec §29 — no real bank details may enter),
   `DELETE` rejects rather than removes so charges the account took do not end
   up pointing at nothing, and there is no `account.application.authorized`,
   `capability.updated` or `account.external_account.*` event.
21. **Connect charges move real money between real balances.** The ledger has
   an owner per entry — null for the platform, a connected account otherwise —
   and the balance is still a fold over it, just folded per owner. A **direct**
   charge (`Stripe-Account` header) credits the connected account the amount
   less the fee and the platform the fee; a **destination** charge
   (`transfer_data[destination]`) credits the platform in full, and the share
   moves separately. A charge cannot be both, and one naming an account that
   has not onboarded is refused.

   Three consequences worth knowing, all of which are what really happens:
   refunding a direct charge debits the **connected account**, not the
   platform, and does not return the application fee — so a refunded direct
   charge **can push a connected account negative**. A connected account starts
   at a zero balance with no share of the opening test float, because it has
   genuinely earned nothing. And an unknown `Stripe-Account` header is a 404
   rather than a silent fallback to the platform, since quietly charging the
   wrong party is a bug only found by reconciling money.

   Application fees are derived from the charge that carries them rather than
   stored as their own rows, the same way `pi_` and `ch_` are two views of one
   payment. `GET /v1/balance` reports `pending` as always empty: paybox settles
   instantly, and a developer testing "wait for funds to become available"
   needs to know that wait does not exist here.
22. `expand[]` is honoured on every route, in the query string and in a POST
   body, on single objects and on `data.` paths in a list. Naming a nested path
   expands the levels above it, as Stripe does, and more than four levels is
   refused. Two differences from Stripe: an id that does not resolve leaves the
   string in place rather than erroring, and a path naming a field paybox does
   not model is a no-op rather than "This property cannot be expanded" -- these
   objects are a documented subset, and erroring on the difference would break
   integrations without teaching anything.

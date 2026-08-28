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
| `GET /v1/charges`, `GET /v1/charges/{id}` | **Partially compatible** | Read-only; see below. |
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
| SetupIntents, Billing, Connect, Terminal, Issuing, Radar, Tax, everything else | **Not supported** | Later slices, or out of scope. |

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
2. Checkout requires `price_data` on every line item. A bare `price` id needs
   the Prices API, which is not implemented, and accepting one would silently
   produce a zero-amount session.
3. **The intent and its charge are one row.** `pi_…` and `ch_…` address the
   same payment. They are not independent objects as they are at Stripe, so a
   payment cannot have several charges — which is also why a retry reuses the
   charge id rather than minting a new one.
4. **Cursor pagination is emulated over offsets.** `starting_after` and
   `ending_before` work by scanning up to 10,000 rows for the cursor id; a
   cursor beyond that window is ignored rather than honoured.
5. `POST /v1/payment_intents/{id}` updates metadata, description and
   `receipt_email` only. Amount and currency are deliberately not updatable.
6. Charges are read-only. There is no `POST /v1/charges`; the legacy direct
   charge API is not implemented.
7. Refunds settle **immediately**. Stripe's asynchronous refund path applies to
   bank-backed methods, which this slice does not implement.
8. `client_secret` is derived from the intent id and is **not** a credential.
   It keeps runs reproducible; do not treat it as unguessable.
9. `receipt_url` is always null, because the emulator serves no receipt page.
   That is what Stripe returns before one exists.
10. A customer created without an email gets a synthetic local address, because
   paybox keys customers on email and Stripe does not require one.
11. `expand[]` is parsed and ignored. Nothing is expanded.

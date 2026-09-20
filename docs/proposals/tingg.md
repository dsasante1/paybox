# Proposal: adding Tingg (Cellulant) to paybox

**Status: implemented.** All of it, in commit `ed9c01a`. This file is kept as the
record of *why* the design is what it is — the alternatives weighed, and the two
judgment calls (one prefix rather than two; capping the retry ladder) that a
reader of the finished code would otherwise have to reconstruct.

It is **not** a coverage contract. [`docs/tingg.md`](../tingg.md) is, and it is
the file to trust about what the adapter actually serves. The three seams are
described in [`docs/architecture.md`](../architecture.md). Where this file and
those two disagree, they are right and this one is stale.

**Sources.** Everything below was read from `docs.tingg.africa` on **2026-09-20**;
each claim carries its page. `dev-portal.tingg.africa` — the Stoplight portal the
docs link to for raw route definitions — **returns HTTP 403 to automated fetches**,
exactly like `paystack.com/docs`. So there is no pinnable OpenAPI artefact here as
there is for Paystack (`PaystackOSS/openapi`); cite the `docs.tingg.africa` URL and
the date instead, per CONTRIBUTING non-negotiable #3.

---

## 1. What Tingg is, and what we would take

Tingg is Cellulant's payments platform (Nairobi; the docs claim collection across
25 African countries). The developer portal splits into three products:

| Product | What it is | Take it? |
|---|---|---|
| **Tingg Checkout 3.0** | Collections — hosted checkout, host-to-host charge, cards, mobile money, bank transfer | **Yes** |
| **Tingg Payouts** ("BEEP") | Disbursement — mobile money, bank, airtime, bill payments | **Yes** |
| **Tingg Engage** | Transactional messaging, OTP and alerts | **No** — not payment infrastructure |

Engage is out of scope. It is an SMS product; emulating it teaches a developer
nothing about payment flows and would dilute the coverage numbers.

## 2. The three facts that shape the design

Tingg is not a variation on a provider already in the repo. Three things are
genuinely new, and two of them need core seams.

### 2.1 Checkout and Payouts are two different APIs wearing one brand

This is a wider gap than Flutterwave v3 vs v4, which already justified two adapters.

| | Checkout 3.0 | Payouts (BEEP) |
|---|---|---|
| Auth | OAuth2 `client_credentials` → bearer token, **plus** an `apiKey` header on every call | `username`/`password` **inside the request body** |
| Routing | REST paths (`/v3/checkout-api/checkout-charge`) | RPC — one path, `{"function": "BEEP.postPayment"}` selects the operation |
| Path | `/v3/checkout-api/*` | `/v1/global-api/payments` |
| Casing | `snake_case` (`merchant_transaction_id`) | `camelCase` + SHOUTED acronyms (`payerTransactionID`, `MSISDN`) |
| Envelope | `{status: {status_code, status_description}, results: {…}}` | `{authStatus: {authStatusCode, …}, results: […]}` — an array, batch-capable |

Sources: [Authenticate request](https://docs.tingg.africa/reference/authenticate-requests),
[Post a payment](https://docs.tingg.africa/reference/postpayment),
[Query payment status](https://docs.tingg.africa/reference/querypaymentstatus).

Note also that Checkout's `status_code` is **not consistently an HTTP code**: the
express-checkout response uses `200`, while `checkout-charge` answers `1` with
`"Transaction was saved successfully."` That inconsistency is real and gets
reproduced, not tidied up.

### 2.2 Tingg webhooks are not signed at all

[Express Checkout](https://docs.tingg.africa/docs/checkout-v3-express-checkout),
[Implement webhook via callback URL](https://docs.tingg.africa/reference/4-implement-webhook-via-callback-url-1),
[Callback](https://docs.tingg.africa/docs/callback).

There is no HMAC, no signature header, no shared secret in a header. The Payouts
callback carries the merchant's `username`/`password` **in the callback body** as
its only authentication. This is the same category of finding as Flutterwave v3's
`verif-hash`, and arguably worse — and like that one it gets reproduced faithfully
and documented loudly, not improved on.

`sign()` therefore returns no headers. No new seam; `FormattedWebhook` already
permits that.

### 2.3 The merchant's *response body* decides whether delivery succeeded

This is the interesting one, and it is the reason Tingg is worth building.

Tingg POSTs the IPN to `callback_url` and then **retries every 30 seconds for 24
hours** — roughly 2,880 attempts — until the merchant answers with a body carrying
a `status_code`:

| Code | Meaning |
|---|---|
| `183` | Payment accepted — stop |
| `180` | Payment rejected by the merchant — stop |
| `188` | Received, will acknowledge later — stop retrying, settle via the acknowledgement API |

An HTTP `200` with the wrong body **does not stop the retries**. Every other
provider in paybox ends delivery on a 2xx, and
`packages/webhooks/src/dispatcher.ts:264` encodes exactly that:

```ts
const ok = result.status !== null && result.status >= 200 && result.status < 300;
```

That is a developer-facing bug class you cannot rehearse against a sandbox without
this emulator — an integration that returns a bare `200 OK` looks fine in testing
and then gets hammered for 24 hours in production. Emulating it is the strongest
single argument for adding Tingg.

## 3. Core seams required

Three, all narrow, all opt-in, all general. Following the `retry` / `variant` /
`resignsPerAttempt` precedent in `docs/architecture.md`.

**Seam 1 — `WebhookFormatter.interpretResponse?(status, body)`.**
Returns `'delivered' | 'retry'`. Default (absent) keeps today's HTTP-status rule
verbatim, so no existing provider changes by construction. Tingg's implementation
parses the body and requires `status_code ∈ {183, 180, 188}`. This is the Tingg
analogue of `variant`: a hook on the formatter, not a branch in the dispatcher.

**Seam 2 — a per-formatter retry policy.**
`DispatcherOptions.retry` (`dispatcher.ts:71`) is one dispatcher-wide
`RetryPolicy` with exponential backoff. Tingg's ladder is *fixed-interval*, 30s,
capped by elapsed time rather than attempt count. Let a formatter declare its own
policy and fall back to the dispatcher's. `createRetryPolicy` already takes a
`backoff` function, so this is a lookup change, not a new mechanism.

> Worth deciding before building: 2,880 attempts is a lot of rows for
> `time advance 24h`. Recommend capping the emulated ladder (e.g. 20 attempts)
> **and saying so in `docs/tingg.md`** — a documented, honest divergence, in the
> spirit of non-negotiable #4. Do not silently truncate it.

**Seam 3 — per-request callback URLs.**
`storage.webhooks.endpointsFor(provider, eventType)` (`dispatcher.ts:132`)
resolves globally-registered endpoints. Tingg takes `callback_url` **on each
checkout request**, so two concurrent checkouts can legitimately target two
different URLs. Options, in preference order:

1. Store the per-request URL in `storage.providerState` (the seam Wise added) and
   have the adapter register/resolve an endpoint for it — **recommended**, no core
   change at all.
2. Add an optional `endpointUrl` override on `FormattedWebhook` — smaller code,
   but puts routing in the formatter, which so far only formats.

Start with (1). If it gets ugly, (2) is the fallback, and that is a design signal
worth recording.

Nothing else in `packages/core` should need to change. The dual-credential auth
(`Authorization: Bearer` + `apiKey`) is entirely adapter-local.

## 4. What maps onto existing machinery for free

- **`230 — insufficient float balance`** on `BEEP.postPayment` lands exactly on
  the balance ledger and its reserve-on-queue rule. `BEEP.queryFloatBalance` is a
  read of the same fold. This is the ledger design being validated by a provider
  it was not built for.
- **Pending mobile money.** `checkout-charge` answers `overall_status: 130` with
  `payment_instructions` ("You will receive a prompt on your mobile number…") —
  the canonical `pending` → prompt → `successful`/`failed` loop paybox exists for.
  Select the outcome by **msisdn**, as the Quid adapter does, not by card number.
- **Refunds** (`/v3/checkout-api/refund/request`) support full and partial, with
  codes `184`/`185` initiated, `186`/`187` processed, `191` expired. The docs are
  explicit that **notifications fire only for the final codes 186, 187 and 191** —
  so paybox fires none for the initiated state either.
- **Acknowledgement** (`/v3/checkout-api/acknowledgement/request`) is a first-class
  merchant action with `Full`/`Partial` types. It has no analogue in the other
  seven providers and is a genuinely new flow to offer.

## 5. Proposed shape

**One package, one mount point.**

```
packages/providers/tingg/
  src/auth.ts        OAuth2 token issue + the dual Bearer/apiKey guard
  src/checkout.ts    /v3/checkout-api/*  (express, checkout, charge, query, ack, refund)
  src/payouts.ts     /v1/global-api/payments — the BEEP function dispatcher
  src/schemas.ts     two dialects: snake_case checkout, camelCase BEEP
  src/serializers.ts the {status, results} and {authStatus, results[]} envelopes
  src/status.ts      Tingg's numeric codes ↔ canonical statuses
  src/webhook.ts     IPN bodies + interpretResponse
  src/signature.ts   deliberately empty, with the comment explaining why
  src/coverage.ts    the manifest
```

Mounted at **`/tingg`**, with two Fastify scopes inside — one per auth scheme,
which is what Fastify encapsulation is for. Not two prefixes: a real integration
points a single base URL at `api.tingg.africa` and calls both `/v3/checkout-api/*`
and `/v1/global-api/payments` against it, so `http://localhost:8080/tingg` has to
serve both for an unmodified client to work. That is the opposite of the
Flutterwave call, and for the opposite reason — there, v3 and v4 collide on paths
and a client targets exactly one.

One `CoverageManifest` (`id: 'tingg'`, `basePath: '/tingg'`) covering both
surfaces, with `docs/tingg.md` prose separating collections from payouts. Two
manifests sharing a `basePath` would need `tests/coverage-drift.test.ts` to learn
about overlapping mounts for no user-visible gain.

## 6. Suggested phasing

| Phase | Scope | Why this order |
|---|---|---|
| **1** | OAuth token, Express Checkout (`/checkout-request/express-request`), hosted page, IPN + the 183/180/188 acknowledgement contract | Smallest slice a real integration can run against end to end, and it forces seams 1–3 out into the open immediately |
| **2** | Custom Checkout: `/checkout/request`, `/checkout-charge`, charge, query status, acknowledgement API | The pending mobile-money prompt — paybox's core value |
| **3** | Payouts (BEEP): `postPayment`, `queryPaymentStatus`, `queryFloatBalance`, `validateAccount`, `queryBill` | Exercises the ledger and the `230` insufficient-float path |
| **4** | Refunds; Direct Card + 3DS; Nigeria dedicated virtual accounts | Refunds are near-free given spec §18; the other two carry open questions (§7) |

Phase 1 alone is a defensible release. Phases 3 and 4 are independent of each other.

## 7. Open questions — record as unverified, do not invent

Per non-negotiable #3, these go into `docs/tingg.md` as gaps rather than being
guessed at:

- **Direct Card `source_Of_funds` encryption.** The public page calls it an
  "encrypted string" and never names the scheme, key format or key distribution.
  Flutterwave v3 (3DES-ECB) and Kora (AES-256-GCM) were documented; this is not.
  **Do not ship a card rail until it is.** Phase 4 is blocked on support@tingg.africa
  or a sandbox account.
- **Which host is sandbox.** The docs give three — `api.tingg.africa`,
  `api-approval.tingg.africa`, `api-test.tingg.africa` — and contradict themselves:
  [Express Checkout](https://docs.tingg.africa/docs/checkout-v3-express-checkout)
  calls `api-approval` *production* while
  [Authenticate request](https://docs.tingg.africa/reference/authenticate-requests)
  calls it the *sandbox*. Irrelevant to the emulator (we are localhost), but
  `docs/tingg.md` should say the upstream docs disagree rather than pick one.
- **Full `payment_option_code` list.** Only `SAFKE` appears in an example. The
  supported-options page is linked but not enumerated. Ship the codes that are
  attested and list the rest as unimplemented.
- **Callback retry policy source.** "Every 30 seconds within 24 hours" comes from
  the [Callback](https://docs.tingg.africa/docs/callback) page. Cite it, since the
  emulated ladder will deliberately diverge (§3, seam 2).
- **Payouts base URL and bulk disbursement.** `payouts-get-started` documents
  neither; the base URL was recovered from the reference pages, and bulk appears in
  search results but on no page fetched here.

## 8. Recommendation

*(Retained as written. What actually shipped: all four phases except the Direct
Card rail of phase 4, which is blocked exactly as §7 predicted. Seam 3 went the
way §3 recommended — per-request URLs resolved through an adapter-registered
endpoint, with the dispatcher only filtering — so no fallback to option 2 was
needed.)*

Build it, in the phase order above, and treat §2.3 as the headline feature rather
than a footnote — an emulator that can prove a developer's callback handler
answers `183` instead of a bare `200` is testing something no provider sandbox
will make easy, which is the product thesis.

Two caveats worth holding: the card rail is blocked on undocumented encryption and
should not be attempted on guesswork, and the 24-hour retry ladder needs a
documented cap before it meets `paybox time advance`.

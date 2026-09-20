# Tingg coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Every shape below was verified against **`docs.tingg.africa`, read 2026-09-20**,
and the specific page is cited beside each group in the source.

**There is no pinnable spec for Tingg.** The documentation links route
definitions to a Stoplight portal at `dev-portal.tingg.africa`, and that host
returns **HTTP 403 to automated fetches** — the same situation as
`paystack.com/docs`. So unlike Paystack (a pinned commit of `PaystackOSS/openapi`)
or Wise (a hashed OpenAPI bundle), the citation here is the documentation URL
and the date it was read. Anything that could not be read from a page that
served is marked below rather than guessed at.

Base path: `/tingg`.

## Two APIs, one prefix

Tingg is two products that share a brand and almost nothing else.

| | Checkout 3.0 | Payouts ("BEEP") |
| --- | --- | --- |
| Paths | `/v3/checkout-api/**` | `/v1/global-api/payments` |
| Auth | OAuth2 bearer **plus** an `apiKey` header | `username`/`password` **in the request body** |
| Routing | REST | RPC — a `function` field selects the operation |
| Envelope | `{status: {status_code, status_description}, results}` | `{authStatus: {authStatusCode, …}, results: […]}` |
| Casing | `snake_case` | `camelCase` with shouted acronyms (`MSISDN`, `payerTransactionID`) |
| Errors | HTTP status + body code | **always HTTP 200**, code in the envelope |

Both are served from **one prefix**, because a real integration points a single
base URL at `api.tingg.africa` and calls both families against it. That is the
opposite of the Flutterwave decision — v3 and v4 collide on paths and a client
targets exactly one, so they are two adapters at two prefixes. Here the paths
are disjoint and a client targets both.

## Authentication

### Checkout 3.0

Two credentials on every call:

```
apiKey: <application consumer key>
Authorization: Bearer <access token>
```

The token comes from `POST /v1/oauth/token/request`, a `client_credentials`
exchange authenticated by the `apiKey` header alone. Tokens live **one hour**
and expire against *virtual* time, so `paybox time advance 2h` expires one
exactly as production would.

**paybox matches the key rather than checking a prefix, and that is deliberate.**
Paystack has `sk_test_`, Kora has `sk_test_`, Quid has `ak_test_`. Tingg
publishes no such convention — its documented sample key is a bare 32-character
opaque string — so *nothing in the shape of a Tingg key distinguishes a live one
from a sandbox one*. A prefix check is impossible and inventing one would be
inventing provider behaviour. Requiring an exact match against the key paybox
generated is strictly safer: a real live key does not match and is refused on
arrival. `PAYBOX_ALLOW_ANY_KEY=1` relaxes it.

### Payouts

No headers at all. `payload.credentials.username` and `.password`, in the body.
paybox accepts Tingg's own published sandbox pair (`sandboxUser` /
`sandboxPassword!`) so a script copied out of the Payouts guide runs unchanged.
A bad pair is **not** an HTTP error — it comes back `200` with
`authStatusCode: 132`, because that is what Tingg does.

## Webhooks: the part worth reading

### Tingg does not sign webhooks. At all.

No HMAC, no signature header, no shared secret, no verification scheme. The IPN
documentation describes the body, the retries and the required response, and
never mentions one; the integration dashboard has no webhook-secret setting.

The Payouts callback goes further: its only authentication is the merchant's own
`username` and `password` **echoed back inside the callback body**. A receiver
checking them is comparing a secret that just arrived in plaintext against one it
already holds, which establishes nothing an attacker replaying the body could not
also satisfy.

This is reproduced, not improved on — the same call the adapter makes for
Flutterwave v3's `verif-hash`. A developer's Tingg integration *cannot* verify a
signature, and an emulator that invented one would teach them to write
verification code that fails the moment it meets the real thing.

### A 2xx is not an acknowledgement

**This is the single most useful thing this adapter does.** Every other provider
in paybox ends a delivery on any 2xx. Tingg does not. It reads a code out of the
response **body**:

| Code | Meaning | Stops retries |
| --- | --- | --- |
| `183` | Payment accepted | yes |
| `180` | Payment rejected by the merchant | yes |
| `188` | Received, will be acknowledged later | yes |

A bare `200 OK` with no body, or with a body carrying no code, is **not** an
acknowledgement, and Tingg re-posts. An integration that returns `200 OK` looks
correct against every other provider here and gets hammered for twenty-four
hours in production. paybox reproduces that exactly.

Both spellings are accepted (`status_code` on the checkout IPN, `statusCode`
inside `results` on the payout callback) because Tingg's own two products use
different ones. String and numeric codes are both accepted, because Tingg's IPN
page types the response `status_code` as a string.

### The retry ladder is fixed-interval, and paybox caps it

Tingg retries **every 30 seconds for 24 hours** — a flat interval, about **2,880
attempts**. paybox runs the same 30-second interval and **stops at 20 attempts**.

That cap is a deliberate, documented divergence. 2,880 delivery rows per
unacknowledged webhook would make `paybox time advance 24h` unusable and bury the
delivery log, while the property being tested — that an unacknowledged IPN comes
back, at a fixed interval, until acknowledged — is fully visible in twenty. Both
figures are here so nobody calibrates against the wrong one.

### Callback addresses are per request

Tingg has no dashboard-registered webhook URL. `callback_url` arrives on the
checkout payload and `extraData.callbackUrl` on a payout packet. paybox records
each address as it sees it and delivers a resource's IPN **only** to the address
that resource named, so two concurrent checkouts pointing at two URLs do not
cross-deliver.

A consequence worth knowing: `paybox webhook add --provider tingg` will register
an endpoint, but checkout and payout notifications will not go to it — they go to
the per-request address, as at Tingg.

### The delivery labels are paybox's

Tingg's callback body carries **no event name** — no `event`, `type` or header.
paybox labels deliveries `checkout.payment` and `payout.status` purely so the
delivery log, the dashboard and endpoint filters have something to key on.
**Neither string appears anywhere on the wire.**

### What is not sent

No pending notification. Tingg's documentation describes the callback as
carrying a payment — "when a full payment is made" — and documents no pending
IPN, so paybox sends none. Same rule that keeps `charge.failed` out of the
Paystack adapter.

No payout callback for a *queued* payout. `postPayment` answers `139` and the
documentation is explicit that 139 is the only code that triggers a callback,
so the callback *is* the final status arriving. `BEEP.queryPaymentStatus` is how
you check in the meantime.

## Amounts

**Tingg speaks major units.** Its samples quote `"request_amount": 600` against
`KES` and return `"dueAmount": 25.83`. The engine only ever sees integer minor
units, so conversion happens once, at the adapter boundary, in the request
schema — the same place and for the same reason the Flutterwave adapter does it.
Values are **rounded**, never truncated.

No FX, ever. `original_request_amount` equals `request_amount` and
`original_request_currency_code` equals `request_currency_code`, because paybox
never converts (spec §17). At Tingg those fields differ only where it did.

## Countries and currencies

Tingg carries **two country vocabularies and they disagree**: Checkout documents
`country_code` as a three-letter code and sends `KEN`; Payouts documents
`countryCode` and sends `KE`. Same company, same transaction. Preserved rather
than normalised — a merchant collecting and disbursing in Kenya writes both.

| Checkout | Payouts | Country | Currency |
| --- | --- | --- | --- |
| `KEN` | `KE` | Kenya | KES |
| `NGA` | `NG` | Nigeria | NGN |
| `GHA` | `GH` | Ghana | GHS |
| `TZA` | `TZ` | Tanzania | TZS |
| `UGA` | `UG` | Uganda | UGX |

**This list is paybox's, not Tingg's.** Tingg claims collection across 25
countries and payouts across 35 and publishes no machine-readable list of
either. These five are the ones appearing in worked examples on the pages read.
Both encodings are accepted everywhere, which is more forgiving than Tingg.

## Payment options

`payment_option_code` selects the rail, and Tingg's codes are **merchant
configured** — the dashboard activates them per service and no complete list is
published anywhere readable. The only code in a worked example is `SAFKE`
(Safaricom Kenya).

So the adapter **accepts any code** rather than policing a list it does not have,
and classifies the one it can attest. An unrecognised code is treated as mobile
money. That default is paybox's inference, not Tingg's contract.

## Test instruments

Outcomes follow the shared convention in
[test-instruments.md](test-instruments.md): the **payer's mobile number**
decides, through the same resolver every other adapter uses. Tingg publishes no
test numbers, so nothing here claims to be Tingg's.

Two conventions **are** paybox's own and are labelled as such:

- A payout **account number ending `0000`** is rejected by the rail; anything
  else settles.
- On `BEEP.validateAccount`, an account ending `0000` is invalid (`306`) and one
  ending `9999` cannot be validated (`301`); anything else is valid (`307`).

## Endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/oauth/token/request` | **Compatible** | One-hour token, expires on virtual time. |
| `POST /v3/checkout-api/checkout-request/express-request` | **Partially compatible** | `charge_beneficiaries` and `prefill_msisdn` are accepted and echoed, not acted on. |
| `POST /v3/checkout-api/checkout/request` | **Compatible** | Logs the request; no charge. |
| `POST /v3/checkout-api/checkout-charge` | **Compatible** | Logs and charges in one call. Answers `status_code: 1`. |
| `POST /v3/checkout-api/charge/request` | **Compatible** | Charge against an existing checkout. |
| `GET /v3/checkout-api/query/{service_code}/{merchant_transaction_id}` | **Partially compatible** | Response body is paybox's — see below. |
| `POST /v3/checkout-api/acknowledgement/request` | **Compatible** | `Full` and `Partial`. |
| `POST /v3/checkout-api/refund/request` | **Partially compatible** | See refunds below. |
| `POST /v1/global-api/payments` | **Partially compatible** | Five BEEP functions — see below. |

### `status_code` is not consistently an HTTP status

Express checkout answers `status_code: 200`. `checkout-charge` answers
`status_code: 1` with "Transaction was saved successfully." That inconsistency
is Tingg's and is reproduced rather than tidied up: a client switching on the
value has to handle both, and it should find that out here.

### The HTTP status of an error is paybox's choice

Tingg's reference pages give the *body* code for each failure (`1001` no request
found, `1007` missing country code, `1013` not JSON, `1014` missing
`merchant_transaction_id`, `1015` missing `checkout_request_id`, `1017` invalid
msisdn, `1027` invalid amount, `500` generic) and **never say what HTTP status
carries it**. Their samples only ever show 200.

paybox uses conventional statuses (400 for the validation family, 401 for auth,
404 for not-found, 429 for rate limiting) so ordinary HTTP tooling behaves
sensibly. **Branch on `status.status_code`** — that is the field Tingg's own
examples read, and the one that is faithful.

### Query request status

The published page for this route renders through the 403'd Stoplight portal, so
its exact response body could not be read. paybox answers in the standard
checkout envelope carrying the same fields the IPN does. The path, method and
parameters are Tingg's; **the body shape is paybox's**.

## BEEP functions

| Function | Status | Notes |
| --- | --- | --- |
| `BEEP.postPayment` | **Partially compatible** | Answers `139`. Reserves against the balance; `230` when the float cannot cover it. |
| `BEEP.queryPaymentStatus` | **Compatible** | By `payerTransactionID` or `beepTransactionID`. |
| `BEEP.queryFloatBalance` | **Compatible** | Reads the balance ledger — the same fold `paybox balance` prints. |
| `BEEP.validateAccount` | **Partially compatible** | Outcome by account number; see test instruments. |
| `BEEP.queryBill` | **Partially compatible** | Bill amount is deterministic from the account number, not a real bill. |

Not implemented: bulk disbursement as a distinct mode (a packet of several items
is already processed item by item, which is what the documented batch shape
does), and `refundPayment`, which appears in third-party summaries of the BEEP
surface but on no `docs.tingg.africa` page that served.

`payerTransactionID` is the payout's canonical `reference` — it is unique by
contract, which a reference has to be. A repeat of one already seen echoes the
original rather than queueing a second payout.

The outer `authStatusCode: 131` says the **credentials** were accepted and
nothing about whether the payment went through. Reproduced as published: a
client reading only the outer envelope would call a failed payout a success, and
that is a bug worth being able to find locally.

## Refunds

`refund_type` is `Full` or `Partial` (Tingg's own sample sends `PARTIAL`
uppercase; paybox accepts either case). A partial refund requires `amount`.

Tingg's refund reference page lists notification codes as "184/185 initiated
(partial/full), 186/187 processed (partial/full), 191 expired", and says
notifications fire for the final three only — so paybox emits none for the
initiated state.

**The partial/full pairing is inferred.** It is stated only in that
parenthetical and corroborated nowhere else; paybox treats the lower number of
each couple as partial. If you depend on the distinction, verify it against your
own Tingg account before trusting this.

There is no refund status query endpoint here, because none is published.

## The hosted checkout page

`GET /tingg/checkout/{merchant_transaction_id}` and its `POST` are
**emulator-only** and are never presented as Tingg surface. Tingg's own hosted
page lives on a Tingg domain with a URL shape paybox has no business imitating.
Express checkout returns this page's URL as both `short_url` and `long_url` —
the same page from both, because there is no link shortener here and pretending
otherwise would mean one of the two did not work.

The page drives the same charge path the Custom Checkout API does rather than
being a second implementation beside it, so a payer paying through it and a
merchant posting `checkout-charge` produce the same events, the same IPN and the
same delivery ladder.

## Not implemented

- **Direct Card API and 3DS.** `source_Of_funds` is documented only as an
  "encrypted string" — the scheme, key format and key distribution are not
  published anywhere readable. Flutterwave's 3DES-ECB and Kora's AES-256-GCM
  were documented; this is not. Shipping a card rail on a guess would mean
  inventing the one thing a developer's encryption code has to match exactly.
  **This is blocked on documentation, not on effort.**
- **Dedicated virtual accounts** (Nigeria only, per Tingg's own note).
- **Tingg Engage**, the transactional messaging product. Not payment
  infrastructure.
- **SDK and UI library** integrations — paybox serves HTTP, not a JS bundle.
- **Settlement and fee schedules.** `service_charge_amount` is always `0`:
  Tingg's fees are not published, and inventing a schedule would put a number in
  a developer's reconciliation tests that no real statement will ever match.

## Which host is sandbox is contradictory upstream

Tingg's pages give three hosts — `api.tingg.africa`, `api-approval.tingg.africa`
and `api-test.tingg.africa` — and disagree about them: the express-checkout page
calls `api-approval` *production* while the authenticate-request page calls it
the *sandbox*. Irrelevant to an emulator that only serves localhost, but worth
recording, because it means an environment name copied from one page may not
mean what a reader assumes.

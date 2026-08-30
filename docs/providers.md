# Providers

How to point each supported integration at the emulator, authenticate, verify
its webhooks, and know what is emulator-only. Each section ends with a link to
that provider's **contract** — the file that says exactly what is and is not
implemented. If something is missing from the contract, it is not there.

The pattern is the same everywhere:

1. change the **base URL** your integration uses;
2. use the **local credential** printed by the banner (`paybox status`
   prints them all; `GET /api/providers` returns them as JSON);
3. register a **webhook endpoint for that provider** —
   `paybox webhook add <url> --provider <id>`. It prints the signing secret,
   generated in the shape that provider's verifier expects; pass `--secret`
   to choose your own.

| Provider | Base URL | Credential | Sent as |
|---|---|---|---|
| Paystack | `http://127.0.0.1:8080/paystack` | `sk_test_local_…` | `Authorization: Bearer` |
| Stripe | `http://127.0.0.1:8080/stripe` | `sk_test_local…` | `Authorization: Bearer` or `Basic` |
| Flutterwave v3 | `http://127.0.0.1:8080/flutterwave` | `FLWSECK_TEST-…` (+ 24-char encryption key) | `Authorization: Bearer` |
| Flutterwave v4 | `http://127.0.0.1:8080/flutterwave/v4` | `flw-test-local-…` / `flwsec-test-local-…` | OAuth2 client credentials → `Bearer <token>` |
| Kora | `http://127.0.0.1:8080/kora` | `sk_test_local_…` | `Authorization: Bearer` |
| WeWire | `http://127.0.0.1:8080/wewire` | `sk_test_local_…` | `ww-api-key: <key>` — no Bearer |
| Wise | `http://127.0.0.1:8080/wise` | `wise_test_local_…` | `Authorization: Bearer` |

Credentials are regenerated from the seed on every start; with a fixed
`PAYBOX_SEED` they are stable.

## What every adapter refuses

- **A live credential — HTTP 403, not configurable.** `sk_live_*`, `pk_live_*`,
  `rk_live_*`, `FLWSECK-*` / `FLWPUBK-*` (no `_TEST`), and for Wise anything
  JWT-shaped (three base64url segments). The message tells you to rotate it.
- **A key of the wrong shape — HTTP 401** unless `PAYBOX_ALLOW_ANY_KEY=1`.
  Nothing checks *which* test key you send: any `sk_test_…` works for
  Paystack, Kora and WeWire.
- **A wrong header.** WeWire with `Authorization: Bearer` fails, because that
  is what WeWire does.

## Idempotency

Paystack, Stripe, Flutterwave (v3 and v4) and Kora honour an
**`Idempotency-Key`** request header on every non-GET route:

| Same key + … | Result |
|---|---|
| same method, path and body | the original response, byte for byte, with `x-paybox-idempotent-replay: true`; nothing is created twice |
| a different body | `409` `idempotency_conflict`, in the provider's own error envelope |

Only successful responses (< 400) are memoised, so a failed request can be
retried with the same key. Body comparison is order-insensitive.

WeWire and Wise take their idempotency key **in the body**, as those APIs do:
`idempotencyKey` on WeWire's payout, collection and disbursement endpoints;
`customerTransactionId` on Wise's `POST /v1/transfers`.

## Simulated outages

`paybox network failure 0.25` answers a quarter of provider requests with a
500 (or `failureStatus`) **before the handler runs** — the transaction never
existed — and in each provider's own error shape, so a client parsing the
body sees exactly what its provider would send:

| Provider | Envelope |
|---|---|
| Paystack | `{ "status": false, "message": "…" }` |
| Stripe | `{ "error": { "type": "api_error", "message": "…" } }` (429: `invalid_request_error` + `code: rate_limit`) |
| Flutterwave v3 | `{ "status": "error", "message": "…", "data": null }` |
| Flutterwave v4 | `{ "status": "failed", "error": { "type": "SERVER_ERROR", "code": "10500", "message": "…" } }` |
| Kora | `{ "status": false, "message": "…", "data": null }` |
| WeWire | `{ "success": false, "error": { "code": "INTEGRATION_UNAVAILABLE", "message": "…", "statusCode": 500 } }` |
| Wise | `{ "timestamp": "…", "errors": [ { "code": "unexpected.error", "message": "…" } ] }` |

---

## Paystack

```env
PAYSTACK_BASE_URL=http://127.0.0.1:8080/paystack
PAYSTACK_SECRET_KEY=sk_test_local_…
```

```bash
curl -X POST $PAYSTACK_BASE_URL/transaction/initialize \
  -H "Authorization: Bearer $PAYSTACK_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","amount":10000,"currency":"GHS","reference":"order_1"}'
```

`authorization_url` points at `GET /paystack/checkout/:accessCode`, a real
page listing the test instruments; paying there redirects to your
`callback_url` with `?reference=`. `POST /charge` skips the page and charges an
instrument directly — mobile money, card, bank, USSD, EFT.

Paystack is the provider the CLI can create payments for directly
(`paybox payment create`), and the only one whose references the CLI and
`/api/payments/:id` resolve by name.

**Webhook** — `x-paystack-signature`, HMAC-SHA512 (hex) over the raw body,
keyed with your secret key. The endpoint secret defaults to the local secret
key, so `paybox webhook add <url>` needs no `--secret`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyPaystack(rawBody /* Buffer */, signature, secretKey) {
  const expected = Buffer.from(createHmac('sha512', secretKey).update(rawBody).digest('hex'));
  const got = Buffer.from(signature ?? '');
  return expected.length === got.length && timingSafeEqual(expected, got);
}
```

Events: `charge.success`, `refund.*`, `transfer.*`, `subscription.*`,
`invoice.*`, `charge.dispute.*`, `dedicatedaccount.assign.*`. **No
`charge.failed`** — Paystack does not send one. Full table and status mapping:
[paystack.md](paystack.md).

Emulator-only: `POST /paystack/dispute`, `GET /paystack/subscription/:code/invoices`,
`metadata.paybox_outcome`, the checkout page, and the `/api` credits for
balance and dedicated accounts.

## Stripe

```env
STRIPE_API_BASE=http://127.0.0.1:8080/stripe
STRIPE_SECRET_KEY=sk_test_local…
```

Requests are **form-encoded**, as Stripe's are; JSON is also accepted as a
convenience. Both `Bearer` and `Basic` authentication work.

```bash
curl $STRIPE_API_BASE/v1/payment_intents -u "$STRIPE_SECRET_KEY:" \
  -d amount=2000 -d currency=usd -d confirm=true \
  -d "payment_method_data[type]=card" \
  -d "payment_method_data[card][number]=4242424242424242"
```

A declined intent returns to `requires_payment_method` and is confirmed again
on the same id. Checkout Sessions return a `url` the emulator serves; sessions
expire after 24 hours of virtual time. `Stripe-Account` scopes a request to a
connected account. `expand[]` works.

**Webhook** — `stripe-signature: t=<unix seconds>,v1=<hex>`, HMAC-SHA256 over
`${t}.${rawBody}` keyed with the endpoint secret, **re-signed on every delivery
attempt** with the virtual instant. Register the endpoint; paybox issues a
`whsec_…` secret and prints it (or pass `--secret` to use your own):

```bash
paybox webhook add http://localhost:3000/webhooks/stripe --provider stripe
#  ✓ http://localhost:3000/webhooks/stripe
#    signing secret  whsec_local…
```

```js
const event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
```

Under a frozen or advanced clock, the signature's timestamp is the *virtual*
time; `constructEvent` compares it with the wall clock and rejects anything
more than 300 s apart. In tests pass a wide tolerance as the fourth argument,
or keep the clock flowing for Stripe. See [Time control](time.md#signatures-that-carry-a-timestamp).

One canonical event fans out to several Stripe events — a settlement is both
`payment_intent.succeeded` and `charge.succeeded`, each its own delivery, each
matched against `eventTypes` separately. Full table: [stripe.md](stripe.md).

Emulator-only: the checkout, setup step-up and Connect onboarding pages.

## Flutterwave v3

```env
FLW_BASE_URL=http://127.0.0.1:8080/flutterwave        # then /v3/…
FLW_SECRET_KEY=FLWSECK_TEST-…
FLW_ENCRYPTION_KEY=…                                  # 24 characters, from the banner
```

```bash
curl -X POST $FLW_BASE_URL/v3/payments -H "Authorization: Bearer $FLW_SECRET_KEY" \
  -H 'content-type: application/json' \
  -d '{"tx_ref":"order_1","amount":"75.50","currency":"NGN","redirect_url":"http://localhost:3000/return","customer":{"email":"dev@example.com"}}'
```

Amounts are **major units** on the wire, converted (and rounded) at the
boundary. Direct card charges may send `client` 3DES-encrypted under the
encryption key — the path a real integration uses — or the plain shape for
curl. Flutterwave's published test cards drive PIN / 3DS / AVS / NoAuth
step-ups; `/validate-charge` honours OTPs `5548` and `6648`.

**Webhook** — `verif-hash`, which is the secret hash **verbatim**. There is no
HMAC and the body is not signed; that is Flutterwave v3's real scheme,
reproduced rather than improved. Register the endpoint with the hash your app
compares against (without `--secret`, the local Flutterwave secret key stands
in for it):

```bash
paybox webhook add http://localhost:3000/webhooks/flw --provider flutterwave --secret my-secret-hash
```

```js
if (req.headers['verif-hash'] !== process.env.FLW_SECRET_HASH) return res.sendStatus(401);
```

`charge.completed` is sent for **failures too** — read `data.status`. Also
`transfer.completed`, `subscription.cancelled`, `chargeback.created`; nothing
for in-flight states. Contract: [flutterwave.md](flutterwave.md).

## Flutterwave v4

```env
FLW_V4_BASE_URL=http://127.0.0.1:8080/flutterwave/v4
FLW_V4_CLIENT_ID=flw-test-local-…
FLW_V4_CLIENT_SECRET=flwsec-test-local-…
```

The token endpoint is served under the same base rather than on a separate
identity host, so one URL changes:

```bash
TOKEN=$(curl -s -X POST $FLW_V4_BASE_URL/oauth/token \
  -d grant_type=client_credentials -d client_id=$FLW_V4_CLIENT_ID -d client_secret=$FLW_V4_CLIENT_SECRET \
  | jq -r .access_token)

curl -X POST $FLW_V4_BASE_URL/charges -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'X-Scenario-Key: scenario:auth_pin&issuer:insufficient_funds' \
  -d '{ … }'
```

Tokens live 600 s of **virtual** time — `paybox time advance 11m` invalidates
one — and do not survive a restart. Outcomes come from `X-Scenario-Key`
(Flutterwave's own mechanism); an unrecognised key parks the charge at
`pending`.

**Webhook** — `flutterwave-signature`, base64 HMAC-SHA256 over the raw body,
keyed with the secret hash:

```js
const expected = createHmac('sha256', secretHash).update(rawBody).digest('base64');
```

**What the server actually sends today is v3.** The running emulator
registers one Flutterwave webhook formatter, in v3 mode, for the whole
provider — so a webhook for a charge created through the v4 API arrives in the
**v3 shape with `verif-hash`**, not with `flutterwave-signature`. The v4 scheme
is implemented and covered by tests, but no delivery uses it yet. Register a
single endpoint with `--provider flutterwave` and verify it the v3 way.
Contract: [flutterwave.md → v4 specifics](flutterwave.md#v4-specifics).

## Kora

```env
KORA_BASE_URL=http://127.0.0.1:8080/kora               # then /merchant/api/v1/…
KORA_SECRET_KEY=sk_test_local_…
```

```bash
curl -X POST $KORA_BASE_URL/merchant/api/v1/charges/initialize \
  -H "Authorization: Bearer $KORA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"reference":"order_1","amount":100,"currency":"NGN","customer":{"email":"dev@example.com"}}'
```

Major units on the wire. Card charges step up through an OTP; mobile money
through an OTP and then an STK prompt, answered with Kora's own sandbox
endpoint `POST /charges/mobile-money/sandbox/authorize-stk`. `charge_data` may
be AES-256-GCM encrypted (`iv:ciphertext:tag`, hex) under the secret key, or
plain.

**Webhook** — `x-korapay-signature`, hex HMAC-SHA256 over
**`JSON.stringify(body.data)` only**, keyed with the secret key. The `event`
name is outside the signature — a real property of Kora's scheme, reproduced:

```js
const expected = createHmac('sha256', secretKey).update(JSON.stringify(body.data)).digest('hex');
```

Events: `charge.success`, `charge.failed`, `charge.expired`, `refund.success`,
`refund.failed`, `transfer.success`, `transfer.failed`, `transfer.reversed`.
Contract: [kora.md](kora.md).

## WeWire

```env
WEWIRE_BASE_URL=http://127.0.0.1:8080/wewire           # then /v1/…
WEWIRE_API_KEY=sk_test_local_…
```

```bash
curl $WEWIRE_BASE_URL/v1/wallets -H "ww-api-key: $WEWIRE_API_KEY"
```

FX-centric: a cross-currency payout is quoted from a **fixed rate table**
(deterministic, not market data) and stored in the source currency with the
quoted destination amount as metadata. Beneficiary bank details are validated
with real checksums (IBAN mod-97, ABA, sort code); payout references are
validated per rail (SEPA vs Faster Payments). Ghana collections and
disbursements use WeWire's published sandbox numbers.

Every wallet starts at the opening float; `POST /wewire/paybox/wallets/credit`
(emulator-only) stages a specific balance.

**Webhook** — [Standard Webhooks](https://www.standardwebhooks.com): three
headers, `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`,
HMAC-SHA256 over `{id}.{timestamp}.{body}`. The key is the **base64-decoded
part after `whsec_`**, not the literal secret; a secret without the prefix is
used as raw bytes. Re-signed per attempt; five-minute tolerance.

```bash
paybox webhook add http://localhost:3000/webhooks/wewire --provider wewire
#    signing secret  whsec_…        # base64 after the prefix, as the libraries expect
```

```js
import { Webhook } from 'standardwebhooks';
const payload = new Webhook(process.env.WEWIRE_WEBHOOK_SECRET).verify(rawBody, req.headers);
```

The event name depends on the corridor: a Ghana payout completes as
`disbursement.completed`, an offshore one as `transaction.status_updated`,
with different payload shapes. Contract: [wewire.md](wewire.md).

## Wise

```env
WISE_API_BASE=http://127.0.0.1:8080/wise               # then /v1, /v2, /v3, /v4 per resource
WISE_API_TOKEN=wise_test_local_…
```

The strictest flow here, enforced in full:

```
GET  /v2/profiles                                  → pick a profile (two are seeded)
POST /v3/profiles/{profileId}/quotes               → a quote (single use, 30-minute expiry)
POST /v1/accounts                                  → a recipient
POST /v1/transfers                                 → a transfer (reserves nothing)
POST /v3/profiles/{profileId}/transfers/{id}/payments  { "type": "BALANCE" }   → funds it
```

A funding rejection is a **`201` with `status: REJECTED`**, not an HTTP error.
Wise's sandbox drivers — `GET /v1/simulation/transfers/{id}/{status}` and
`POST /v1/simulation/balance/topup` — are implemented as published, so a Wise
sandbox script runs unchanged.

**Webhook** — `X-Signature-SHA256`, base64 **RSA-SHA256** over the raw body:
the only asymmetric scheme here. Your verifier holds no secret; it fetches the
public key — PEM, as `text/plain` — from `GET /wise/paybox/webhook-public-key`
with your bearer token (emulator-only; in production you would fetch Wise's).
The keypair is embedded in the adapter,
private key included and deliberately so: it proves nothing and exists only so
a verifier can be exercised.

```js
import { createVerify } from 'node:crypto';
const ok = createVerify('RSA-SHA256').update(rawBody).end()
  .verify(publicKeyPem, req.headers['x-signature-sha256'], 'base64');
```

Subscribe either with `paybox webhook add <url> --provider wise` or through
Wise's own `POST /v2/profiles/{profileId}/subscriptions` with
`trigger_on: transfers#state-change`; both register against the same store.
Every delivery is `event_type: transfers#state-change` and the consumer
branches on `data.current_state`. Contract: [wise.md](wise.md).

---

## Pointing an SDK at the emulator

Three tiers, in order of preference. Settings named here come from each
SDK's own documentation; confirm against the version you run.

**1. Base URL from configuration.** Most integrations build requests against
an env var or a constant. Change it; done. This covers every hand-rolled
client and the Paystack, Flutterwave, Kora, WeWire and Wise examples above.

**2. An SDK setting that accepts a path.** Stripe's server SDKs expose one:

| SDK | Setting |
|---|---|
| Python | `stripe.api_base = "http://127.0.0.1:8080/stripe"` |
| Ruby | `Stripe.api_base = "http://127.0.0.1:8080/stripe"` |
| PHP | `\Stripe\Stripe::$apiBase = "http://127.0.0.1:8080/stripe";` |
| Java | `Stripe.overrideApiBase("http://127.0.0.1:8080/stripe");` |
| Go | `stripe.SetBackend(stripe.APIBackend, &stripe.BackendConfig{URL: stripe.String("http://127.0.0.1:8080/stripe")})` |

`stripe-node` is the awkward one: its `host` / `port` / `protocol` options
carry no path, so it would request `/v1/…` at the root and get a 404. Give it
a fetch that rewrites the prefix:

```js
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  host: '127.0.0.1', port: 8080, protocol: 'http',
  httpClient: Stripe.createFetchHttpClient((url, init) =>
    fetch(String(url).replace('http://127.0.0.1:8080/v1/', 'http://127.0.0.1:8080/stripe/v1/'), init)),
});
```

**3. Transport interception** — for SDKs that hardcode their host
(`flutterwave-node-v3`, several community Paystack libraries) and for
non-Node languages without a base-URL setting. **Not implemented yet.** Until
it is, call those provider APIs over plain HTTP in the code path you are
testing, or wrap the SDK's transport yourself.

## Disabling a provider

```yaml
providers:
  wise: { enabled: false }
```

removes that adapter's routes entirely (the `flutterwave` flag covers v3 and
v4). Useful when a port-scanning test or an OpenAPI diff should see only the
provider you integrate with.

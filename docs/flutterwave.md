# Flutterwave coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

## Which API

Flutterwave ships **two live APIs** with different authentication, envelopes
and webhook signatures. paybox implements **both**, as two separately mounted adapters — they share
almost nothing, so they are two plugins rather than one with a flag.

|              | v3                                      | v4                                      |
| ------------ | --------------------------------------- | --------------------------------------- |
| Base path    | `/flutterwave/v3`                       | `/flutterwave/v4`                       |
| Auth         | `Bearer FLWSECK_TEST-…`                 | OAuth2 client credentials, 10-min tokens |
| Envelope     | `{status:"success", message, data}`     | `{status:"success"\|"pending"\|"failed", message, data}` |
| Errors       | `{status:"error", message, data}`       | `{status:"failed", error:{type,code,message}}` |
| Ids          | integers (`1254647`)                    | prefixed strings (`chg_VoUhmFMhmF`)     |
| Test control | published card table                    | `X-Scenario-Key` header                 |
| Webhook      | `verif-hash` — the secret verbatim      | `flutterwave-signature` — base64 HMAC   |

Every shape below was verified against `developer.flutterwave.com/v3.0.0/docs`,
read **2026-08-29**. Where a page is cited, that is the page the behaviour
comes from.

## Endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v3/payments` | **Compatible** | Standard checkout; returns a hosted link. |
| `POST /v3/charges?type=card` | **Partially compatible** | Encrypted or plain; see below. |
| `POST /v3/charges?type=mobile_money_*` | **Compatible** | Parks awaiting the handset. |
| `POST /v3/charges?type=bank_transfer\|ussd\|debit_ng_account\|nqr` | **Partially compatible** | Charge is created and settles by test instrument; no rail-specific payload (no dynamic account number or USSD string). |
| `POST /v3/validate-charge` | **Compatible** | Honours the published special OTPs. |
| `GET /v3/transactions/{id}/verify` | **Compatible** | Accepts id, `flw_ref` or `tx_ref`. |
| `GET /v3/transactions/verify_by_reference` | **Compatible** | |
| `GET /v3/transactions` | **Partially compatible** | Page size fixed at 20; `from`/`to`/`tx_ref` filters only. |
| `POST /v3/transactions/{id}/refund` | **Compatible** | Full and partial. |
| `GET /v3/refunds` | **Partially compatible** | No filtering. |
| `POST /v3/transfers` | **Compatible** | Enforced against the balance. |
| `GET /v3/transfers`, `GET /v3/transfers/{id}` | **Compatible** | |
| `GET /v3/customers` | **Partially compatible** | List only. |
| `GET /flutterwave/checkout/{tx_ref}` | **Emulator-only** | The hosted page; see below. |
| `GET /flutterwave/3ds/{tx_ref}` | **Emulator-only** | The page `meta.authorization.redirect` points at. |
| `POST /v3/payment-plans`, `GET`/`PUT /v3/payment-plans/{id}`, `GET /v3/payment-plans` | **Partially compatible** | `quarterly` is refused; see below. |
| `POST /v3/tokenized-charges` | **Compatible** | Card-on-file; no step-up, as intended. Takes the `card.token` a settled card charge returns on `/charges`, `/validate-charge` and `/verify` (null until the charge settles). |
| `POST /v3/subaccounts`, `GET /v3/subaccounts`, `GET /v3/subaccounts/{id}` | **Partially compatible** | No update or delete. |
| `POST /v3/virtual-account-numbers`, `GET /v3/virtual-account-numbers/{ref}` | **Partially compatible** | One account per customer; no BVN check. |
| `GET /v3/banks/{country}` | **Partially compatible** | A fixed list for NG, GH and KE. |
| Subscriptions, chargebacks, bill payments, BVN, FX, settlements, bulk transfers | **Not supported** | Some serializers exist; routes do not. |

## What is faithful, and deliberately so

**The step-up flow is real.** Flutterwave's test cards each trigger a specific
authorization model — PIN, 3DS, AVS or NoAuth — and that is the whole point of
their test set, because the step-up a card demands is what an integration
branches on. Each stage here is a real state transition, so the timeline shows
what actually happened rather than a canned response.

**`charge.completed` is sent for failures too.** Flutterwave has no
`charge.failed`; the receiver must read `data.status`. That is a real trap for
an integration that assumes an event name implies success, so the emulator
reproduces it exactly rather than inventing a failure event Flutterwave would
never send.

**The v3 webhook signature is weak, and reproduced anyway.** `verif-hash` is
the merchant's secret hash **verbatim** — there is no HMAC and the body is not
signed. It proves only that the sender knows a shared secret; it cannot detect
tampering or replay. paybox sends exactly that, because a developer who
discovers the property here has learned something true about their production
integration. v4's `flutterwave-signature` (base64 HMAC-SHA256 over the body) is
implemented and tested alongside it.

**Amounts cross the boundary in major units.** Flutterwave sends and returns
decimal major units ("75.50"); the engine only ever sees integer minor units.
Conversion happens once, at the adapter boundary, which is what keeps rounding
out of the domain model. Values are **rounded**, not truncated, so upstream
floating-point arithmetic cannot silently shave a minor unit off every charge.

**Test instruments are Flutterwave's published ones**, transcribed verbatim
from the testing page: thirteen cards, the special OTPs `5548` (wrong) and
`6648` (insufficient funds), and the failing mobile-money number
`233121212121`. These are the numbers a developer already has in their tests.

## Differences from Flutterwave

1. **`client` may be sent unencrypted.** Flutterwave requires direct card
   payloads 3DES-encrypted; paybox accepts that *and* the plain shape, so a
   developer exploring with curl need not hand-encrypt. This is an emulator
   convenience, not Flutterwave behaviour. The encrypted path is the tested one.
2. **The encryption key is 24 characters and generated locally.** 3DES-EDE3
   requires a 24-byte key; `paybox status` prints the one this environment
   uses. A mismatched key is refused with a message naming the key, not a raw
   crypto error.
3. **Transaction ids are hash-derived, not sequential.** Flutterwave's are
   incrementing integers. paybox derives a stable number from the canonical id
   so the same payment always serialises to the same value under a fixed seed;
   a counter would be order-fragile and would trade the project's determinism
   promise for cosmetics.
4. **`app_fee` is 0 and `merchant_fee` is 0.** paybox does not model
   Flutterwave's pricing. `charged_amount` therefore equals `amount`.
5. **`issuer`, `ip` and `device_fingerprint` are placeholders.** The emulator
   cannot know an issuing bank, a client IP, or a device fingerprint, so it
   returns the same shape with an honest placeholder rather than inventing a
   plausible bank name.
6. **No settlements, no FX.** `charged_amount` is never a converted figure;
   paybox does no currency conversion anywhere.
7. **Non-card rails carry no rail-specific payload.** A `bank_transfer` charge
   does not mint a dynamic account number and a `ussd` charge returns no dial
   string, because those shapes are not documented on the pages cited above.
   The charge itself is real and settles by test instrument.
8. **`quarterly` payment plans are refused.** Flutterwave documents a wider
   interval set than the canonical vocabulary carries, and rounding quarterly
   to monthly would bill four times a year instead of once a quarter. The
   other five map cleanly (`yearly` becomes `annually`).
9. **A card token is derived from the instrument and the customer**, so the
   same card yields the same token under a fixed seed, and two customers who
   share a card get two tokens — a stored instrument belongs to a customer.
   Only cards mint one; mobile money does not, because the customer has to
   approve every prompt on their handset.
10. **One virtual account per customer.** Asking twice returns the existing
   one rather than minting a second, which is what a provider does.
11. **Only `charge.completed`, `transfer.completed`, `subscription.cancelled`
   and `chargeback.created` are emitted.** Nothing is sent for in-flight
   states: Flutterwave notifies on completion, not on progress, and a developer
   waiting for a `charge.processing` that never arrives would be debugging the
   emulator's invention.

## v4 specifics

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v4/oauth/token` | **Partially compatible** | Served here, not on a separate IdP host; see below. |
| `POST /v4/customers`, `GET /v4/customers/{id}` | **Partially compatible** | No update, list or delete. |
| `POST /v4/payment-methods`, `GET /v4/payment-methods/{id}` | **Partially compatible** | `type: card` only. |
| `POST /v4/charges` | **Compatible** | Driven by `X-Scenario-Key`. |
| `PUT /v4/charges/{id}` | **Compatible** | Supplies the authorization. |
| `GET /v4/charges/{id}` | **Compatible** | |
| `POST /v4/charges/{id}/refund` | **Compatible** | |
| `POST /v4/transfers` | **Partially compatible** | Scenario-driven; no destination resolution. |
| `GET /flutterwave/v4/redirect/{ref}` | **Emulator-only** | The page `next_action.redirect_url` points at. |

**`X-Scenario-Key` is implemented in full.** v4 replaces v3's test-card table
with a header naming the flow and the issuer's answer:
`scenario:auth_pin&issuer:insufficient_funds`. All four card scenarios
(`auth_pin`, `auth_pin_3ds`, `auth_3ds`, `auth_avs`), all 45 published issuer
responses, and all five transfer scenarios are honoured. `auth_pin_3ds` steps
up **twice** — a PIN, then a redirect — because that failover is the case the
scenario exists to test. An unrecognised key parks the charge at `pending`,
which is what Flutterwave documents, rather than being treated as approved: a
typo must not turn a failure test into a false pass.

**Token expiry is real.** v4 tokens live 600 seconds, and paybox enforces it
against virtual time — so `time advance 11m` invalidates one. This is a failure
mode v3 integrations never had, and one better met under a time advance than
ten minutes after a deploy. Tokens are held in memory and do not survive a
restart, because a token is a session, not a record.

Four differences from v4 specifically:

1. **The token endpoint is served under the same base**, not on
   `idp.flutterwave.com`, so a client changes one URL rather than two.
2. **The access token is deterministic**, derived from the credentials and the
   issue instant so a fixed seed reproduces it. It is opaque, like a real one,
   but it is not a JWT and is not a credential.
3. **Per-field card encryption is optional.** v4 encrypts card numbers and PINs
   with a nonce; paybox accepts the plain field too, so a developer exploring
   with curl need not hand-encrypt. Only masked fragments are ever stored.
4. **No customer list, update or delete**, and no destination resolution on
   transfers.

## Safety

No live key is ever accepted: `FLWSECK-…` and `FLWPUBK-…` are refused with HTTP
403 and that is not configurable. Card numbers are masked to a BIN and a last
four at the API boundary and the PAN is discarded; the CVV is never read into
the domain model at all (spec §29).

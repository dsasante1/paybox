# Flutterwave coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

## Which API

Flutterwave ships **two live APIs** with different authentication, envelopes
and webhook signatures. paybox implements **v3** today — the one the
overwhelming majority of deployed integrations use, and the one paybox's
premise (point an *existing* integration at localhost) is about. v4 support is
partial: its webhook signature scheme is implemented and tested, the rest is
not.

|              | v3 (implemented)                        | v4 (partial)                          |
| ------------ | --------------------------------------- | ------------------------------------- |
| Base path    | `/flutterwave/v3`                       | not served                            |
| Auth         | `Bearer FLWSECK_TEST-…`                 | OAuth2 client credentials             |
| Envelope     | `{status:"success", message, data}`     | `{status:"failed", error:{…}}`        |
| Webhook      | `verif-hash` — the secret verbatim      | `flutterwave-signature` — base64 HMAC |

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
| Payment plans, subscriptions, subaccounts, virtual accounts, chargebacks, bill payments, BVN, FX | **Not supported** | Serializers exist; routes do not. |

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
8. **Only `charge.completed`, `transfer.completed`, `subscription.cancelled`
   and `chargeback.created` are emitted.** Nothing is sent for in-flight
   states: Flutterwave notifies on completion, not on progress, and a developer
   waiting for a `charge.processing` that never arrives would be debugging the
   emulator's invention.

## Safety

No live key is ever accepted: `FLWSECK-…` and `FLWPUBK-…` are refused with HTTP
403 and that is not configurable. Card numbers are masked to a BIN and a last
four at the API boundary and the PAN is discarded; the CVV is never read into
the domain model at all (spec §29).

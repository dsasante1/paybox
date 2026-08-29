# Kora coverage

This file is a **contract, not marketing**. It says exactly what the emulator
implements, what it does differently, and what it does not do at all. If
something is missing from here, assume it is not implemented.

Every shape below was verified against the **Kora Public APIs** Postman
collection (`docs.korapay.com`, collection `303979/SVzxXeSM`) and the guides at
`developers.korapay.com/docs`, both read **2026-08-29**.

Base path: `/kora/merchant/api/v1` — the `merchant/api/v1` segment is part of
Kora's own published URLs, so an existing client's paths work unchanged.

## Endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /charges/initialize` | **Compatible** | Returns a `checkout_url`. |
| `POST /charges/card` | **Partially compatible** | Encrypted or plain; see below. |
| `POST /charges/card/authorize` | **Compatible** | |
| `POST /charges/card/resend-otp` | **Partially compatible** | Echoes the charge; no new token is generated. |
| `POST /charges/bank-transfer` | **Compatible** | Mints a synthetic virtual account that expires. |
| `POST /charges/mobile-money` | **Compatible** | Three-call flow: charge, OTP, STK prompt. |
| `POST /charges/mobile-money/authorize` | **Compatible** | |
| `POST /charges/mobile-money/sandbox/authorize-stk` | **Compatible** | Kora's own sandbox endpoint. |
| `GET /charges/{reference}` | **Compatible** | Merchant reference or `KPY-CA-…`. |
| `POST /refunds/initiate` | **Compatible** | Full and partial. |
| `GET /refunds/{reference}`, `GET /refunds` | **Partially compatible** | No cursor paging. |
| `POST /transactions/disburse` | **Compatible** | Bank account and mobile money. |
| `GET /transactions/{reference}` | **Compatible** | |
| `POST /virtual-bank-account` | **Partially compatible** | No KYC or account-holder flow. |
| `GET /virtual-bank-account/{reference}` | **Compatible** | |
| `POST /virtual-bank-account/sandbox/credit` | **Compatible** | Kora's own sandbox endpoint. |
| `POST /misc/banks/resolve` | **Partially compatible** | Always resolves to a synthetic test account. |
| `GET /kora/checkout/{reference}` | **Emulator-only** | The hosted page. |
| Bulk payouts, remittance, pool accounts, direct debit, vouchers, stablecoins, pay-with-bank, account holders | **Not supported** | |

## What is faithful, and deliberately so

**The card flow is two calls and mobile money is three.** Kora's card charge
always steps up through an OTP, and its mobile-money charge steps up twice —
an OTP, then an STK prompt on the customer's handset. Both are real state
transitions here, so the timeline shows what actually happened.

**`charge.success` and `charge.failed` are separate events.** Unlike
Flutterwave, which sends `charge.completed` for both and makes you read
`data.status`, Kora lets an integration branch on the event name. That
difference between two providers in the same market is preserved rather than
smoothed over.

**The webhook signature covers only the `data` object.**
`x-korapay-signature` is a hex HMAC-SHA256 of `JSON.stringify(data)` under the
secret key — not of the whole body. This has a consequence worth knowing: the
`event` field is **not covered by the signature**, so a valid `data` object
replayed under a different event name still verifies. paybox reproduces the
scheme exactly, and a test pins that property, because a developer who
discovers it here has learned something true about their production
integration.

**Amounts cross the boundary in major units.** Kora sends numbers and returns
fixed-2 strings; the engine only ever sees integer minor units. Conversion
happens once, at the adapter boundary, and is **rounded** rather than
truncated so upstream floating-point arithmetic cannot silently shave a minor
unit off every charge.

**Two of the sandbox endpoints are Kora's, not paybox's.**
`/charges/mobile-money/sandbox/authorize-stk` and
`/virtual-bank-account/sandbox/credit` are in Kora's published collection,
because an STK prompt appears on a real handset and money into a virtual
account originates with the payer's bank. Neither is an emulator invention.

## Differences from Kora

1. **`charge_data` may be sent unencrypted.** Kora requires card payloads
   AES-encrypted; paybox accepts that *and* the plain shape, so a developer
   exploring with curl need not hand-encrypt. An emulator convenience, not Kora
   behaviour. The encrypted path is the tested one, and a bad payload is
   refused with Kora's own wording.
2. **Encryption is AES-256-GCM as `iv:ciphertext:authTag`, all hex**, matching
   the colon-delimited shape of the collection's sample payloads. The key is
   the secret key, as Kora documents.
3. **Test instruments follow paybox's shared last-four convention**, not a
   Kora-published set: `…0000` succeeds, `…0001` is declined, `…0002` has
   insufficient funds. Kora does not publish a test-card table in the sources
   above, and inventing one would be worse than reusing the convention that
   already works across every provider here.
4. **`fee` and `vat` are always 0.** paybox does not model Kora's pricing, so
   `amount_expected` equals `amount` and `merchant_bears_cost` is echoed rather
   than acted on.
5. **No cursor pagination.** Kora's `starting_after` / `pointer` scheme is not
   implemented; `GET /refunds` always reports `has_more: false`.
6. **`/misc/banks/resolve` always succeeds** and returns a synthetic name. The
   emulator resolves no real account at any real bank (spec §29).
7. **Refund status is `success`, not `completed`.** That is Kora's own
   vocabulary — it differs from Flutterwave's, and the difference is preserved.

## Safety

No live key is ever accepted: `sk_live_…` and `pk_live_…` are refused with HTTP
403 and that is not configurable. Card numbers are masked to a BIN and a last
four at the API boundary and the PAN is discarded; the CVV is never read into
the domain model at all. Every account number the emulator mints is synthetic
and belongs to no bank (spec §29).

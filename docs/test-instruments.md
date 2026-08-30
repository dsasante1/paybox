# Test instruments

How to make a payment succeed, decline, time out or demand a step-up, per
provider. Every number here is synthetic: none is issued by any network and
the cards fail the Luhn check by design. The CVV is never read.

## How an instrument becomes an outcome

When a charge arrives, the adapter resolves the instrument in this order:

1. **`metadata.paybox_outcome`**, where the provider's payload has metadata
   (Paystack). Names the outcome directly — emulator-only.
2. **The provider's own published test instruments**, matched on the full
   number. A number copied out of Paystack's, Stripe's or Flutterwave's
   testing page does what that page says.
3. **paybox's generic convention**: the **last four digits** select the
   outcome. For mobile-money numbers, the last single digit also works.
4. **Anything else succeeds.** An unrecognised number gives you a working
   happy path rather than a confusing decline.

The outcome is then *scheduled* (`payment.simulate`, after
`simulation.autoAdvanceDelayMs`, default 3 s of virtual time) rather than
applied inline, so an integration sees the same asynchronous shape it sees in
production. Under a frozen clock, `paybox time advance 3s` is what makes it
happen. Set `simulation.autoAdvance: false` to schedule nothing and drive every
outcome by hand.

## The generic convention

Works for every provider that has no published table (Kora), and alongside
the published tables everywhere else.

| Last four | Outcome | What happens |
|---|---|---|
| `0000` | `success` | `processing → successful`; `charge.success`-class webhook |
| `0001` | `declined` | `processing → failed`, `card_declined` |
| `0002` | `insufficient_funds` | `processing → failed`, `insufficient_funds` |
| `0003` | `expired_card` | straight to `failed`, `expired_card` |
| `0004` | `authentication_required` | parks at `requires_action` — you must approve (`paybox payment approve`, OTP `123456`, the 3-DS page) |
| `0005` | `authentication_failed` | `requires_action → failed`, `authentication_required` |
| `0006` | `timeout` | parks at `requires_action` and stays there until the payment expires |
| `0007` | `processing_error` | `processing → failed`, `provider_error` |
| `0008` | `customer_rejected` | `requires_action → failed`, `authorization_rejected` |
| `0009` | `network_error` | straight to `failed`, `network_error` |

### Cards (any brand prefix works; these are the ones listed on the checkout pages)

| Number | Brand | Outcome |
|---|---|---|
| `4000 0000 0000 0000` | visa | success |
| `4000 0000 0000 0001` | visa | declined |
| `4000 0000 0000 0002` | visa | insufficient funds |
| `4000 0000 0000 0003` | visa | expired card |
| `4000 0000 0000 0004` | visa | 3-D Secure, then success on approval |
| `4000 0000 0000 0005` | visa | 3-D Secure, then failure |
| `5100 0000 0000 0000` | mastercard | success |
| `5061 0000 0000 0000` | verve | success |

### Mobile money (Ghana networks `mtn`, `vod`, `atl`)

| Number | Network | Outcome |
|---|---|---|
| `0550000000` | mtn | prompt approved |
| `0550000001` | mtn | declined |
| `0550000002` | mtn | insufficient balance |
| `0550000006` | vod | prompt never answered → expires |
| `0550000008` | atl | customer rejects the prompt |

A mobile-money charge always answers `requires_action` first ("approve the
prompt on your phone"); the outcome above is what happens after the
auto-advance delay.

### Naming the outcome directly (Paystack)

USSD carries only a bank code and EFT only a provider name — nothing to encode
a suffix in. Put the outcome in metadata:

```json
{ "email": "dev@example.com", "amount": 40000, "ussd": { "type": "737" },
  "metadata": { "paybox_outcome": "insufficient_funds" } }
```

Accepted values are the outcome names in the table above. An unrecognised
value is ignored, so a stray key in your own metadata cannot break a charge.
**Emulator-only; not Paystack behaviour.**

## Paystack

Everything above, plus Paystack's published set from `/docs/payments/test-payments/`:

| Instrument | Behaviour |
|---|---|
| `4084 0840 8408 4081` | succeeds; mints a reusable authorization |
| `5192 6027 2058 4796` | succeeds (bank auth simulation) |
| `5078 5078 5078 5078 12` | parks awaiting a PIN |
| `5060 6666 6666 6666 666` | PIN `1234`, then OTP `123456` |
| `5078 5078 5078 5078 04` | PIN `0000`, phone, then OTP |
| `4084 0800 0000 5408` | declined |
| `5078 5078 5078 5078 53` | fails — token not generated |
| `4084 0800 0067 0037` | fails — insufficient funds |
| `…1803` | charges, then its **refund fails** |
| `…1902` | charges, then its refund goes to **needs-attention** |
| `055 123 498 7` (MTN) | mobile money succeeds |
| `+254 710 000 000` (M-Pesa) | succeeds |
| `070 000 000 0` (Orange CIV) | parks awaiting OTP `1234` |

Step-up answers: **OTP `123456`**, **PIN `1234`** (Orange CIV's OTP is `1234`).
paybox accepts them on *any* parked charge, not only the card Paystack pairs
them with; anything else fails the charge. `submit_pin`, `submit_phone` and
`submit_birthday` answer `send_otp` and leave the charge parked — only
`submit_otp` settles it. See [paystack.md](paystack.md#stored-authorizations).

## Stripe

Stripe's own numbers from `docs.stripe.com/testing`. The generic convention
is *not* used for Stripe's published cards — they match on the full number.

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` | succeeds |
| `4000 0000 0000 0002` | `card_declined` / `generic_decline` |
| `4000 0000 0000 9995` | `card_declined` / `insufficient_funds` |
| `4000 0000 0000 9987` | `card_declined` / `lost_card` |
| `4000 0000 0000 9979` | `card_declined` / `stolen_card` |
| `4000 0000 0000 0069` | `expired_card` |
| `4000 0000 0000 0127` | `incorrect_cvc` |
| `4000 0000 0000 0119` | `processing_error` |
| `4000 0025 0000 3155` | requires 3-D Secure |
| `4000 0000 0000 3220` | requires 3-D Secure 2 |

A declined PaymentIntent returns to `requires_payment_method` and can be
confirmed again on the same id, as at Stripe. `paybox payment create
--provider stripe --method card` uses `4242…`.

## Flutterwave v3

Flutterwave's thirteen published test cards are transcribed verbatim from its
testing page, each triggering the authorization model (PIN, 3DS, AVS, NoAuth)
that page documents, plus:

| Instrument | Behaviour |
|---|---|
| OTP `5548` on `/validate-charge` | wrong OTP |
| OTP `6648` | insufficient funds |
| `233121212121` | the failing mobile-money number |

The generic convention applies to any other number. Card payloads may be sent
3DES-encrypted in `client` (with the encryption key from the banner) or, as an
emulator convenience, in the plain shape.

## Flutterwave v4

No card table. The outcome comes from the **`X-Scenario-Key`** header,
Flutterwave's own mechanism:

```
X-Scenario-Key: scenario:auth_pin&issuer:insufficient_funds
```

All four card scenarios (`auth_pin`, `auth_pin_3ds`, `auth_3ds`, `auth_avs`),
all 45 published issuer responses and all five transfer scenarios are
honoured. An unrecognised key parks the charge at `pending`, which is what
Flutterwave documents.

## Kora

The generic convention: `…0000` succeeds, `…0001` declines, `…0002` has
insufficient funds, and so on. Kora publishes no test-card table in the
sources the adapter was verified against, so none was invented.

Kora's own sandbox endpoints are implemented as published:
`POST /charges/mobile-money/sandbox/authorize-stk` answers the STK prompt and
`POST /virtual-bank-account/sandbox/credit` pays into a virtual account. Card
payloads may be AES-256-GCM encrypted in `charge_data` under the secret key,
or sent plain.

## WeWire

WeWire's published sandbox mobile-money numbers drive deterministic outcomes
and take priority over the generic convention — `0240000001` succeeds,
`0240000002` fails, and the rest follow WeWire's sandbox page. The
`accountCode` must match the number's network. Payouts settle on a
`transfer.settle` job whose outcome is decided at request time.

## Wise

No instruments: nothing at Wise is a card or a phone number. Outcomes are
driven with Wise's own simulation endpoints, implemented as published:

```
GET  /wise/v1/simulation/transfers/{transferId}/{processing|funds_converted|outgoing_payment_sent|bounced_back|funds_refunded}
POST /wise/v1/simulation/balance/topup
```

A funding rejection (insufficient balance, wrong state, reused quote) is a
`201` with `status: REJECTED`, not an HTTP error — exactly as Wise does it.

## Choosing an outcome after the fact

Whatever instrument was used, the control plane can override the result while
the payment is still in flight:

```bash
paybox payment fail pay_… --reason insufficient_funds
paybox payment approve pay_…            # complete a step-up
paybox scenario run late-reversal pay_… # a failure that later becomes a success
```

See [Payment lifecycle](payment-lifecycle.md).

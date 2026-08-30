# Payment lifecycle

The canonical model every provider is mapped onto: which statuses exist, which
transitions are legal, what each CLI action does, and how refunds, transfers,
subscriptions and disputes move. The per-provider vocabulary is in each
contract's "Status mapping" section.

Every mutation goes through one state machine, so the CLI, the dashboard, a
provider endpoint, a scenario step and an expiry job can never disagree about
what is allowed.

## Payments

### Statuses

| Canonical | Meaning | Terminal? |
|---|---|---|
| `created` | exists; nothing attached yet (a Stripe intent with no method) | |
| `pending` | initialized; awaiting an instrument or a checkout | |
| `processing` | the provider is working on it | |
| `requires_action` | the payer must do something: approve a prompt, enter an OTP, complete 3-DS | |
| `authorized` | funds held, not captured (Stripe's `requires_capture`) | |
| `successful` | money collected | settled |
| `partially_refunded` | some of it sent back | settled |
| `refunded` | all of it sent back | **yes** |
| `failed` | the last attempt failed | **yes** (see escape hatches) |
| `cancelled` | stopped by the merchant or the payer | **yes** |
| `expired` | not completed in time | **yes** |

"Settled" statuses are not terminal — a refund can still follow — but a
scenario's outcome and action steps skip a settled payment.

### Transitions

```
created ──▶ pending ──▶ processing ──┬──▶ successful ──▶ partially_refunded ──▶ refunded
   │           │            │        │
   │           ├──▶ requires_action ─┤──▶ failed
   │           │        │            │
   │           └──▶ authorized ──────┘   (capture = authorized → processing → successful;
   │                    │                 void   = authorized → cancelled)
   └───────────────────┴──▶ cancelled / expired
```

| From | May go to |
|---|---|
| `created` | `pending`, `processing`, `requires_action`, `failed`, `cancelled`, `expired` |
| `pending` | `processing`, `requires_action`, `authorized`, `successful`, `failed`, `cancelled`, `expired` |
| `processing` | `requires_action`, `authorized`, `successful`, `failed`, `expired` |
| `requires_action` | `processing`, `authorized`, `successful`, `failed`, `cancelled`, `expired` |
| `authorized` | `processing`, `successful`, `failed`, `cancelled`, `expired` |
| `successful` | `partially_refunded`, `refunded` |
| `partially_refunded` | `partially_refunded`, `refunded` |
| `failed`, `cancelled`, `expired`, `refunded` | nothing |

A refused transition is `invalid_state_transition` — HTTP 409 on `/api`, and
the provider's own error shape on a provider route — with `details.allowed`
listing what would have been legal.

### Escape hatches

| Flag | Allows | Who uses it |
|---|---|---|
| reversal | any terminal state → anything | a scenario `status:` step landing on a terminal payment (`late-reversal`) |
| retry | `failed` → `pending` / `processing` / `requires_action` | Stripe's `confirm` on a declined intent, whose failure is never final |

Neither is reachable from an ordinary API call. Canonical `failed` therefore
means "the last attempt failed"; the attempt history is in the event log.

### Outcomes

`paybox payment success|fail`, `POST /api/payments/:id/simulate`, a test
instrument's auto-advance and a scenario `outcome:` step all apply one of
these plans. Every hop is a real transition with its own event.

| Outcome | Path | `failureCode` |
|---|---|---|
| `success` | `processing → successful` | — |
| `declined` | `processing → failed` | `card_declined` |
| `insufficient_funds` | `processing → failed` | `insufficient_funds` |
| `expired_card` | `failed` | `expired_card` |
| `authentication_required` | `requires_action` (and stops) | — |
| `authentication_failed` | `requires_action → failed` | `authentication_required` |
| `timeout` | `requires_action` (and stops; expiry ends it) | — |
| `processing_error` | `processing → failed` | `provider_error` |
| `customer_rejected` | `requires_action → failed` | `authorization_rejected` |
| `network_error` | `failed` | `network_error` |

A hop the payment has already made is skipped, so re-applying `success` to a
payment already `processing` does not fail on a self-transition.
`immediate: true` on the API skips straight to the last hop.

### Actions

| CLI | API | Precondition | Result |
|---|---|---|---|
| `payment approve <id>` | `/authenticate {approved:true}` | `requires_action` | applies `success` |
| `payment reject <id>` | `/authenticate {approved:false}` | `requires_action` | applies `customer_rejected` |
| `payment authorize <id>` | `/authorize` | any state that allows `authorized` | `authorized` |
| `payment capture <id>` | `/capture` | `authorized` | `processing → successful` |
| `payment cancel <id>` | `/cancel` | any non-settled, non-terminal state | `cancelled` |
| `payment expire <id>` | `/expire` | likewise | `expired`, `failureCode: transaction_timeout` |

### Expiry

A payment created with an expiry gets a `payment.expire` job on virtual time
(a mobile-money charge seeded by `paybox seed` expires in ten minutes; a
Stripe Checkout Session in 24 hours). The job only fires on a payment still in
flight — settling it first cancels the job through its `groupKey`. Advancing
past the deadline is the whole test:

```bash
paybox time advance 25h      # an abandoned Stripe checkout → expired, checkout.session.expired
```

## Refunds

```
pending ──▶ processing ──┬──▶ successful
   │            │        └──▶ failed
   │            └──▶ needs_attention ──▶ processing | successful | failed
   └──▶ needs_attention
```

- Amount defaults to what remains; `total refunded ≤ original amount` is
  enforced (`refund_exceeds_amount`).
- On `successful` the payment becomes `partially_refunded` or `refunded` and
  the balance is debited. A `failed` refund leaves the payment as it was —
  the money is still yours.
- **From the control plane** (`paybox payment refund`,
  `POST /api/payments/:id/refund`) a refund settles immediately unless
  `settle: false`.
- **From a provider endpoint** it settles on a `refund.settle` job over virtual
  time, walking `pending → processing → outcome` so the intermediate webhook
  (`refund.processing` at Paystack) actually fires. The outcome comes from the
  instrument behind the payment: Paystack's `…1803` card fails its refund,
  `…1902` sends it to `needs_attention`.
- `needs_attention` is recoverable, not terminal: Paystack's
  `POST /refund/retry_with_customer_details/:id` puts it back on the
  processing path, and returns 422 on a refund that is not in that state.

## Transfers and payouts

```
created ──▶ pending ──▶ processing ──▶ successful ──▶ reversed
   │           │            │
   └───────────┴──▶ cancelled | failed
```

One resource for money leaving a balance, whether to a bank (Paystack
transfer, Stripe payout, Kora disbursement, WeWire payout, Wise transfer) or
to another balance (a Stripe Transfer to a connected account).

- **Reservation happens at creation**: amount plus fee is debited from the
  ledger when the transfer is queued, and a transfer the balance cannot cover
  is refused (`balance_insufficient`, HTTP 400). `failed` and `reversed`
  credit the reservation back — except a failed ZAR Paystack transfer, which
  keeps the fee, as Paystack does.
- **Wise is the exception**: `POST /v1/transfers` reserves nothing; the
  separate funding call debits the balance.
- `cancelled` is only reachable before `processing`, which is exactly the
  race a cancel button has to handle. Paystack has no cancel.
- Settling: `POST /api/transfers/:id/settle {status}` from the control plane;
  WeWire and Wise settle themselves on a `transfer.settle` job or via Wise's
  simulation endpoint; Paystack transfers wait for you.
- Reversals may be partial and are refused once the destination has spent the
  money (Stripe).

### The balance and the ledger

```bash
paybox balance                 # per currency, folded from the ledger
paybox balance credit 500000 --currency GHS
curl localhost:8080/api/balance/ledger
```

| Movement | Direction |
|---|---|
| payment succeeds | credit |
| refund settles | debit |
| transfer created | debit (amount + fee) |
| transfer fails or is reversed | credit |
| `balance credit` / provider funding endpoint | credit |

Each entry has an owner: null for the platform, a subaccount for a marketplace
participant. A transfer between them writes two entries in one transaction.

## Stored authorizations and instrument setups

A successful card charge mints a reusable **authorization** (Paystack's
`AUTH_…`, Stripe's `pm_…`, Flutterwave's card token). Charging the same card
again for the same customer reuses it; two customers sharing a card get two.
Mobile money mints a *non-reusable* one, because the payer must approve every
prompt. Charging a non-reusable or deactivated authorization is refused.

An **instrument setup** (Stripe's SetupIntent) stores an instrument without
moving money:

```
created ──▶ pending ──▶ processing ──┬──▶ successful
   │           │            │        └──▶ failed   (retry: back to an in-flight state)
   │           └──▶ requires_action ──┘
   └──▶ cancelled
```

`paybox authorizations` lists every handle minted, with `reusable` and
`active` flags.

## Subscriptions and invoices

```
trialing ──▶ active ──▶ non_renewing ──▶ completed | cancelled
                │
                ├──▶ attention ──▶ active   (the merchant fixed the instrument)
                └──▶ completed | cancelled
```

- Created through the provider API (`POST /paystack/subscription`,
  `POST /stripe/v1/subscriptions`) against a **reusable** authorization.
- Each renewal is a job that enqueues the next one. Periods use calendar
  arithmetic with day-of-month clamping (31st → 28th in February, back to the
  31st after). `interval_count` is honoured.
- An `invoice.created` event fires ahead of the debit — three days at
  Paystack, one hour at Stripe.
- A failed renewal marks the invoice `failed`, fires `invoice.payment_failed`,
  moves the subscription to `attention`, and **keeps trying** next period. A
  subscription backed by a card that needs a step-up fails every renewal,
  because nobody is present to complete it — that is the dunning scenario.
- `invoice_limit` reached → `completed`. `disable` → `non_renewing`; the
  current period runs out and then it completes.
- Trials are a status: `trialing` bills nothing until `trial_end`, which is
  also the first billing date; Stripe's `trial_will_end` fires three days
  ahead.

Invoices:

```
draft ──▶ pending ──┬──▶ success
  │         │       ├──▶ failed ──▶ success | pending
  │         │       ├──▶ void
  └──▶ void │       └──▶ uncollectible ──▶ success
```

`failed` is not terminal (the invoice is still owed); `success` and `void`
are. Stripe's draft/finalize/pay/void lifecycle maps onto this directly;
Paystack only ever raises `pending` invoices from renewals.

```bash
paybox time advance 365d
paybox subscription get sub_…      # twelve invoices, one calendar month apart
paybox subscription list --status attention
```

## Disputes

```
awaiting_merchant_feedback ──▶ awaiting_bank_feedback ──▶ resolved
            │                            │
            └──▶ pending ────────────────┘
```

- Opened with `paybox dispute open <paymentId>` / `POST /api/disputes` /
  `POST /paystack/dispute` — all **emulator-only**, because a chargeback
  originates with the payer's bank. Only a payment that collected money can be
  disputed, for at most its amount.
- The response deadline is seven days, with a `dispute.remind` job a day
  before it that moves the dispute to `awaiting_bank_feedback` and fires
  `charge.dispute.remind`. `paybox time advance 7d` reaches it.
- `merchant-accepted` raises and settles a **real refund** for the disputed
  amount; `declined` closes it with no money moving. `resolved` is terminal —
  a reopened chargeback is a new dispute.

## Dedicated virtual accounts

Minted per customer (`POST /paystack/dedicated_account`,
`POST /flutterwave/v3/virtual-account-numbers`, `POST /kora/…/virtual-bank-account`).
Money arrives through an emulator-only credit
(`POST /api/dedicated-accounts/:number/credit`) or Kora's own sandbox credit,
and the resulting `bank_transfer` payment walks the ordinary state machine —
same events, same `charge.success`.

## Where each provider's vocabulary is

| Provider | Section |
|---|---|
| Paystack | [paystack.md → Status mapping](paystack.md#status-mapping) |
| Stripe | [stripe.md → Status mapping](stripe.md#status-mapping) and Billing |
| Flutterwave | [flutterwave.md](flutterwave.md) (`charge.completed` for success *and* failure) |
| Kora | [kora.md](kora.md) (`charge.success` / `charge.failed` are separate) |
| WeWire | [wewire.md → Webhooks](wewire.md#webhooks) |
| Wise | [wise.md → Webhooks](wise.md#webhooks) (`current_state` on one trigger) |

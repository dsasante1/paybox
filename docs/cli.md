# CLI

The CLI is a thin REST client over the same `/api` the dashboard uses. Anything
one can do, the other can too.

```bash
paybox --url http://127.0.0.1:8080 <command>   # or set PAYBOX_URL
paybox --json <command>                        # raw JSON instead of tables
```

## Lifecycle

```bash
paybox start                       # start the emulator (foreground)
paybox start --port 9000 --freeze  # frozen clock — deterministic runs
paybox start --seed ci-run-1       # identical seed ⇒ identical ids
paybox status                      # url, clock, counts, and every test credential issued
paybox reset --yes                 # delete all local state
paybox seed                        # generate representative test data
paybox logs -n 100
paybox jobs                        # the scheduled job queue
paybox provider                    # coverage per provider
```

## Payments

```bash
paybox payment create --amount 25000 --currency GHS --method mobile_money
paybox payment create --amount 10000                  # returns a checkout link
paybox payment create --provider stripe --amount 2000 --currency usd --method card
paybox payment list
paybox payment list --status pending
paybox payment list --provider stripe
paybox payment get order_1                            # id or reference

paybox payment success order_1
paybox payment fail order_1 --reason insufficient_funds
paybox payment cancel order_1
paybox payment expire order_1
paybox payment authorize order_1
paybox payment capture order_1
paybox payment approve order_1     # approve a 3DS / momo prompt
paybox payment reject order_1      # customer declines the prompt

paybox payment refund order_1
paybox payment refund order_1 --amount 5000 --reason "partial return"
```

Failure reasons: `declined`, `insufficient_funds`, `expired_card`,
`authentication_required`, `authentication_failed`, `timeout`,
`processing_error`, `customer_rejected`, `network_error`.

Every one drives the real state machine. `payment success` and a test card that
happens to succeed take the same code path.

`payment create` goes through the provider's own endpoint, so the result is
indistinguishable from one your application created — which means it speaks
each provider's wire format, including Stripe's form encoding. Stripe accepts
`--method card` only; the other methods are Paystack channels.

## Stored authorizations

```bash
paybox authorizations              # every reusable handle a charge has minted
```

Charging a card mints one; charging the same card again reuses it. Only
`reusable` codes can be charged off-session — mobile money never can, because
the payer has to approve each prompt.

## Recurring billing

```bash
paybox plan list
paybox subscription list
paybox subscription list --status attention   # renewals that are failing
paybox subscription get sub_...               # detail plus billing history
paybox subscription disable sub_...
```

Plans and subscriptions are created through the provider API
(`POST /paystack/plan`, `POST /paystack/subscription`); the CLI reads and
controls them. The payoff is virtual time:

```bash
paybox time advance 365d
paybox subscription get sub_...    # a year of renewals, one month apart
```

Each renewal is stamped at the instant it was **due**, not at the end of the
advance — the billing history shows twelve distinct dates, which is the visible
proof that the scheduler runs jobs at their scheduled time.

## Balance

```bash
paybox balance                                  # per currency
paybox balance credit 500000                    # emulator-only test funds
paybox balance credit 500000 --currency GHS
```

The balance is a fold over an append-only ledger. Transfers are refused when it
cannot cover them, which is why `balance credit` exists: it lets a payout test
be set up without first staging a collection. No provider has an equivalent.

## Disputes

```bash
paybox dispute list
paybox dispute open pay_...                     # emulator-only
paybox dispute open pay_... --category fraud --amount 50000
paybox dispute resolve dsp_... --amount 50000   # merchant accepts; refunds
paybox dispute resolve dsp_... --decline
```

Opening a dispute is emulator-only: a chargeback originates with the payer's
bank, so Paystack has no endpoint for it. Accepting one raises and settles a
**real** refund, so the payment moves to `refunded` and the balance is debited
through the ordinary path.

The response deadline is a scheduled job:

```bash
paybox time advance 7d      # fires charge.dispute.remind
```

## Webhooks

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
paybox webhook endpoints
paybox webhook list
paybox webhook list --status exhausted
paybox webhook retry whd_...
paybox webhook replay whd_...
paybox webhook chaos --reset          # turn every chaos setting off
paybox webhook fail http_500 | timeout | connection_refused | off
paybox webhook chaos --duplicate true --out-of-order true --failure-rate 0.2
```

## Time

```bash
paybox time freeze
paybox time advance 30s
paybox time advance 5m
paybox time advance 2h
paybox time unfreeze
```

`advance` runs every job that comes due **before it returns** — webhook retries,
payment expiries, scenario steps. Nothing sleeps. `freeze`, `unfreeze` and
`set` wait the same way, so a `freeze` can never catch the scheduler
mid-job. Virtual time only moves forward: `set` or `freeze` to an instant
earlier than the current one is refused (HTTP 400 from `/api/time`).

## Network

```bash
paybox network latency 3000
paybox network failure 0.25
paybox network reset
```

## Scenarios

```bash
paybox scenario list
paybox scenario run mobile-money-timeout pay_...
paybox time advance 6m        # fast-forward through it
```

## Events

```bash
paybox events
paybox events -n 100
```

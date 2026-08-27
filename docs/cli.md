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
paybox status
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
paybox payment list
paybox payment list --status pending
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

## Webhooks

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
paybox webhook endpoints
paybox webhook list
paybox webhook list --status exhausted
paybox webhook retry whd_...
paybox webhook replay whd_...
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
payment expiries, scenario steps. Nothing sleeps.

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

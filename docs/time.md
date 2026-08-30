# Time control

Everything that would take time at a real provider is a job on a **virtual**
clock you control. This page is the complete account of what that means in
practice.

```bash
paybox time freeze
paybox time advance 30s
paybox time advance 2h
paybox time advance 1.5d
paybox time unfreeze
paybox status                  # shows "clock frozen" or "system"
```

Durations: a number and a unit — `ms`, `s`, `m`, `h`, `d` — decimals allowed.
The same values work in scenario files and in `POST /api/time`.

## Two modes

| Mode | Virtual time… | `advance` does |
|---|---|---|
| `system` (default) | tracks the wall clock plus an offset | shifts the offset; time keeps flowing from the new point |
| `frozen` | is pinned | moves the pin |

Start frozen with `paybox start --freeze` or `PAYBOX_FREEZE_CLOCK=1`; pick the
starting instant with `PAYBOX_START_AT=2026-01-01T00:00:00Z`. `freeze` at
runtime pins the clock at now (or at a later instant you pass to the API);
`unfreeze` resumes from the frozen instant, so time never appears to jump
back.

**Virtual time only moves forward.** `set` or `freeze` to an earlier instant is
refused with HTTP 400. If you need an earlier date, restart with
`PAYBOX_START_AT`.

## What an advance does

`POST /api/time` (and therefore every `paybox time` command):

1. moves the clock;
2. waits for any job already in flight to finish;
3. runs **every job whose `runAt` is now due**, in `runAt` order, each one
   *at the instant it was due* — a retry scheduled for T+4s is stamped T+4s,
   and computes its next attempt from T+4s, however far you advanced;
4. keeps draining, because running jobs enqueues new ones (a failed webhook
   schedules its retry; a renewal schedules the next renewal);
5. returns the new clock state.

So when the command returns, the world is fully caught up. `time advance 365d`
on a monthly subscription yields twelve renewals with twelve correct dates,
and a five-attempt webhook ladder collapses into one call.

A job that is already due — `runAt` at or before virtual now — does not need
an advance: the scheduler polls in real time and picks it up on its next tick,
frozen clock or not. Only *future* jobs wait for you.

## What is on the virtual clock

| Job kind | Scheduled by | Due |
|---|---|---|
| `webhook.deliver` | every event that matches an endpoint; every retry | immediately; then the retry ladder |
| `payment.simulate` | a charge with a test instrument (auto-advance) | `simulation.autoAdvanceDelayMs` later (3 s) |
| `payment.expire` | a payment created with an expiry | its `expiresAt` |
| `refund.settle` | a refund raised through a provider endpoint | shortly after |
| `transfer.settle` | a WeWire payout | shortly after |
| `scenario.step` | `paybox scenario run` | each step's cumulative delay |
| `subscription.charge` | every renewal (each one enqueues the next) | `nextPaymentDate` |
| `subscription.invoice` | the same renewal | the lead time before it — 3 days at Paystack, 1 hour at Stripe |
| `subscription.trial_ending` | a Stripe trial | 3 days before `trial_end` |
| `dispute.remind` | opening a dispute | a day before the seven-day deadline |

`paybox jobs` shows the queue with each job's `runAt`; `GET /api/jobs?status=ready`
lists what is waiting.

Other things that expire or age on virtual time without a job of their own:
Flutterwave v4 access tokens (600 s), Wise quotes (30 minutes, single use),
Stripe Checkout Sessions (24 h — that one *is* a job), Stripe account links,
and the timestamps inside Stripe and WeWire webhook signatures.

## What is *not* on the virtual clock

Deliberately, because their purpose is to interact with your real process:

- **`paybox network latency <ms>`** holds provider responses open for real
  milliseconds — so a webhook can reach your app before the API call that
  caused it returns.
- **`webhooks.timeoutMs`** is a real socket timeout on delivery.
- The scheduler's polling tick, the SSE stream, and HTTP itself.

## The retry ladder, concretely

Default policy: five attempts, delays 1 s → 2 s → 4 s → 8 s each multiplied by
a seeded jitter in [0.5, 1], capped at an hour. Worst case the whole ladder
finishes 15 s after the first attempt:

```bash
paybox webhook fail http_500
paybox payment success order_1     # attempt 1 fails at T
paybox time advance 30s            # attempts 2–5 run at their own due instants
paybox webhook list --status exhausted
paybox webhook fail off
paybox webhook retry whd_…         # one more attempt, now
```

With `webhooks.retry.schedule: paystack` the ladder is ten attempts an hour
apart — `paybox time advance 12h`.

## Signatures that carry a timestamp

Stripe signs `${timestamp}.${body}` and WeWire signs `{id}.{timestamp}.{body}`;
both verifiers reject anything more than five minutes old. paybox therefore
**re-signs those two on every attempt** with the virtual instant of that
attempt, so a retry after `time advance 10m` carries a fresh signature.

The corollary for your verifier: its idea of "now" must agree with paybox's.
Under a frozen or advanced clock, a verifier that reads the wall clock will
reject a perfectly good signature as stale. Either keep the clock flowing for
those providers, pass the emulator's `now` (from `GET /api/time`) into your
verifier in tests, or widen the tolerance in test configuration. Paystack,
Flutterwave, Kora and Wise sign the body alone and are unaffected.

## Auto-advance under a frozen clock

The single most common surprise. A charge with a test instrument schedules
its outcome three seconds ahead *on virtual time*. Frozen, it sits at
`requires_action` (mobile money) or `pending` until you advance:

```bash
paybox payment create --method mobile_money --reference momo_1
paybox payment get momo_1          # requires_action
paybox time advance 3s
paybox payment get momo_1          # successful
```

Or turn auto-advance off and drive every transition explicitly.

## Determinism recipe

```bash
PAYBOX_DATABASE=:memory: \
PAYBOX_FREEZE_CLOCK=1 \
PAYBOX_START_AT=2026-01-01T00:00:00Z \
PAYBOX_SEED=my-suite \
paybox start
```

With the clock frozen at a known instant and a fixed seed:

- every `createdAt`, `expiresAt`, `nextPaymentDate`, `nextRetryAt` is a value
  you can assert literally;
- every id and generated reference is stable across runs;
- retry jitter is stable, so `nextRetryAt` is too;
- the sequence numbers on events are gapless, so ordering is total even when
  every timestamp is identical.

What varies is only what you make vary: the order and number of operations.
[Testing with paybox](testing.md) shows this inside a test suite.

## The API

```bash
curl -X POST localhost:8080/api/time -H 'content-type: application/json' \
  -d '{"action":"advance","value":"2h"}'
curl -X POST localhost:8080/api/time -H 'content-type: application/json' \
  -d '{"action":"set","value":"2026-06-01T00:00:00Z"}'
curl localhost:8080/api/time
```

`set` has no CLI command; `freeze` with an explicit instant likewise. Both
return the clock state after draining, or 400 for a backwards move.

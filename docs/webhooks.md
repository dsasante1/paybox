# Webhooks

Webhooks are the part of a payment integration most likely to be wrong in
production, because they are the part hardest to exercise locally. This is what
paybox does about that.

## Register an endpoint

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
#  ✓ http://localhost:3000/webhooks/paystack
#    signing secret  sk_test_local_a1b2c3...
```

An endpoint with no `eventTypes` receives every event for its provider.

## Verify the signature

Paystack signs with **HMAC-SHA512 over the raw body**, keyed with your secret
key, in `x-paystack-signature`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

app.post('/webhooks/paystack',
  express.raw({ type: 'application/json' }),   // raw bytes, not a parsed object
  (req, res) => {
    const expected = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)                        // Buffer, unmodified
      .digest('hex');
    const got = req.get('x-paystack-signature') ?? '';
    if (expected.length !== got.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
      return res.sendStatus(401);
    }
    const event = JSON.parse(req.body.toString('utf8'));
    res.sendStatus(200);                       // acknowledge first, work later
    queue.add(event);
  });
```

**The single most common cause of signature failures** is hashing a re-serialised
object instead of the bytes that arrived. `JSON.stringify(req.body)` works only
if your framework happens to reproduce the exact bytes. paybox signs the exact
bytes it sends, so if your verification fails here it would fail in production
too — that is the point.

## What gets delivered

| Canonical event | Paystack event |
|---|---|
| `payment.successful` | `charge.success` |
| `refund.successful` | `refund.processed` |
| `transfer.successful` / `.failed` / `.reversed` | `transfer.*` |

**There is no `charge.failed`.** Paystack does not send one. Detect failures by
verifying, not by waiting for a callback.

## Retries

A non-2xx response or a transport error schedules a retry with exponential
backoff and full jitter, up to `webhooks.retry.maxAttempts` (default 5). The
delivery row records every attempt, the HTTP status, the response body, the
duration and the next retry time.

Retries are scheduled on **virtual** time:

```bash
paybox time advance 2h    # runs the entire ladder to exhaustion, instantly
paybox webhook list
```

## Retry vs replay

They are different and the difference matters.

**Retry** re-runs an existing delivery in place: same row, one more attempt.
Use it when your endpoint was down and is now up.

```bash
paybox webhook retry whd_...
```

**Replay** creates a *new* delivery carrying a byte-identical payload and
signature. Your application sees a fresh POST it has already processed once.
This is what a provider's "resend event" button does, and it is the fastest way
to find out whether your handler is idempotent.

```bash
paybox webhook replay whd_...
```

You can also replay from the event, re-formatting and re-signing from scratch:

```bash
curl -X POST localhost:8080/api/events/evt_.../replay
```

## Failure simulation

```bash
paybox webhook fail http_500            # every delivery returns 500
paybox webhook fail timeout             # every delivery times out
paybox webhook fail connection_refused
paybox webhook fail malformed_response  # 200 with a body that is not JSON
paybox webhook fail off

paybox webhook chaos --failure-rate 0.3     # 30% fail, seeded so it reproduces
paybox webhook chaos --duplicate true       # every webhook delivered twice
paybox webhook chaos --out-of-order true    # randomised delivery order
```

Forced outcomes short-circuit before the network, so you do not need a
deliberately broken server to test your retry handling.

## Webhook before API response

The hardest case. Real providers can deliver a webhook before the API call that
created the payment has returned, and integrations that assume ordering break.

```bash
paybox network latency 3000    # hold the API response open for 3s
```

Latency is applied on the **response**, not the request. The webhook fires from
the committed state change while your HTTP client is still waiting.

## Inspecting

The dashboard's Webhooks tab shows every delivery with its attempts, response
body and next retry, with retry and replay buttons. Or:

```bash
paybox webhook list
paybox webhook list --status exhausted
```

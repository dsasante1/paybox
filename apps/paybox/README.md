# paybox-emulator

A local payment infrastructure emulator. Point an existing Paystack, Stripe,
Flutterwave, Kora, WeWire or Wise integration at `localhost` and test the parts
of payments that are hard to test: pending transactions, asynchronous
mobile-money authorization, duplicate webhooks, retries, timeouts, refunds,
idempotency and flaky networks — deterministically, with no provider sandbox.

```bash
npx paybox-emulator start
```

```
  paybox — local payment emulator
  ───────────────────────────────────────────────
  API         http://127.0.0.1:8080
  Dashboard   http://127.0.0.1:8080/dashboard
  API docs    http://127.0.0.1:8080/docs
```

Point your app at it and use it exactly as you would the real API:

```env
PAYSTACK_BASE_URL=http://127.0.0.1:8080/paystack
PAYSTACK_SECRET_KEY=sk_test_local_...        # printed by the banner
```

Then drive the things a sandbox cannot:

```bash
paybox webhook add http://localhost:3000/webhooks/paystack
paybox payment success order_1               # signed charge.success arrives
paybox time advance 2h                       # every retry due in that window fires now
paybox webhook chaos --duplicate true        # does your handler double-credit?
```

**No real money can move through this process.** It has no code path that
reaches a payment network and it refuses live API keys.

Every adapter is **partially** implemented and each one's coverage is a
documented contract, not marketing. Requires Node 22.5 or newer; nothing else.

Full documentation, the coverage tables, the Docker image and the source:
<https://github.com/dsasante1/paybox>.

MIT. Not affiliated with, endorsed by, or connected to any payment provider
named above; the names describe API compatibility only.

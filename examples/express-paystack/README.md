# Express + Paystack against paybox

A complete integration. The only production difference is `PAYSTACK_BASE_URL`.

```bash
# terminal 1
npx paybox-emulator start

# terminal 2  (npm install -g paybox-emulator puts `paybox` on your PATH)
paybox webhook add http://localhost:3000/webhooks/paystack

# terminal 3
npm install
PAYSTACK_SECRET_KEY=sk_test_local_... npm start
```

Open <http://localhost:3000> and buy something.

## What it demonstrates

- Initialize → redirect to checkout → return with `?reference=`
- Signature verification over the **raw** request body
- Acknowledging the webhook before doing work
- Idempotent handling, so a duplicate delivery does not double-fulfil
- Verifying before granting value, rather than trusting the webhook payload

## Things worth breaking

```bash
paybox webhook chaos --duplicate true    # does it double-fulfil?
paybox webhook fail http_500             # then: paybox time advance 2h
paybox webhook replay whd_...            # is your handler idempotent?
paybox network latency 3000              # webhook arrives before the redirect
paybox scenario run late-reversal pay_...  # a failure that becomes a success
```

The last one is the interesting one. This example handles duplicates but does
**not** handle a late reversal — it writes off the failure and never revisits
it. Most real integrations have the same gap.

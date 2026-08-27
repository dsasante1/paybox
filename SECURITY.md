# Security

paybox is a development tool. It is built so that the worst realistic mistake —
pasting a production credential into it — fails loudly instead of quietly.

## What is guaranteed

**No real payment can be made.** There is no code path in this project that
sends a request to a payment provider. The only outbound HTTP the emulator makes
is webhook delivery, to a URL you registered yourself.

**Live API keys are refused.** Any key matching `sk_live_*` or `pk_live_*` is
rejected with HTTP 403 and a message telling you to rotate it. This is not
configurable — `PAYBOX_ALLOW_ANY_KEY` relaxes the *test-key format* check, and
still refuses live keys.

**No real card data is processed or stored.** Card numbers are reduced to a BIN
and last four before anything is persisted. **CVV is never read, never stored,
and does not exist in the data model.** The documented test instruments are
synthetic, fail the Luhn check, and are not issued by any network.

**Loopback by default.** The server binds `127.0.0.1`. Binding anything else
prints a warning at startup that says plainly what the exposure means. Inside a
container the warning is softened, because a container must bind `0.0.0.0` to be
reachable at all.

## What is *not* guaranteed

- **The emulator has no authentication of its own.** Any `sk_test_` value is
  accepted. The control plane at `/api` has no auth at all. It is designed to be
  reachable only from your machine.
- **Do not expose it to the internet.** Anyone who can reach it can create
  payments, mark them successful, and send signed webhooks to any URL. It is a
  development tool, not a service.
- **Webhook URLs are not restricted.** If you register a public URL, the
  emulator will POST to it. That is a feature (tunnels, staging) and a footgun.
- **The database is not encrypted.** It holds test data. Do not put anything
  else in it.

## Reporting a vulnerability

Open an issue describing the impact. Since the tool is local-only by design,
the bar for "vulnerability" is: something that lets paybox affect a system
outside the machine it runs on, or that could cause a real payment credential to
be transmitted, logged, or persisted.

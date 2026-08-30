# Troubleshooting

Symptoms, in roughly the order people meet them. Each answer says what is
happening and what to do.

## Starting

**`paybox: command not found`.** The npm package is `paybox-emulator`
(`paybox` on npm is an unrelated 2013 client for a French gateway). Either
`npx paybox-emulator start`, or `npm install -g paybox-emulator` to get the
`paybox` command. From a clone, `npm run cli -- <command>`.

**"paybox requires Node 22.5 or newer".** Storage uses the built-in
`node:sqlite`. Upgrade Node; there is no native addon to install instead.

**An `ExperimentalWarning` about SQLite on every start.** Node 22 marks
`node:sqlite` experimental; it is stable on Node 24. The published launcher
and the Docker image silence that one warning; `npm start` from a clone
shows it, which is correct.

**`EADDRINUSE` / port already in use.** `paybox start --port 9000` or
`PAYBOX_PORT=9000`, and point the CLI at it with `--url` or `PAYBOX_URL`.

**A security warning about binding `0.0.0.0`.** You asked for a non-loopback
host. Anyone who can reach the port can create and settle payments and fire
signed webhooks at any URL. Inside a container this is expected and the
warning is softened; anywhere else, read [SECURITY.md](../SECURITY.md).

**"Could not reach the emulator at http://127.0.0.1:8080".** The CLI talks to
a running server. Start one, or set `--url` / `PAYBOX_URL` to where it is
(for Docker, the published host port).

## Authentication

**403 "looks like a live … key".** You sent a production credential. The
emulator refuses it, on purpose, and this is not configurable. Rotate the key
if it is real, then use the local one from `paybox status`.

**401 "Expected a test secret key beginning with sk_test_".** The key is not
shaped like a test key for that provider. Formats: Paystack, Kora, WeWire
`sk_test_…`; Stripe `sk_test_…` or `rk_test_…`; Flutterwave v3
`FLWSECK_TEST-…`; Wise `wise_test_local_…`. `PAYBOX_ALLOW_ANY_KEY=1` relaxes
the shape check for key-rotation tests; live keys stay refused.

**401 from WeWire with a Bearer header.** WeWire's key goes in `ww-api-key`,
verbatim, with no prefix. paybox reproduces that rather than accepting both.

**401 from Flutterwave v4 after a while.** v4 tokens live 600 seconds of
*virtual* time, and do not survive a restart. Fetch a new one from
`POST /flutterwave/v4/oauth/token`.

## Payments

**"Amount must be an integer" / the amount is 100× too big or small.** Paystack,
Stripe, WeWire, Wise and the control plane take **minor units** (`10000` =
100.00). Flutterwave and Kora take **major units** on the wire, as those APIs
do, and convert at the boundary.

**A payment is stuck at `pending` or `requires_action`.** Three causes, in
order of likelihood:

1. **The clock is frozen.** A charge with a test instrument schedules its
   outcome 3 s ahead on *virtual* time. `paybox time advance 3s`. (`paybox
   status` shows the clock mode.)
2. **It is waiting for you.** `requires_action` is a 3-D Secure step, an OTP,
   or a mobile-money prompt. `paybox payment approve <id>`, submit the OTP
   (`123456`) or PIN (`1234`), or use the hosted page.
3. **Auto-advance is off** (`simulation.autoAdvance: false`). Drive it:
   `paybox payment success <id>`.

**409 `invalid_state_transition`.** The state machine refused. The message
lists what *would* have been legal, and `details.allowed` carries it
machine-readably. Common cases: capturing a payment that was never
`authorized`; refunding one that has not succeeded; cancelling one that has
settled; approving one that is not in `requires_action`.

**409 / 400 `duplicate_reference`.** A reference is unique per provider —
for payments and for transfers. Use a fresh one or omit the field to have one
generated.

**409 `idempotency_conflict`.** The same `Idempotency-Key` with a different
body. Either the key was reused by mistake, or the body genuinely changed;
both are bugs worth finding here.

**`paybox payment get order_1` says no payment matches, but it exists.** Only
**Paystack** references resolve by name. Address a Stripe, Flutterwave, Kora,
WeWire or Wise payment by its `pay_…` id (`paybox payment list` shows it;
`pi_…` becomes `pay_…` by swapping the prefix).

**`paybox scenario run` says no payment with that id.** Scenarios take the
`pay_…` id, never a reference.

**A transfer is refused for insufficient balance.** The balance is a ledger
fold and a transfer reserves amount *plus fee* when queued. Top it up
(`paybox balance credit`, `POST /wewire/paybox/wallets/credit`, Wise's
`/simulation/balance/topup`), raise `balance.opening`, or set
`balance.enforce: false`. A fresh emulator starts every provider and currency
at 10,000,000 minor units.

**A refund is `needs_attention` and time does not move it.** That is the
point: it needs bank details.
`POST /paystack/refund/retry_with_customer_details/:id`.

**The response says `paybox_code` next to the provider's own code.** WeWire
and Wise responses carry the canonical error alongside the provider's. Your
client can ignore it.

## Webhooks

**Nothing arrives.** Check, in order:

1. `paybox webhook endpoints` — is there an endpoint **for that provider**?
   `paybox webhook add` defaults to `--provider paystack`; a Stripe event
   never reaches a Paystack endpoint.
2. Does the endpoint's `eventTypes` filter exclude the event? Empty means all.
3. `paybox webhook list` — is there a delivery, and what did your server
   answer? `responseStatus`, `responseBody` and `errorMessage` are on the
   row (`--json`).
4. Is the provider one that **sends** that event? Paystack sends no
   `charge.failed`; Flutterwave sends nothing for in-flight states; WeWire
   never sends `transaction.pay_in`. Each contract lists what is emitted.
5. Is the clock frozen with chaos latency or out-of-order delay set? Those
   delays are virtual: `paybox time advance 10s`.
6. From Docker, `localhost` is the container. Use `host.docker.internal`
   ([docker.md](docker.md#reaching-your-application-from-the-container)).
7. `paybox webhook fail off` and `paybox webhook chaos --reset` — a forced
   failure left on makes every delivery fail with no other symptom.

**Signature verification fails.** In production this is nearly always
hashing a re-serialised object instead of the raw bytes; paybox signs the
exact bytes it sends, so it fails here too. Beyond that, per provider:

| Provider | Check |
|---|---|
| Paystack | HMAC-SHA512, hex, keyed with the **secret key**; raw body |
| Stripe | `t=…,v1=…`; HMAC-SHA256 over `${t}.${body}`; the endpoint secret you registered with `--secret`; **timestamp tolerance vs a frozen/advanced clock** |
| Flutterwave v3 | `verif-hash` equals the endpoint secret, verbatim — no HMAC |
| Flutterwave v4 | the server delivers **v3-shaped, `verif-hash`** webhooks for v4 resources too; `flutterwave-signature` (base64 HMAC-SHA256) is implemented but not sent yet |
| Kora | signs `JSON.stringify(body.data)` **only**, hex |
| WeWire | `{id}.{timestamp}.{body}`; key is the **base64-decoded** part after `whsec_`; tolerance vs the clock |
| Wise | RSA-SHA256, base64, against the PEM from `GET /wise/paybox/webhook-public-key` (authenticated) |

And the trap that catches every non-Paystack provider: **the endpoint secret
defaults to the Paystack local key.** Register Stripe, Flutterwave, Kora and
WeWire endpoints with `--secret <what your verifier holds>`.

**A retry never happens.** Retries are jobs on virtual time. Under a frozen
clock, `paybox time advance 30s` runs the default ladder; the `paystack`
schedule needs `12h`. `webhooks.retry.enabled: false` means one attempt only.

**Replay vs retry.** *Retry* re-runs the same delivery row; *replay* creates
a new delivery with the same bytes. If you want to test idempotency, replay.

## Time

**400 "refusing to move virtual time backwards".** `set` and `freeze` only
move forward. Restart with `PAYBOX_START_AT` for an earlier date.

**Timestamps in responses are in the past / the future.** That is virtual
time. `paybox status` and `GET /api/time` show the current instant and the
offset from the wall clock.

**A Stripe or WeWire signature is rejected as too old.** Both carry the
*virtual* timestamp; your verifier compares with the wall clock. Pass a
tolerance, feed it the emulator's `now`, or keep the clock flowing for those
providers. [time.md](time.md#signatures-that-carry-a-timestamp).

**`paybox network latency` seems to ignore `time advance`.** Correct: latency
is real milliseconds, because its purpose is to let a webhook race a real
HTTP response.

## State

**Data from yesterday is still there.** The default database is a file,
`./data/paybox.db` relative to where you started. `paybox reset --yes` empties
it; `--database :memory:` keeps nothing between starts.

**`paybox reset` says to re-run with `--yes`.** It refuses to destroy state
from an interactive terminal without confirmation. In a script (no TTY) it
proceeds without the flag.

**After `paybox reset`, chaos / network / the clock are unchanged.** Reset
empties the database. Chaos and network settings live in memory
(`paybox webhook chaos --reset`, `paybox network reset`); the clock only
moves forward.

**A custom scenario disappeared.** Scenarios registered through
`POST /api/scenarios` live in memory for the life of the process. Register
them again on start, or keep the YAML beside your tests.

**Different ids on every run.** Set `PAYBOX_SEED`. Then keep the *sequence*
of operations the same: the tenth payment always gets the same id, but an
extra payment before it shifts everything after.

## Coverage

**An endpoint returns 404 or `unsupported_operation`.** It is probably not
implemented. `paybox coverage <provider>` lists every route the adapter
serves, and `docs/<provider>.md` says why the gaps are gaps. The README's
endpoint counts are generated from the same manifests and cannot overstate
what exists.

**A field is `null` or a placeholder.** The contract's "Response fields" or
"Differences" section says which fields are accurate, which are approximate
(fees), and which are honest placeholders (an issuing bank the emulator
cannot know).

## Still stuck

`paybox logs -n 200` prints the structured log, `paybox jobs` the queue,
`paybox events` the log. Open an issue with the output of `paybox status`
and, if reproducible, the seed — with a fixed seed the maintainers see
exactly what you saw.

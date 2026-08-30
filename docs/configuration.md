# Configuration

paybox reads, in order of increasing precedence:

1. **built-in defaults** (listed below);
2. **`paybox.yml`** — or `paybox.yaml` — in the current working directory;
3. **environment variables** `PAYBOX_*`;
4. **`paybox start` flags**, which are set as environment variables before the
   config loads, so they win over everything.

When a file is used the startup banner prints `Config <path>`. There is no
`--config` flag; run from the directory that holds the file.

Boolean environment variables accept `1`, `true`, `yes` or `on`
(case-insensitive); anything else is false.

## The complete file, with defaults

```yaml
host: 127.0.0.1          # loopback by default; anything else prints a warning
port: 8080

database:
  path: ./data/paybox.db  # or ":memory:" for a clean slate every start

seed: paybox              # identical seed ⇒ identical ids, tokens, jitter
freezeClock: false        # true pins virtual time until you move it
startAt: null             # initial virtual instant, e.g. 2026-01-01T09:00:00Z

webhooks:
  retry:
    enabled: true
    maxAttempts: 5
    schedule: exponential # or "paystack" — the real ladder, hourly for 10 hours
  timeoutMs: 10000        # real socket timeout per delivery attempt

providers:                # omit a provider to leave it enabled
  paystack:    { enabled: true }
  stripe:      { enabled: true }
  flutterwave: { enabled: true }   # covers both /flutterwave and /flutterwave/v4
  kora:        { enabled: true }
  wewire:      { enabled: true }
  wise:        { enabled: true }

security:
  allowAnyKey: false      # accept keys that are not sk_test_-shaped; live keys still refused

simulation:
  autoAdvance: true       # test instruments play out their outcome on their own
  autoAdvanceDelayMs: 3000

balance:
  enforce: true           # refuse a transfer the balance cannot cover
  opening: 10000000       # opening test float per provider and currency, minor units
  transferFee: {}         # per-currency flat fee override, e.g. { NGN: 2500 }

logLevel: info            # debug | info | warn | error
```

## Reference

| Key | Environment variable | Default | Notes |
|---|---|---|---|
| `host` | `PAYBOX_HOST` | `127.0.0.1` | Binding anything but `127.0.0.1`, `localhost` or `::1` prints a security warning. Inside a container (`PAYBOX_IN_CONTAINER=1`, `/.dockerenv`) the warning is softened. |
| `port` | `PAYBOX_PORT` | `8080` | |
| `database.path` | `PAYBOX_DATABASE` | `./data/paybox.db` | Relative to the working directory; the directory is created if missing. `:memory:` keeps nothing between starts. |
| `seed` | `PAYBOX_SEED` | `paybox` | Any string. Seeds every id, generated reference, local credential, and webhook retry jitter. |
| `freezeClock` | `PAYBOX_FREEZE_CLOCK` | `false` | Start frozen. `paybox time unfreeze` resumes at runtime. |
| `startAt` | `PAYBOX_START_AT` | wall-clock now | ISO-8601 instant. Works frozen or flowing; flowing time simply starts from here. |
| `webhooks.retry.enabled` | `PAYBOX_WEBHOOK_RETRY` | `true` | `false` means one attempt per delivery, then `exhausted`. |
| `webhooks.retry.maxAttempts` | `PAYBOX_WEBHOOK_MAX_ATTEMPTS` | `5` | Ignored when `schedule` is `paystack`. |
| `webhooks.retry.schedule` | `PAYBOX_WEBHOOK_SCHEDULE` | `exponential` | `exponential`: 1 s doubling to a 1 h cap, with jitter in [½, 1]× — five attempts finish inside ~15 s of virtual time. `paystack`: ten attempts an hour apart, Paystack's documented test-mode ladder. |
| `webhooks.timeoutMs` | `PAYBOX_WEBHOOK_TIMEOUT_MS` | `10000` | Real milliseconds. A slow endpoint is recorded as a timed-out attempt. |
| `providers.<id>.enabled` | — | `true` | File only. `false` unregisters that adapter's routes entirely. `flutterwave` covers v3 and v4 together. |
| `security.allowAnyKey` | `PAYBOX_ALLOW_ANY_KEY` | `false` | Relaxes the *test-key format* check so a key-rotation flow can be exercised. `sk_live_*`, `FLWSECK-*`, JWT-shaped Wise tokens and the rest are still refused with 403. |
| `simulation.autoAdvance` | `PAYBOX_AUTO_ADVANCE` | `true` | `false`: no charge moves unless you move it (CLI, dashboard, `/api`, scenario). |
| `simulation.autoAdvanceDelayMs` | `PAYBOX_AUTO_ADVANCE_MS` | `3000` | Virtual milliseconds between a charge and its instrument's outcome. Under a frozen clock this is how far you must `time advance`. |
| `balance.enforce` | `PAYBOX_ENFORCE_BALANCE` | `true` | `false` lets any transfer through regardless of balance. |
| `balance.opening` | `PAYBOX_OPENING_BALANCE` | `10000000` | Applies to every provider and currency. Not a ledger row: `paybox reset` leaves it alone. `0` starts empty. |
| `balance.transferFee` | — | `{}` | File only. A currency listed here replaces Paystack's published tiered schedule outright with a flat fee in minor units. |
| `logLevel` | `PAYBOX_LOG_LEVEL` | `info` | Structured JSON lines on stdout; `paybox logs` reads the in-memory ring buffer. |

Two variables are not config keys:

| Variable | Used by | Effect |
|---|---|---|
| `PAYBOX_URL` | the CLI | Base URL of the emulator to talk to; `--url` overrides it. Default `http://127.0.0.1:8080`. |
| `PAYBOX_IN_CONTAINER` | the server | Set to `1` by the Docker image so binding `0.0.0.0` is reported as informational rather than as a warning. |

## `paybox start` flags

| Flag | Sets |
|---|---|
| `-p, --port <port>` | `PAYBOX_PORT` |
| `-H, --host <host>` | `PAYBOX_HOST` |
| `-d, --database <path>` | `PAYBOX_DATABASE` |
| `--seed <seed>` | `PAYBOX_SEED` |
| `--freeze` | `PAYBOX_FREEZE_CLOCK=1` |

Everything else is file or environment only.

## What is *not* configurable

- **Live-key refusal.** No setting accepts a production credential.
- **The bind address warning.** It can be softened for containers, not removed.
- **Provider behaviour.** Fees, status vocabularies, webhook schemes and
  retry ladders are transcribed from each provider's documentation. The one
  knob — `balance.transferFee` — exists because negotiated rates genuinely
  differ per merchant.

## Recipes

### Deterministic, for CI

```bash
PAYBOX_DATABASE=:memory: \
PAYBOX_FREEZE_CLOCK=1 \
PAYBOX_START_AT=2026-01-01T00:00:00Z \
PAYBOX_SEED=$CI_JOB_ID \
npx paybox-emulator start
```

Every id, timestamp and retry delay is now reproducible for that seed. Drive
time with `paybox time advance`. See [Testing with paybox](testing.md).

### Watch the real Paystack retry ladder

```yaml
freezeClock: true
webhooks:
  retry:
    schedule: paystack
```

```bash
paybox webhook fail http_500
paybox payment success order_1
paybox time advance 12h        # ten hourly attempts, then exhausted
paybox webhook list
```

### Start with no money

```yaml
balance:
  opening: 0
```

The first transfer on every provider is refused for insufficient balance;
`paybox balance credit` (Paystack), `POST /wewire/paybox/wallets/credit`
(WeWire) or Wise's own `POST /v1/simulation/balance/topup` stage exactly the
balance a test needs.

### Drive every transition by hand

```yaml
simulation:
  autoAdvance: false
```

No charge settles until you say so — `paybox payment success`, `approve`,
`fail --reason …`, the dashboard, or a scenario. Useful when a test wants to
assert the *intermediate* state a real integration polls through.

### Expose it to another machine

```bash
paybox start --host 0.0.0.0
```

The banner warns that anyone who can reach the port can create and settle
payments and fire signed webhooks at any URL. Read [SECURITY.md](../SECURITY.md)
before doing this on a shared network.

### Persist or don't

The default database is a file under `./data/`, so payments, endpoints and
scheduled jobs survive a restart — a scenario mid-run resumes where it was.
`paybox reset --yes` empties it. `:memory:` is the right choice for a test
suite; a file is the right choice while you are exploring.

Three things live only in memory regardless of the database: webhook chaos
and network settings, Flutterwave v4 access tokens, and scenarios registered
through `POST /api/scenarios`. A restart clears them; `paybox reset` does not.

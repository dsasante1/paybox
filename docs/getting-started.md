# Getting started

## Requirements

Node 22.5 or newer. Nothing else — no database server, no Redis, no compiler.

## Install and run

```bash
npm install
npm start
```

The banner prints your API URL, dashboard URL, and a generated local test key
pair. The keys are regenerated on each start and are not real credentials.

## Point your application at it

```env
PAYSTACK_BASE_URL=http://127.0.0.1:8080/paystack
PAYSTACK_SECRET_KEY=sk_test_local_...
```

If your code builds URLs from a constant rather than an env var, that constant
is the one line you need to change. If you use an SDK with a hardcoded host, see
[Provider SDKs](#provider-sdks) below.

## Configuration

`paybox.yml` in the working directory, or environment variables. Environment
wins.

```yaml
host: 127.0.0.1      # loopback by default; see SECURITY.md
port: 8080

database:
  path: ./data/paybox.db    # or :memory:

seed: paybox         # identical seed ⇒ identical ids and jitter
freezeClock: false   # true is what you want in CI
startAt: null        # e.g. 2026-01-01T09:00:00Z

webhooks:
  retry:
    enabled: true
    maxAttempts: 5
  timeoutMs: 10000

providers:
  paystack:
    enabled: true

security:
  allowAnyKey: false  # live keys are refused regardless

simulation:
  autoAdvance: true       # test instruments play out their outcome
  autoAdvanceDelayMs: 3000
```

| Variable | Effect |
|---|---|
| `PAYBOX_HOST` / `PAYBOX_PORT` | Bind address |
| `PAYBOX_DATABASE` | SQLite path, or `:memory:` |
| `PAYBOX_SEED` | PRNG seed |
| `PAYBOX_FREEZE_CLOCK` | Start with the clock frozen |
| `PAYBOX_START_AT` | Initial virtual time |
| `PAYBOX_ALLOW_ANY_KEY` | Relax the test-key format check |
| `PAYBOX_AUTO_ADVANCE` | Turn off automatic outcome playback |
| `PAYBOX_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Using it in CI

```bash
PAYBOX_DATABASE=:memory: \
PAYBOX_FREEZE_CLOCK=1 \
PAYBOX_START_AT=2026-01-01T00:00:00Z \
PAYBOX_SEED=$CI_JOB_ID \
paybox start &
```

A frozen clock plus a fixed seed makes every id, timestamp and jitter value
reproducible, so tests can assert exact values instead of matching patterns.
Drive time forward explicitly with `paybox time advance`.

## Provider SDKs

Three tiers, in order of preference:

1. **Base URL from config** — most Paystack integrations build requests against
   a constant or an env var. Change it. Done.
2. **SDK option** — some SDKs expose a host/base-URL setting.
3. **Transport interception** — for SDKs with a hardcoded host, and for
   non-Node languages. Not yet implemented; see the roadmap in the README.

## Persistence

State survives restarts when `database.path` is a file. `paybox reset --yes`
clears it. Use `:memory:` for a clean slate every run.

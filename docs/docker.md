# Docker

```bash
docker compose -f docker/docker-compose.yml up --build
```

Dashboard at <http://localhost:8080/dashboard>.

Or without compose:

```bash
docker build -f docker/Dockerfile -t paybox .
docker run --rm -p 127.0.0.1:8080:8080 -v paybox-data:/app/data paybox
```

## Reaching your application from the container

A webhook URL of `http://localhost:3000/...` resolves to the *container's* own
localhost, not your machine. Use:

- **Docker Desktop (macOS/Windows):** `http://host.docker.internal:3000`
- **Linux:** run with `--add-host=host.docker.internal:host-gateway`, or put
  your app on the same compose network and use its service name.

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  paybox
```

```bash
paybox webhook add http://host.docker.internal:3000/webhooks/paystack
```

## Binding and the loopback warning

paybox binds `127.0.0.1` by default and warns when it does not. A container
*must* bind `0.0.0.0` to be reachable at all, so the image sets
`PAYBOX_IN_CONTAINER=1`, which softens that warning to an informational note.

The compose file publishes to `127.0.0.1:8080` rather than `0.0.0.0:8080`, so
the emulator is reachable from your machine and not from your network. Change
that deliberately, and read [SECURITY.md](../SECURITY.md) first.

## Persistence

`/app/data` is a volume. Removing it is equivalent to `paybox reset`.

```bash
docker compose -f docker/docker-compose.yml down -v
```

For a clean slate every run, set `PAYBOX_DATABASE=:memory:`.

## CI

```yaml
services:
  paybox:
    image: paybox:local
    env:
      PAYBOX_DATABASE: ":memory:"
      PAYBOX_FREEZE_CLOCK: "1"
      PAYBOX_START_AT: "2026-01-01T00:00:00Z"
      PAYBOX_SEED: "ci"
    ports: ["8080:8080"]
```

A frozen clock and a fixed seed make ids, timestamps and jitter reproducible.
Drive time with `POST /api/time {"action":"advance","value":"30s"}`.

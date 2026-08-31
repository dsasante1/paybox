# Docker

Every release publishes the image to Docker Hub, for `linux/amd64` and
`linux/arm64`:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v paybox-data:/app/data dsasante1/paybox
```

Tags: `latest`, the minor line (`0.2`) and the exact version (`0.2.0`). Pin
one of the last two anywhere reproducibility matters.

The same image, under the same tags, is also pushed to
`ghcr.io/dsasante1/paybox`. Docker Hub rate-limits anonymous pulls per IP;
if a busy CI runner hits that, switch the address and nothing else.

Or with compose, which adds the volume and a restart policy:

```bash
docker compose -f docker/docker-compose.yml up
```

Dashboard at <http://localhost:8080/dashboard>.

## Building from source

```bash
docker build -f docker/Dockerfile -t paybox:local .
docker run --rm -p 127.0.0.1:8080:8080 paybox:local
```

The Dockerfile bundles the TypeScript sources with `scripts/build.mjs`,
installs that bundle's production dependencies, and copies only those two
things into the runtime stage: no source tree, no devDependencies, no
compiler. It is the same artifact `npx paybox-emulator` installs, started by
the same launcher.

## The CLI inside the container

The `paybox` command is on the image's PATH and talks to the server over the
container's own loopback:

```bash
docker exec <container> paybox status
docker exec <container> paybox time advance 2h
```

From the host, point a CLI at the published port instead:
`npx paybox-emulator --url http://127.0.0.1:8080 status`.

## Reaching your application from the container

A webhook URL of `http://localhost:3000/...` resolves to the *container's* own
localhost, not your machine. Use:

- **Docker Desktop (macOS/Windows):** `http://host.docker.internal:3000`
- **Linux:** run with `--add-host=host.docker.internal:host-gateway`, or put
  your app on the same compose network and use its service name.

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  dsasante1/paybox
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
    image: dsasante1/paybox:0.2
    env:
      PAYBOX_DATABASE: ":memory:"
      PAYBOX_FREEZE_CLOCK: "1"
      PAYBOX_START_AT: "2026-01-01T00:00:00Z"
      PAYBOX_SEED: "ci"
    ports: ["8080:8080"]
```

A frozen clock and a fixed seed make ids, timestamps and jitter reproducible.
Drive time with `POST /api/time {"action":"advance","value":"30s"}`.

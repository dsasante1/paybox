# syntax=docker/dockerfile:1

# Three stages, and the source tree never reaches the runtime image.
#
#   build    bundles apps/paybox from the TypeScript sources (scripts/build.mjs)
#   deps     installs the production dependencies that bundle imports
#   runtime  the bundle, those dependencies, Node -- nothing else
#
# `build` runs on the build machine's own architecture ($BUILDPLATFORM): esbuild
# is native code, and running it under QEMU to produce the arm64 image would be
# slow for no benefit, since its output is platform-independent JavaScript.
# `deps` runs on the *target* platform, so a dependency that ships an optional
# native binary gets the right one. None of the current ones do; the stage
# should not need revisiting if that changes.
#
# Node 22.5+ is the floor: storage uses the built-in node:sqlite, so the image
# needs no compiler, no node-gyp and no prebuilt addon.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine AS deps
WORKDIR /app
# The whole tree rather than a list of package.json files: npm needs every
# workspace manifest present to reconcile the lockfile, and a hand-maintained
# COPY list went stale once already -- it stopped at one provider of five and
# the image could not have booted. .dockerignore keeps the context small.
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --workspace apps/paybox

FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user. The data directory is the only writable path needed.
RUN addgroup -S paybox && adduser -S -G paybox paybox \
 && mkdir -p /app/data && chown -R paybox:paybox /app

COPY --from=deps  --chown=paybox:paybox /app/node_modules ./node_modules
COPY --from=build --chown=paybox:paybox /app/apps/paybox  ./apps/paybox

USER paybox

# A container must bind 0.0.0.0 to be reachable from the host. PAYBOX_IN_CONTAINER
# tells the startup check this is deliberate, so the loopback warning is
# softened to an informational note rather than shouting on every start.
#
# PATH gains the workspace bin directory so the CLI works from a shell in the
# container: `docker exec <container> paybox time advance 5s`.
ENV PAYBOX_HOST=0.0.0.0 \
    PAYBOX_PORT=8080 \
    PAYBOX_IN_CONTAINER=1 \
    PAYBOX_DATABASE=/app/data/paybox.db \
    NODE_ENV=production \
    PATH="/app/node_modules/.bin:${PATH}"

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The same launcher `npx paybox-emulator` runs. It is what keeps node:sqlite's
# ExperimentalWarning off stderr on Node 22, so no --disable-warning here.
CMD ["node", "apps/paybox/bin/paybox.js", "start"]

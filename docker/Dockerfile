# syntax=docker/dockerfile:1

# Node 22.5+ is required: the storage layer uses the built-in node:sqlite
# module rather than a native addon, so this image needs no compiler and no
# node-gyp fallback.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json        packages/shared/
COPY packages/core/package.json          packages/core/
COPY packages/storage/package.json       packages/storage/
COPY packages/webhooks/package.json      packages/webhooks/
COPY packages/simulator/package.json     packages/simulator/
COPY packages/providers/paystack/package.json packages/providers/paystack/
COPY apps/api/package.json               apps/api/
COPY apps/cli/package.json               apps/cli/
# Dev dependencies are installed deliberately: the image runs TypeScript
# sources directly via tsx, matching the dev loop exactly. Compiling to JS in a
# build stage would shrink the image, but the workspace packages export
# ./src/index.ts, so that means changing every package's exports map. Worth
# doing later; not worth diverging the runtime from the dev loop for now.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user. The data directory is the only writable path needed.
RUN addgroup -S paybox && adduser -S -G paybox paybox \
 && mkdir -p /app/data && chown -R paybox:paybox /app

COPY --from=deps --chown=paybox:paybox /app/node_modules ./node_modules
COPY --chown=paybox:paybox . .

USER paybox

# A container must bind 0.0.0.0 to be reachable from the host. PAYBOX_IN_CONTAINER
# tells the startup check this is deliberate, so the loopback warning is
# softened to an informational note rather than shouting on every start.
ENV PAYBOX_HOST=0.0.0.0 \
    PAYBOX_PORT=8080 \
    PAYBOX_IN_CONTAINER=1 \
    PAYBOX_DATABASE=/app/data/paybox.db \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node:sqlite is stable from Node 24 and experimental on 22, where it prints a
# warning on every start. Suppress just that one category in the container, so
# the banner is readable — not warnings in general.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "apps/api/src/main.ts"]

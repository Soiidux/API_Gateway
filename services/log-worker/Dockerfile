# The log pipeline's CONSUMER side. Runs as a single container (no
# replicas) and does not serve HTTP: it waits on the RabbitMQ
# "api_gateway_logs" queue, drains it in batches, and bulk-inserts log
# rows into Postgres.
#
# Two stages:
#   builder — full toolchain + devDependencies, compiles TypeScript.
#   runtime — production dependencies + dist/ only. No compiler, no test
#             framework, no npm cache. Roughly a third of the size.
#
# Uses `npm ci` (not `npm install`) so the lockfile is authoritative and
# CI/local/prod builds resolve identical dependency trees.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The compiled SQL migrations. NOT optional: PostgresClient.runMigrations()
# reads ./drizzle at boot (migrationsFolder: "./drizzle"), so without this
# folder the worker crashes on startup before it ever consumes a message.
# Only the SQL is needed — drizzle.config.ts is a CLI-time file that
# config.ts does not read.
COPY drizzle ./drizzle

# Drop root. `node` is a built-in non-root user in the official image.
RUN chown -R node:node /app
USER node

# No EXPOSE: this worker has no listening socket (see HEALTHCHECK below).

# This worker serves no HTTP, so an HTTP probe isn't possible. The useful
# invariant is "the process is alive" — if it exits, the container restarts
# via compose's restart policy. A stronger check would expose the AMQP
# connection state over HTTP; that would mean giving the worker a port and
# an endpoint just for this, which isn't worth it here. Documented as a
# known limitation rather than pretending the check is deep.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD pgrep -f "node dist/index.js" || exit 1

# Exec form so PID 1 is node itself and SIGTERM reaches the graceful-shutdown
# handler — which flushes the in-memory batch buffer before exiting, so
# pending log rows are written instead of redelivered.
CMD ["node", "dist/index.js"]
# The user-service image. docker-compose builds the SAME image three
# times, one per replica (user-service-1/2/3), each injecting a different
# INSTANCE_ID so only replica #1 runs the schema migration at boot.
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
# folder the service crashes on startup before it can serve anything.
# Only the SQL is needed — drizzle.config.ts is a CLI-time file that
# config.ts does not read.
COPY drizzle ./drizzle

# Drop root. `node` is a built-in non-root user in the official image.
RUN chown -R node:node /app
USER node

EXPOSE 3001

# Readiness, not liveness: /ready only reports 200 AFTER this replica has
# either applied the migrations (INSTANCE_ID=1) or confirmed the users table
# exists. That is what lets Compose replace blind depends_on — a replica is
# never handed traffic before it can answer it. wget ships with alpine's
# busybox, so no extra package is needed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3001/ready || exit 1

# Exec form so PID 1 is node itself and SIGTERM reaches the graceful-shutdown
# handler directly.
CMD ["node", "dist/index.js"]
# The API gateway: the single entry point (port 3000) that all HTTP
# traffic hits. It validates JWT/RBAC, rate-limits, caches, and proxies
# to the user/payment service replicas.
#
# Two stages:
#   builder — full toolchain + devDependencies, compiles TypeScript.
#   runtime — production dependencies + dist/ only. No compiler, no
#             test framework, no npm cache. Roughly a third of the size.
#
# Uses `npm ci` (not `npm install`) so the lockfile is authoritative and
# CI/local/prod builds resolve identical dependency trees.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
RUN npm ci

# Source + tsconfig, then compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production-only dependency tree, computed in its own stage so the builder's
# TypeScript/bloat never reaches the final image.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output from stage 1 (no source, no tests).
COPY --from=builder /app/dist ./dist

# The gateway owns no tables and runs no migrations, so there is no drizzle/
# folder to ship here — unlike the three services, which do.

# Drop root. `node` is a built-in non-root user in the official image, so no
# useradd is needed and the ownership below must stay consistent with it.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Readiness, not liveness: Compose's depends_on: service_healthy waits on this,
# and /ready only reports 200 once the process is listening. wget ships with
# alpine's busybox, so this needs no extra package.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/ready || exit 1

# Exec form (no npm wrapper) so PID 1 is node itself and SIGTERM reaches it
# directly — which is what lets the graceful-shutdown handler run.
CMD ["node", "dist/index.js"]
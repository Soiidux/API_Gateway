# API Gateway — Microservices Architecture 💂

A Node.js/TypeScript **API Gateway** that fronts two backend microservices (users + payments),
each scaled to **3 replicas**, behind an async logging pipeline that drains HTTP traffic
observability into Postgres. Built as a study project for a Backend/API Engineer role — every
layer is real: HTTP proxying, JWT auth + RBAC, rate limiting, response caching, a fair load
balancer with circuit breakers, database-owning services with migrations, and a RabbitMQ-driven
log consumer.

**One network, five kinds of process** (from `docker-compose.yml`):

```
                         ┌────────────────────────────────────────────────┐
                         │                     gateway                     │
                         │  JWT/RBAC · RateLimit · Cache · validate · LB   │
                         └────────────────────────┬───────────────────────┘
                  ┌────────────────────────────────┼───────────────────────────────┐
                  │                     (proxies to)                                │
                  ▼                      ▼                                          ▼
         ┌──────────────────┐  ┌──────────────────┐                       ┌──────────────────┐
         │ user-service ×3  │  │ payment-service ×3│                       │   log-worker     │
         │ register/login   │  │   deposit/withdraw│                       │  (single)        │
         └───────┬──────────┘  └─────────┬─────────┘                       └────────┬─────────┘
                 │                       │                               (consumes)  │
                 │   ┌──────────┐   ┌────┴──────────┐                              ▼
                 │   │  redis   │   │   postgres    │  ◄══════════════════════  writes logs
                 │   └──────────┘   └───────────────┘   RabbitMQ "api_gateway_logs" queue
                 │        ▲               ▲                    ▲
                 │        │               │                    │
                 │   rateLimit +   users / accounts /   gateway publishes every
                 │   response cache transactions/logs   request event here
```

- **Gateway** — the only publicly exposed HTTP server. Middleware chain per request:
  `RequestLogger → conditionalAuth → RateLimit → Cache → validateBody → selectServer → proxy`.
- **user-service** — owns the `users` table; endpoint for register + login (JWT minting).
- **payment-service** — owns `accounts` + `transactions`; deposit / withdraw / my / getAll.
- **log-worker** — no HTTP; drains the RabbitMQ queue in batches and writes to `logs`.
- **infra** — Postgres 16, Redis 7, RabbitMQ 3 (management UI included).

---

## Tech Stack

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript, Node 20 (ESM, `.js` import suffixes), Express |
| Gateway proxying | `http-proxy-middleware` + `responseInterceptor` |
| Database | PostgreSQL 16 via `drizzle-orm` / `drizzle-kit` (versioned SQL migrations) |
| Cache / rate-limit store | Redis 7 (`ioredis`), token-bucket via atomic Lua script |
| Message queue | RabbitMQ 3 (`amqp-connection-manager`) |
| Auth | `jsonwebtoken` (HS256), `bcryptjs` for password hashing |
| Validation | Zod |
| Tests | Vitest (unit tests, injected fakes — no DB/network needed) |
| Orchestration | Docker Compose |

---

## Repository Layout

```
.
├── docker-compose.yml          # the whole system: 5 infra/service kinds, replicas
├── .env.example                # all configurable secrets/URLs (copy to .env)
├── gateway/                    # the API Gateway (port 3000)
│   ├── Dockerfile
│   └── src/
│       ├── config.ts           # env → typed runtime config
│       ├── index.ts            # express bootstrap: cors → helmet → json → proxy
│       ├── libs/zod.schemas.ts # shared request-body schemas
│       ├── db/redisClient.ts   # shared ioredis connection
│       ├── types/              # ambient types: ApiResponse<T>, Config, ServiceConfig, req.* fields
│       ├── middlewares/
│       │   ├── RequestLogger.ts        # assigns x-request-id, publishes request events
│       │   ├── conditionalAuth.ts      # JWT verify + RBAC (public / roleMap / defaultRoles)
│       │   ├── RateLimitMiddleware.ts  # token-bucket against Redis
│       │   ├── CacheMiddleware.ts      # serve & record cacheable GET responses
│       │   └── validateBody.ts         # zod validation before forwarding
│       └── utils/
│           ├── proxyUtil.ts            # service routing table + proxy setup + error/response hooks
│           ├── loadBalancer.ts         # round-robin across replicas, per-server breaker
│           ├── circuitBreaker.ts       # open/half-open/closed state machine
│           ├── rateLimiter/            # RateLimiter + token-bucket Lua + instances
│           ├── rabbitMq/               # RabbitMqPublisher (log-event producer)
│           ├── getBearerToken.ts
│           ├── generateApiResponse.ts  # standard {data,message,status,success} envelope
│           ├── getServiceUrls.ts
│           └── cacheKey.ts             # cache:userId:method:url
├── services/
│   ├── user-service/          # owns users (port 3001, ×3 replicas)
│   ├── payment-service/       # owns accounts + transactions (port 3002, ×3 replicas)
│   └── log-worker/            # RabbitMQ consumer → batch writes logs
```

---

## Quick Start

```bash
# 1. (optional) configure secrets/URLs — defaults in .env.example work out of the box
cp .env.example .env

# 2. build all images and start the whole stack
docker compose up --build -d

# 3. watch everything come up
docker compose ps
docker compose logs -f gateway            # or user-service-1, payment-service-1, log-worker
```

The first `payment-service-1` / `user-service-1` boot applies the schema migrations
(only `INSTANCE_ID=1` runs DDL — see [Database](#database)); every other replica waits
until the tables exist, so a warm start never races.

> **Local httpbin-style check of the whole pipeline:** hit the gateway, then query the log
> consumer's output — every request you make ends up as a row in `gateway_db.logs`:
> ```bash
> docker exec api_gateway_core sh -c "wget -qO- http://localhost:3000/api/v1/users/getAll" || true
> docker exec gateway_postgres psql -U gateway_user -d gateway_db \
>   -c "SELECT service, method, path, status, latency_ms, user_id FROM logs ORDER BY id DESC LIMIT 5;"
> ```

---

## Environment Variables

All have safe defaults for local dev (`docker-compose.yml`), so `docker compose up` works with
zero configuration. Override any of them in `.env`.

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | gateway / each service | 3000 / 3001 / 3002 | HTTP listen port |
| `JWT_SECRET` | gateway + all services | `gateway_secret_is_super_secure` | HS256 signing secret — **change in prod** |
| `USER_SERVICE_URLS` | gateway | 3 replica URLs | round-robin targets |
| `PAYMENT_SERVICE_URLS` | gateway | 3 replica URLs | round-robin targets |
| `REDIS_URL` | gateway | `redis://gateway_redis:6379` | rate-limit + cache store |
| `RABBITMQ_URL` | gateway, log-worker | `amqp://guest:guest@rabbitmq:5672` | log pipeline transport |
| `DATABASE_URL` | services, log-worker, drizzle | `postgres://…@postgres:5432/gateway_db` | Postgres connection |
| `POSTGRES_USER/PASSWORD/DB` | postgres | `gateway_user / gateway_secure_password / gateway_db` | initial database |
| `RABBITMQ_USER/PASSWORD` | rabbitmq | `guest / guest` | broker credentials |
| `INSTANCE_ID` | services | 1–3 | replica id; `1` owns the migration |
| `RETENTION_DAYS` | log-worker | `30` | delete log rows older than this, at boot + every interval |
| `RETENTION_INTERVAL_HOURS` | log-worker | `6` | how often the retention cleanup re-runs |

---

## API Reference

All responses share the envelope `{ success, message, status, data }`
(see `gateway/src/types/types.d.ts` + `generateApiResponse`, and the identical shape each
service returns). `success` is `status < 400`.

Base URL: `http://localhost:3000`

### Auth model (demo-flow — read the trade-off)

`POST /register` creates the account and returns nothing but the user info.
**It does not return a token.** Tokens are minted exclusively by `POST /login`, with the role
taken from the **DB row** (never from the request body). The gateway verifies the same JWT on
every protected route and re-scopes identity for the backend via `x-user-id` / `x-user-role`
headers — which the backend services re-verify themselves (see [Defense in depth](#defense-in-depth)).

### Scope table

| Method | Path | Auth | Allowed roles | Body validation | Cached |
|---|---|---|---|---|---|
| POST | `/api/v1/users/register`  | public | — | `registerUserSchema` | no |
| POST | `/api/v1/users/login`     | public | — | `loginUserSchema`    | no |
| GET  | `/api/v1/users/getAll`    | JWT   | ADMIN, MANAGER | — | 15 min, per-user |
| POST | `/api/v1/payments/deposit` | JWT   | any valid user | `paymentTxSchema` | no |
| POST | `/api/v1/payments/withdraw`| JWT   | any valid user | `paymentTxSchema` | no |
| GET  | `/api/v1/payments/my`     | JWT   | any valid user | — | 15 min, per-user |
| GET  | `/api/v1/payments/getAll` | JWT   | ADMIN, MANAGER | — | 15 min, per-user |

> **Gotcha:** a service's `defaultRoles` must be the *full* valid set. `conditionalAuth`
> treats an empty required-roles array as "forbid everyone" (`[].includes(role)` is `false`),
> not as "public". This is documented inline in `conditionalAuth.ts` and `proxyUtil.ts`.

---

### Users

#### POST `/api/v1/users/register`
```bash
curl -s -X POST http://localhost:3000/api/v1/users/register \
  -H "Content-Type: application/json" \
  -d '{"userId":"alice","email":"alice@example.com","password":"hunter2","role":"USER"}'
```
```json
// 201
{"success":true,"message":"User created successfully","data":{"userId":"alice","email":"alice@example.com","role":"USER"}}
```
Errors: `400` missing/invalid fields or role, `409` duplicate email/userId (unique constraints
as backstop), `503` DB failure. Password is bcrypt-hashed (10 rounds), never stored/logged.

#### POST `/api/v1/users/login`
```bash
curl -s -X POST http://localhost:3000/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"hunter2"}'
```
```json
{"success":true,"message":"Login successful","data":{"token":"<jwt>"}}
```
`401` for unknown email **or** wrong password (deliberately identical message — no account
enumeration). Token expires in 7 days.

#### GET `/api/v1/users/getAll` — requires `Authorization: Bearer <token>`, ADMIN/MANAGER
Returns all users as `[{ id, email, name, role, createdAt }, …]`.

### Payments

Identity is always taken from the **verified JWT** inside the service (`req.auth.userId`),
never from a header or body. Balances are `numeric(10,2)`.

#### POST `/api/v1/payments/deposit`
> The example uses `jq` to extract the token from the login response.
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"hunter2"}' | jq -r .data.token)

curl -s -X POST http://localhost:3000/api/v1/payments/deposit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"amount":100}'
```
```json
// 201
{"success":true,"message":"Deposit successful","data":{"userId":"alice","balance":100}}
```
- First deposit **auto-creates** the account row (`INSERT … ON CONFLICT` atomic upsert).
- Verifies the user actually exists in user-service's `users` table → `404 User not found`.
- `400` if `amount` ≤ 0 / not a number.

#### POST `/api/v1/payments/withdraw`
```bash
curl -s -X POST http://localhost:3000/api/v1/payments/withdraw \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"amount":30}'
```
```json
// 201
{"success":true,"message":"Withdrawal successful","data":{"userId":"alice","balance":70}}

// 422 — the guard is one atomic statement, so concurrent withdraws can't overspend
{"success":false,"message":"Insufficient balance","status":422,"data":null}
```
The balance check is **not** read-then-write: a single
`UPDATE … SET balance = balance - $1 WHERE user_id = $2 AND balance >= $1` does the check and
the write together. `0` rows updated → `422`.

#### GET `/api/v1/payments/my`
```
{ "data": { "balance": 45, "transactions": [ { "id","userId","type","amount","createdAt" }, … ] } }
```
Only the caller's own account (scoped by `req.auth.userId`).

#### GET `/api/v1/payments/getAll` — ADMIN/MANAGER only
```
{ "data": [ { "userId","balance" }, … ] }
```
Enforced twice: at the gateway (roleMap) **and** re-checked in the service from the JWT.

---

## How The Gateway Works

For each configured service, `setUpProxy` (`gateway/src/utils/proxyUtil.ts`) mounts this chain:

```
RequestLogger → conditionalAuth → RateLimit → Cache → validateBody → selectServer → proxy
```

1. **RequestLogger** — stamps `x-request-id` (reuses caller's if present, else UUID), echoes
   it as a response header, forwards it to the backend, and on `res 'finish'` publishes a
   `{level, service, method, path, status, latencyMs, userId, ip, message}` event.
2. **conditionalAuth** — public routes pass untouched; otherwise requires `Bearer <token>`
   (verifies signature + expiry with `JWT_SECRET`), checks role against `roleMap[route]` or
   `defaultRoles`, stamps `x-user-id` / `x-user-role`, forwards on.
3. **RateLimit** — token bucket in Redis. **Authenticated**: capacity 20, refill 5/s, keyed by
   user. **Anonymous**: capacity 2, refill 1/s, keyed by IP. Breach → `429`, and the event is
   published to the log pipeline.
4. **Cache (only cacheable GETs)** — cache MISS → continue and, on a clean `200`, write the
   body to Redis under `cache:{userId}:{method}:{originalUrl}` with the configured TTL
   (15 min). cache HIT → serve from Redis, skipping the backend entirely. Keys are always
   scoped by `userId` (authenticated) or `anon` (public), so one user's `/my` can never leak
   to another and `/getAll` is safely repeatable per caller. Callers can see which path
   served the response via the `x-cache: HIT|MISS` header.
5. **validateBody** — if the route has a zod `bodySchemas` entry, parse the JSON body; invalid
   → `400` with the joined issues; valid → `req.body` is replaced with the typed result.
6. **selectServer** — asks the service's `RoundRobinLoadBalancer` for the next healthy replica
   (round-robin, skipping any whose circuit breaker is open). No replica healthy → `503`
   immediately instead of a doomed request.
7. **proxy** — `http-proxy-middleware` forwards the request; `handleProxyError` records
   failure on the breaker + publishes an `error` event + `503`s; `handleProxyResponse` records
   success on the breaker and writes the cache entry.

### Load balancing & circuit breaker

`loadBalancer.ts` keeps a `Map<serverUrl, CircuitBreaker>` per service. A breaker is
**closed** by default; after **5 consecutive failures** it trips **open** (blocks that
server, no requests); after a **30 s cooldown** it goes **half-open** (one trial request);
success closes it, failure re-opens it. Every trip-to-OPEN and recovery-to-CLOSED is
published to the log pipeline — watch them live: `docker compose logs -f gateway`.

### Logging pipeline (async, at-least-once)

1. Gateway publishes event objects to RabbitMQ queue `api_gateway_logs` (single shared
   producer connection in `gateway/src/utils/rabbitMq/`).
2. `log-worker` consumes, buffers in-memory, and bulk-inserts: flush when **50** messages
   queued **or** every **3 s** (whichever first) — so Postgres sees batched writes, not one
   per request.
3. `logs` table rows (`services/log-worker/src/db/schema.ts`) are indexed on `ts`, `status`,
   and `request_id`, so "everything one request did" is a single indexed lookup.
4. A retention job (also run at boot) deletes rows older than `RETENTION_DAYS` (30) every
   `RETENTION_INTERVAL_HOURS` (6), so the table can't grow without bound.

### Defense in depth

Proxy-forwarded headers are forgeable, so every backend route that matters ALSO verifies the
`Authorization` header itself with the shared `JWT_SECRET` (`requireAuth` in each service)
and re-checks roles from the verified claims — never from the `x-user-*` headers. A request
that hits a service container directly (bypassing the gateway) still can't impersonate
anyone.

---

## Database

Three tables owned by three owners, all living in **one** Postgres database (`gateway_db`).
Each service generates and owns **its own** versioned migrations (`drizzle/` folders); a
service only ever runs DDL for its own tables.

| Table | Owner | Notes |
|---|---|---|
| `users` | user-service | `id` PK, `email` unique, `password_hash`, `role` |
| `accounts` | payment-service | `user_id` PK, `balance numeric(10,2)`, auto-created on first deposit |
| `transactions` | payment-service | append-only ledger: `DEPOSIT` / `WITHDRAW`, `amount`, `created_at` |
| `logs` | log-worker | batch-written observability events, 3 indexes |

**Migrations:** `INSTANCE_ID=1` runs schema migrations at boot; replicas 2/3 wait until the
tables exist (`information_schema` poll, 15 s timeout) before serving. Regenerating SQL:

```bash
# in the service folder whose schema you changed:
npm run db:generate   # writes SQL to drizzle/ from src/db/schema.ts
npm run db:migrate    # applies pending migrations (also runs at boot on INSTANCE_ID=1)
drizzle-kit push      # (dev-only shortcut)
```

> Cross-service existence check: payment-service verifies a customer exists via a **raw SQL**
> check against `users` rather than a Drizzle schema mirror, so the payment migrations never
> touch the table user-service owns.

---

## Testing

69 unit tests across 4 packages (Vitest; DB/Redis/RabbitMQ are never needed — tests inject
fakes through the handlers' dependency seams).

```bash
(cd gateway && npm test)                    # 28 tests — middleware, balancer, breaker, cache, auth
(cd services/user-service && npm test)      # 16 tests — register / login handlers
(cd services/payment-service && npm test)   # 17 tests — deposit / withdraw / my / getAll / requireAuth
(cd services/log-worker && npm test)        #  8 tests — batch buffer, retention cleanup

# build check (tsc) — same pattern per package:
(cd gateway && npm run build)
```

---

## Documented Trade-offs & Production Hardening

Deliberate simplifications (all annotated in code), good to bring up in an interview:

1. **Self-assigned roles.** `/register` lets the client pick `ADMIN`/`MANAGER`/`USER`. For a
   demo this is fine; in production roles would come from an admin action or an external IdP.
2. **`JWT_SECRET` is shared** between gateway and services (symmetric HS256). A real system
   would use asymmetric keys (RS256) so services only validate with the public key.
3. **Single database.** True separation would give each microservice its own Postgres; the
   migration-ownership pattern here (one service per schema, migrations only from instance #1)
   already models how it would work per-database.
4. **At-least-once logs.** Batch insertion + manual acks mean a worker crash between consume
   and flush can duplicate rows on restart; acceptable here, worth idempotency keys in prod.
5. **Caching is per-user** for privacy; a coarser TTL/shared cache would trade privacy for
   fewer backend hits.
6. **Rate limits are modest** (anon 2 req/s, authed 20 req/s) — tune via the instances file.

Not yet done (natural next steps, called out as outstanding work):
- **README/CI**: this README; a GitHub Actions workflow (lint + test + build for all 4
  packages, `docker compose build`) would be the natural CI step.
- **Dockerfile hardening**: images run as `root` today and have **no healthchecks**;
  multi-stage builds would slim them significantly.
- **Graceful shutdown / observability** (Prometheus metrics, trace correlation) if the
  project grows.
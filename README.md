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
| Auth | `jsonwebtoken` (HS256, algorithm pinned on verify), `bcryptjs` for password hashing |
| Validation | Zod |
| Tests | Vitest (unit tests, injected fakes — no DB/network needed) |
| Orchestration | Docker Compose |

---

## Repository Layout

```
.
├── docker-compose.yml          # the whole system: 5 infra/service kinds, replicas
├── .env.example                # all configurable secrets/URLs (copy to .env)
├── .github/workflows/ci.yml   # CI: matrix test + docker build + e2e smoke test
├── gateway/                    # the API Gateway (port 3000)
│   ├── Dockerfile              # multi-stage, non-root, HEALTHCHECK
│   └── src/
│       ├── config.ts           # env → typed runtime config
│       ├── index.ts            # express bootstrap: cors → helmet → json → health → proxy
│       ├── health.ts           # liveness (/health) vs readiness (/ready)
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

> **A note on npm versions.** Each package has its own `package-lock.json`, and those
> lockfiles are generated with **npm 10** (the version bundled in `node:20-alpine`).
> npm 10 and npm 12 disagree about optional platform-specific packages such as esbuild,
> so a lockfile written by npm 12 is rejected by `npm ci` inside the image with a
> confusing "out of sync" error. If you ever regenerate one, use npm 10 — e.g.
> `docker run --rm -v "$PWD/services/user-service:/w" -w /w node:20-alpine npm install --package-lock-only`.
> Running a newer npm's `npm install` locally will silently rewrite the lockfile in a form
> the Docker build rejects.

```bash
# 1. (optional) configure secrets/URLs — defaults in .env.example work out of the box
cp .env.example .env

# 2. build all images and start the whole stack
docker compose up --build -d              # add --wait to block until all healthy

# 3. watch everything come up
docker compose ps
docker compose logs -f gateway            # or user-service-1, payment-service-1, log-worker
```

`--wait` blocks until every container reports **healthy**, so the stack is only usable once
each replica has finished (or confirmed) its migrations:

```bash
docker compose up --build -d --wait --wait-timeout 300
```

The first `payment-service-1` / `user-service-1` boot applies the schema migrations
(only `INSTANCE_ID=1` runs DDL — see [Database](#database)); every other replica waits
until the tables exist, and no replica reports ready until its table is there.

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
| `REDIS_URL` | gateway, user-service | `redis://gateway_redis:6379` | gateway: cache + rate limits; user-service: **revocation store** |
| `RABBITMQ_URL` | gateway, log-worker | `amqp://guest:guest@rabbitmq:5672` | log pipeline transport |
| `DATABASE_URL` | services, log-worker, drizzle | `postgres://…@postgres:5432/gateway_db` | Postgres connection |
| `POSTGRES_USER/PASSWORD/DB` | postgres | `gateway_user / gateway_secure_password / gateway_db` | initial database |
| `RABBITMQ_USER/PASSWORD` | rabbitmq | `guest / guest` | broker credentials |
| `INSTANCE_ID` | services | 1–3 | replica id; `1` owns the migration |
| `TOKEN_TTL` | gateway, user-service | `3600` | token lifetime in seconds; also the revocation record's TTL. **Must match across both** |
| `RETENTION_DAYS` | log-worker | `30` | delete log rows older than this, at boot + every interval |
| `RETENTION_INTERVAL_HOURS` | log-worker | `6` | how often the retention cleanup re-runs |
| `NODE_ENV` | all images | `production` | set in the runtime stage; enables npm's production behaviour |

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

Tokens live **1 hour** (`TOKEN_TTL`, default `3600`), and `POST /logout` revokes them. See
[Token revocation](#token-revocation) for why the lifetime is the number that actually matters
and why logout alone wouldn't have been enough.

### Scope table

| Method | Path | Auth | Allowed roles | Body validation | Cached |
|---|---|---|---|---|---|
| POST | `/api/v1/users/register`  | public | — | `registerUserSchema` | no |
| POST | `/api/v1/users/login`     | public | — | `loginUserSchema`    | no |
| POST | `/api/v1/users/logout`    | JWT   | any valid user | — | no |
| GET  | `/api/v1/users/getAll`    | JWT   | ADMIN, MANAGER | — | no (see below) |
| POST | `/api/v1/payments/deposit` | JWT   | any valid user | `paymentTxSchema` | no |
| POST | `/api/v1/payments/withdraw`| JWT   | any valid user | `paymentTxSchema` | no |
| GET  | `/api/v1/payments/my`     | JWT   | any valid user | — | no (see below) |
| GET  | `/api/v1/payments/getAll` | JWT   | ADMIN, MANAGER | — | no (see below) |

> **Why nothing is cached any more.** These routes *were* cached (15 min), and that
> was a correctness bug: nothing invalidated a cache entry on write, so a user who
> deposited 500 was shown a balance of 0 for the rest of the TTL, and brand-new
> accounts were invisible to admins. Invalidation would have been the alternative,
> but `/getAll` is cached per-admin, so invalidating it means tracking who primed
> an entry. Caching correctness-adjacent data you can't invalidate is the wrong
> trade, so the cache is off for these and left in place as a mechanism
> (`CacheMiddleware`, `buildCacheKey`, `cachebleRoutes`) for data that genuinely
> is read-only. The trade-off is written up under Trade-offs below.

### Pagination

All list endpoints are paginated: `?limit=` (default 50, max 200) and `?offset=`. Responses
carry a `pagination` object with `total` so a client can compute how many pages exist:

```bash
curl "http://localhost:3000/api/v1/payments/my?limit=25&offset=50" -H "Authorization: Bearer $TOKEN"
```

```json
{"data":{"balance":30,"transactions":[...],
         "pagination":{"limit":25,"offset":50,"total":137}}}
```

A malformed or oversized `?limit` is handled rather than rejected — `?limit=abc` returns the
default page, `?limit=99999` clamps to 200. A client with a bad page parameter should still
get data.

> **Known limit of OFFSET pagination.** Ordering by a primary key makes each page *deterministic*
> — the same request returns the same rows — but it does **not** make paging safe under concurrent
> writes. A row inserted between two page fetches shifts every later page by one, so a row can
> appear twice or be missed. That's inherent to `OFFSET`, not a flaw in the ordering. The fix is
> **keyset pagination** (`WHERE id > last_seen_id ORDER BY id LIMIT n`), which is immune to
> shifting and — because it needs no total — removes the `COUNT` query entirely. Worth doing on
> `/payments/my`, whose data actually grows without bound.

> **Response shape changed** when pagination was added: `/users/getAll` now returns
> `{ data: { users: [...], pagination: {...} } }` and `/payments/getAll` returns
> `{ data: { accounts: [...], pagination: {...} } }`. Previously each was a bare array.
> A bare array leaves no room to add pagination later without a second breaking change,
> so the break was made explicit now. `/payments/my` is additive — `balance` and
> `transactions` are unchanged, `pagination` was added alongside.

> **Gotcha:** a service's `defaultRoles` must be the *full* valid set. `conditionalAuth`
> treats an empty required-roles array as "forbid everyone" (`[].includes(role)` is `false`),
> not as "public". This is documented inline in `conditionalAuth.ts` and `proxyUtil.ts`.

---

### Users

#### POST `/api/v1/users/register`
```bash
curl -s -X POST http://localhost:3000/api/v1/users/register \
  -H "Content-Type: application/json" \
  -d '{"userId":"alice","email":"alice@example.com","password":"hunter2pass","role":"USER"}'
```
```json
// 201
{"success":true,"message":"User created successfully","data":{"userId":"alice","email":"alice@example.com","role":"USER"}}
```
Errors: `400` missing/invalid fields or role (including a password under 8 characters),
`409` duplicate **email or userId** — both unique keys are pre-checked, and a unique violation
at INSERT (SQLSTATE `23505`, which two concurrent registrations of the same key can still
produce) also maps to `409` rather than `503`. That distinction matters: `503` tells a client the
server is broken and to retry, so a retrying client would loop forever without learning the id
was taken. Any other database failure stays a `503`. Password is bcrypt-hashed (10 rounds),
never stored/logged.

Two things worth knowing about registration:

- **Password policy**: minimum 8 characters, maximum 72. The cap isn't arbitrary — bcrypt only
  consumes the first 72 *bytes* of a password, so anything past that is silently ignored while
  the user believes their long passphrase is fully protecting them. `/login` deliberately has
  **no** length requirement, so users who registered before the policy existed aren't locked out.
- **Email uniqueness is case-insensitive.** A plain `UNIQUE` on `text` is case-*sensitive* in
  Postgres, so `Alice@x.com` and `alice@x.com` would become two accounts for one person, both
  of which would then pass login. Enforced with a `UNIQUE` index over `LOWER(email)`, and the
  registration pre-check compares with `LOWER()` too so it agrees with the constraint — if they
  disagreed, a duplicate would slip past the check and surface as a 503 instead of a clean 409.
  The address is stored with its original casing for display; only the comparison is folded.

#### POST `/api/v1/users/login`
```bash
curl -s -X POST http://localhost:3000/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"hunter2pass"}'
```
```json
{"success":true,"message":"Login successful","data":{"token":"<jwt>"}}
```
`401` for unknown email **or** wrong password (deliberately identical message — no account
enumeration). Token expires in **1 hour**.

#### POST `/api/v1/users/logout` — requires `Authorization: Bearer <token>`
```bash
curl -s -X POST http://localhost:3000/api/v1/users/logout -H "Authorization: Bearer $TOKEN"
```
```json
{"success":true,"message":"Logged out successfully","status":200,"data":null}
```
Returns `200` and immediately invalidates **every** token this user holds — including copies
elsewhere. Idempotent. `401` without a valid token; `503` if the revocation marker could not be
written (it reports the failure rather than pretending you logged out).

#### GET `/api/v1/users/getAll` — requires `Authorization: Bearer <token>`, ADMIN/MANAGER
```json
{ "data": { "users": [ { "id", "email", "name", "role", "createdAt" } ], "pagination": {...} } }
```
Paginated — see [Pagination](#pagination).

### Payments

Identity is always taken from the **verified JWT** inside the service (`req.auth.userId`),
never from a header or body. Balances are `numeric(10,2)`.

#### POST `/api/v1/payments/deposit`
> The example uses `jq` to extract the token from the login response.
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"hunter2pass"}' | jq -r .data.token)

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

### Token revocation

A JWT is **self-contained**: nobody asks the server "is this still valid?" — the signature is
checked and the payload is believed. That is what makes it fast, and it is also why **a JWT
cannot be un-issued**. Deleting the client's copy on logout only protects that one client; a
copy in a log file, a shared browser, or someone else's hands keeps working until `exp`.

That is why two things are needed, and only together are they sufficient.

**1. A short lifetime.** `TOKEN_TTL` defaults to 3600 (1 hour), down from 7 days. A stolen
token is worth whatever remains of its lifetime, and that number — not the presence of any
revocation list — is the real exposure. It's also the only defence against a token that leaks
and whose owner never notices, which no deny-list can help with.

**2. A deny-list.** `/logout` records *when* a user's tokens died:

```
logout:  SET revoked:<userId> <epoch seconds>  EX <TOKEN_TTL>
verify:  reject the token if its `iat` <= that value
```

Keyed by **user**, not by token — so every outstanding token dies at once (which is what a
logout should mean), and the key space is bounded by user count rather than growing with every
logout. The entry **self-expires**: after `TOKEN_TTL` no token minted before the revocation can
still be alive, so Redis drops it. That TTL has to track the token lifetime exactly — too short
and revoked tokens quietly come back to life, too long and you're holding dead data.

The same mechanism would also handle **role changes**: a token minted while someone was an
admin still says `ADMIN` in its payload forever, and only a revocation bump can correct that
before it expires. That's the hook a future "change my password" or "demote this user" endpoint
would use.

**Failing open, deliberately.** This lookup sits on every authenticated request, so Redis is now
on the critical path for all authenticated traffic. If it fails, the token is treated as *not*
revoked. That is only defensible *because* the lifetime is short: revocation is a convenience
layer over expiry, not the primary control, so a Redis outage costs at most one hour of
exposure for a token whose owner explicitly logged out — bounded and small — instead of
authentication failing outright for everyone.

> **Honest caveat, found while testing this:** failing open buys nothing end-to-end here,
> because the **rate limiter hits the same Redis and fails CLOSED**. Stopping Redis returned
> `500` for every request, including `/login` — the request never reaches the revocation check.
> So in this system a Redis outage is a total outage regardless. The revocation check is still
> correct to fail open (that is the right behavior for this dependency), but the availability
> story would need the rate limiter to agree before failing open actually bought resilience.
> Making the limiter fail open too is a deliberate decision with its own trade-offs — unlimited
> traffic during an outage is how you take down a backend.

The proper fix for the underlying issue isn't any of this: **short-lived access token plus a
refresh token**, so the access token's exposure window is small and revocation only ever applies
to the refresh token. See [Trade-offs](#documented-trade-offs--production-hardening).

### Defense in depth

Proxy-forwarded headers are forgeable, so every backend route that matters ALSO verifies the
`Authorization` header itself with the shared `JWT_SECRET` (`requireAuth` in each service)
and re-checks roles from the verified claims — never from the `x-user-*` headers. A request
that hits a service container directly (bypassing the gateway) still can't impersonate
anyone.

`conditionalAuth` also **deletes** any incoming `x-user-id` / `x-user-role` before doing
anything else, then sets them only from a verified token. This matters because downstream
middleware trusts them: `rateLimitMiddleware` picks its bucket from `x-user-id`, and
`cacheKey` scopes cached responses by it. HTTP headers are caller-controlled, so merely
*overwriting* them on the authenticated path wasn't enough — on a **public** route
(`/register`, `/login`) the middleware returns early, before any overwrite, so a client
could send its own `x-user-id`, be treated as authenticated, and escape the 2-request
anonymous bucket for the 20-request authenticated one. Rotating the header per request got a
fresh bucket each time: unlimited throughput against endpoints that bcrypt-hash passwords.
Stripping first makes public routes carry no identity at all, so the anonymous bucket is the
only one they can land in.

Every `jwt.verify` call site (the gateway plus both services' `requireAuth`) passes
`algorithms: ["HS256"]` rather than relying on jsonwebtoken's default of "whatever the header
claims, as long as it works with this key". Not exploitable as configured — the secret is
symmetric and v9 rejects `alg: none` — but pinning means a future change of key type can't
silently widen what gets accepted.

---

## Database

Three tables owned by three owners, all living in **one** Postgres database (`gateway_db`).
Each service generates and owns **its own** versioned migrations (`drizzle/` folders); a
service only ever runs DDL for its own tables.

**Each service also gets its own migration ledger.** Drizzle records what it has applied in a
table (default `__drizzle_migrations` in schema `drizzle`) and skips any migration whose
journal timestamp is *older* than the newest one it has recorded. With one shared database
that default is shared too, so whichever service migrated first would "claim" the ledger and
the other services' older migrations would be **silently skipped** — their tables would never
be created. This actually happened here: log-worker's journal was generated earliest, so a
user-service-first boot made log-worker report "Migrations applied" while the `logs` table
never existed. Each service now names its own ledger (`user_service_migrations`,
`payment_service_migrations`, `log_worker_migrations`), so boot order between services no
longer matters.

| Table | Owner | Notes |
|---|---|---|
| `users` | user-service | `id` PK, `email` unique + case-insensitive `LOWER(email)` index, `password_hash`, `role` |
| `accounts` | payment-service | `user_id` PK, `balance numeric(10,2)`, auto-created on first deposit |
| `transactions` | payment-service | append-only ledger: `DEPOSIT` / `WITHDRAW`, `amount`, `created_at`; indexed on `(user_id, created_at)` for paginated history |
| `logs` | log-worker | batch-written observability events, 3 indexes |

**Connection pooling.** Each service sets `max: 5` (log-worker: 10) rather than node-postgres's
default of 10. Postgres's `max_connections` (default 100) is a *shared* budget, and 3 services ×
3 replicas × the default 10 would reach 90 — the database would start refusing connections before
any single process hit its own ceiling. Overflow past the pool size makes a request *wait* rather
than crash, and `connectionTimeoutMillis: 5000` bounds that wait so exhaustion fails fast (503)
instead of hanging. If you add a replica or a fourth service, raise these together.

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

## Health, readiness & graceful shutdown

Every HTTP service exposes two endpoints, and the distinction matters in containers:

| Endpoint | Meaning | 200 when |
|---|---|---|
| `/health` | **liveness** — "is this process alive?" | the event loop can answer at all |
| `/ready`  | **readiness** — "send me traffic?" | migrations are done **and** not draining |

Neither probes the database. A dead database shouldn't get a container *restarted* (that
would just restart the wait); it should show up as a failing readiness check instead.

The ready flag is set **after** `ensureUsersTable()` / `ensurePaymentTables()` resolves, never
at `listen()` time — otherwise a replica could report healthy and then 500 on its first real
request because the table wasn't there yet. `markDraining()` flips `/ready` to 503 the moment
SIGTERM arrives, so nothing new is routed while in-flight requests finish.

This is what makes Compose's gating meaningful: `depends_on: service_healthy` waits on
`/ready`, so a replica is never handed traffic before it can answer it. Every service drains
in order — stop advertising ready → `server.close()` to finish in-flight work → close the
connection pool last — with a 10-second force-exit so a hung request can't outlive Docker's
kill window. `log-worker` has no HTTP surface, so its healthcheck is a process check (a
deliberately shallow check, noted as such in its Dockerfile).

## Container hardening

All four images are multi-stage: a builder stage with the full toolchain compiles TypeScript,
and a runtime stage gets production-only `node_modules` + `dist/` and nothing else. Each runs
as `USER node` (a built-in non-root user in the official image). `CMD` uses the exec form so
PID 1 is `node` itself and SIGTERM reaches the shutdown handler directly rather than being
swallowed by an npm wrapper.

The three services copy their `drizzle/` folder into the runtime image — **not optional**:
`runMigrations()` reads `./drizzle` at boot, so without it the service crashes before serving
anything. The gateway ships no migrations, so it doesn't.

## Testing

111 unit tests across 4 packages, plus 11 concurrency tests against real Postgres and Redis
(the unit tests inject fakes through the handlers' dependency seams).

```bash
(cd gateway && npm test)                    # 48 tests — middleware, balancer, breaker, cache, auth, revocation
(cd gateway && npm test -- --coverage)      # opt into coverage (off by default)
(cd services/user-service && npm test)      # 30 tests — register / login / logout / duplicate detection / pagination
(cd services/payment-service && npm test)   # 25 tests — deposit / withdraw / my / getAll / requireAuth / transactions
(cd services/log-worker && npm test)        #  8 tests — batch buffer, retention cleanup

# build check (tsc) — same pattern per package:
(cd gateway && npm run build)
```

### Concurrency tests (real Postgres + Redis)

Some properties belong to the *datastore*, not to this TypeScript:

- that Postgres serialises the atomic upsert and the conditional `UPDATE`, so
  concurrent withdrawals can never overdraw
- that Redis executes the Lua token bucket without interleaving, so a burst of
  parallel requests can never exceed the bucket's capacity

A mock cannot demonstrate either — it returns whatever the test tells it to. So these run
against real services:

```bash
# needs DATABASE_URL and/or REDIS_URL; each suite skips itself if its var is absent
(cd gateway && REDIS_URL=redis://localhost:6379 npm run test:integration)
(cd services/payment-service && DATABASE_URL=postgres://... npm run test:integration)
```

**These guards were validated by breaking the code on purpose.** A test that passes trivially
proves nothing, so each was checked against a deliberately naive implementation:

| Guard | Naive implementation | Result |
|---|---|---|
| 20 concurrent withdrawals against a 100 balance | `SELECT` → check in app code → `UPDATE` | **20 of 20 succeeded** — 200 paid out of 100. Caught. |
| 50 simultaneous requests at capacity 20 | read bucket → decide → write (no Lua) | **50 of 50 admitted** — the limiter did nothing under load. Caught by 3 tests. |

The `SELECT`-then-`UPDATE` version passes every sequential test and is the most plausible way
this code gets rewritten by someone who doesn't know why the conditional `UPDATE` looks odd.
That is the regression these exist to prevent.

They run in CI as a separate `concurrency` job backed by Postgres and Redis service containers,
so a slow integration failure stays distinguishable from a fast unit failure.

### CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. **`test`** — a matrix over all four packages (`npm ci` → `build` → `test`), `fail-fast: false`
   so one broken package doesn't hide the state of the others.
2. **`docker`** — `docker compose build`, which catches broken Dockerfiles that no amount of
   npm testing would.
3. **`concurrency`** — the money paths and the rate limiter against real Postgres and Redis
   service containers (see the Concurrency tests section above).
4. **`e2e`** — brings the whole stack up with `--wait`, then proves it works: register → login →
   deposit → a 422 over-withdrawal → an RBAC 403 → **token still valid → logout → same token
   now 401** → and that log rows actually reached Postgres. Container logs are dumped on
   failure. The logout step deliberately reuses the *same* token rather than logging in again,
   since a fresh token would pass regardless of whether revocation works.

No lint step: there is no ESLint or Prettier configured in this repo, so CI checks types,
tests, images, and behaviour rather than style.

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
7. **Caching is disabled on all routes.** The cache mechanism is built and working
   (`CacheMiddleware`, `buildCacheKey`, `cachebleRoutes`), but nothing is registered as
   cacheable. It was originally on for the three list routes, which was a correctness bug —
   nothing invalidated on write, so a deposit would be invisible to the depositor for the full
   TTL and new accounts invisible to admins. Invalidation is the alternative, but a per-admin
   cache can't be invalidated without tracking who primed it. The honest version of this
   project is: keep the mechanism, don't use it on data you can't invalidate.
8. **No idempotency keys.** Each payment mutation now runs its balance change and its ledger
   row in a single `db.transaction()`, so a crash *inside the database* can't leave them out
   of step. That does **not** protect against a client whose request times out and retries —
   the same deposit would be applied twice. Real payment systems take a client-supplied unique
   id, record it with the transaction, and treat a repeat as a no-op. Deliberately out of scope;
   the transaction closes the crash case, the idempotency key closes the retry case.
9. **Secrets are in compose**, not a secret manager. Fine for a demo, but `JWT_SECRET` and the
   DB password are plaintext in the compose file — a real deployment would use Docker secrets
   or a vault, and at minimum refuse to boot on a default secret outside dev.
10. **Revocation is a mitigation, not a fix.** A 1-hour lifetime plus a Redis deny-list bounds
    how long a stolen token is useful, but the token is still self-contained and the check costs
    a Redis round-trip on every request. The real answer is short-lived access tokens (15 min)
    plus refresh tokens, where revocation applies only to the refresh token and the hot path
    needs no lookup.

Not yet done (natural next steps):
- **Observability**: no metrics endpoint (Prometheus), no tracing. Cache hit rate, rate-limit
  rejections, and breaker state are all computed but not exported.
- **Linting/formatting**: there is no ESLint or Prettier configured, so CI checks
  types + tests + builds but not style.
- **Concurrency tests**: the CI e2e job covers the happy path and two error paths against real
  containers; there's no automated concurrency test for the atomic deposit/withdraw guards,
  which is where a race would actually bite.
- **Keyset pagination**: all list endpoints use `OFFSET`, which shifts under concurrent writes
  (see the Pagination section). `/payments/my` is the one whose data grows without bound and
  would most benefit from `WHERE created_at < last_seen`-style cursors.
- **Wider concurrency coverage**: the money paths and the rate limiter now run against real
  Postgres and Redis. `BatchBuffer`'s ack/nack under concurrent flushes, and the log-worker's
  reconnect path, are still only covered by unit tests with fakes.
- **No Prometheus metrics**: cache hit rate, rate-limit rejections, breaker transitions, and
  revocation hits are all computed and then only logged, so nothing can be alerted on.
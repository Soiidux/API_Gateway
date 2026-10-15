import type { Request, Response } from "express";
import dotenv from "dotenv";
import { eq, sql } from "drizzle-orm";
import { PostgresClient } from "../db/client.js";
import { accounts, transactions } from "../db/schema.js";
dotenv.config();

/**
 * Payment service HTTP handlers.
 *
 * Identity always comes from `req.auth` — the verified JWT payload set
 * by requireAuth middleware — never from a header or body. This service
 * never trusts proxy-forwarded headers by itself.
 *
 *  - /deposit : atomically upserts into `accounts` (INSERT ... ON
 *    CONFLICT +1) then records a transaction row. Safe against
 *    concurrent deposits and a missing account.
 *  - /withdraw: one atomic conditional UPDATE (`balance >= amount`),
 *    returns 0 rows -> 422 "Insufficient Balance". Safe against
 *    concurrent withdrawals racing on the same account.
 *  - /my      : this caller's account + transaction history.
 *  - /getAll  : all accounts; ADMIN/MANAGER only (re-checked here, like
 *    user-service).
 *
 * (/ is a separate liveness / rate-limit probe — see rateLimiterCheck.)
 *
 * Every mutation runs the balance movement AND its ledger row inside a
 * single db.transaction(), so a failure part-way can't move money without
 * recording it. Known remaining gap: this protects against a crash inside
 * the database, not against a client retrying a timed-out request, which
 * needs idempotency keys (see the comment on deposit).
 */

interface ApiResponse<T> {
  success: boolean;
  message: string;
  status: number;
  data: T;
}

// Keep ONE client for the lifetime of the process (a pool of connections).
const postgres = new PostgresClient();

// Injectable seam for tests: handlers accept an optional db so a test can
// substitute a fake instead of hitting Postgres. Defaults to the real one.
type Database = typeof postgres.db;

/** Parses a positive numeric amount from the request body, or null. */
function parseAmount(body: unknown): number | null {
  const raw = (body as Record<string, unknown> | null | undefined)?.amount;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * 100) / 100;
}

/** Postgres numeric columns come back as strings; normalize for output. */
function toNumber(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

/** Pagination defaults/limits for list endpoints. */
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

/**
 * Parses a non-negative-integer query param (limit/offset), clamping limit
 * to PAGE_SIZE_MAX and falling back to `fallback` for anything absent or
 * unparseable. Deliberately forgiving: a malformed `?limit=abc` yields the
 * default page rather than a 400, because a client with a bad page param
 * still deserves to see data rather than an error.
 *
 * Always returns a number (never undefined) so callers don't have to narrow
 * it before passing to Drizzle's limit()/offset(), which reject undefined.
 */
function parseLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), PAGE_SIZE_MAX);
}

/**
 * POST /deposit { amount } — credit the caller's account.
 *
 * Security: the user's identity comes from req.auth.userId, which
 * requireAuth set by VERIFYING their JWT — never from the request body
 * or a blindly-trusted header. The balance increment is a single atomic
 * upsert (INSERT ... ON CONFLICT DO UPDATE balance + amount), so two
 * concurrent deposits can't lose each other's money. The account row is
 * auto-created on the first deposit.
 */
export const deposit = async (req: Request, res: Response, db: Database = postgres.db) => {
  const amount = parseAmount(req.body);
  if (amount === null) {
    const badRequest: ApiResponse<null> = {
      success: false,
      message: "amount must be a positive number",
      status: 400,
      data: null,
    };
    return res.status(400).json(badRequest);
  }

  // requireAuth sets req.auth, but guard defensively so a direct call
  // without a token can't reach the DB with an undefined identity.
  const userId = req.auth?.userId;
  if (!userId) {
    const unauthorized: ApiResponse<null> = {
      success: false,
      message: "Unauthorized",
      status: 401,
      data: null,
    };
    return res.status(401).json(unauthorized);
  }

  try {
    const userCheck = (await db.execute(
      sql`SELECT 1 FROM "users" WHERE "id" = ${userId} LIMIT 1`,
    )) as { rows: unknown[] };

    if (userCheck.rows.length === 0) {
      const notFound: ApiResponse<null> = {
        success: false,
        message: "User not found",
        status: 404,
        data: null,
      };
      return res.status(404).json(notFound);
    }

    // Balance movement + ledger row in ONE transaction.
    //
    // The upsert statement is itself atomic (the database serializes the
    // increment, so concurrent deposits can't lose each other's money) —
    // but on its own it only guarantees the BALANCE is right. If the ledger
    // insert then failed (connection drop, disk error), the money would have
    // moved with no record of why. Wrapping both in db.transaction() means
    // Postgres commits them together or rolls back both.
    //
    // Still not sufficient for production: this protects against a crash
    // INSIDE the database, not against a client that times out and retries,
    // which would apply the same deposit twice. That needs an idempotency
    // key (client-supplied unique id recorded with the transaction, and a
    // retry treated as a no-op) — a larger feature, deliberately out of
    // scope here.
    const balance = await db.transaction(async (tx) => {
      const accountResult = (await tx.execute(
        sql`INSERT INTO "accounts" ("user_id", "balance")
            VALUES (${userId}, ${String(amount)})
            ON CONFLICT ("user_id")
            DO UPDATE SET "balance" = "accounts"."balance" + ${String(amount)}
            RETURNING "balance"`,
      )) as { rows: { balance: string }[] };

      await tx
        .insert(transactions)
        .values({ userId, type: "DEPOSIT", amount: String(amount) });

      return accountResult.rows[0]?.balance ?? "0";
    });

    const apiResponsePayload: ApiResponse<{ userId: string; balance: number }> = {
      success: true,
      message: "Deposit successful",
      data: { userId, balance: toNumber(balance) },
      status: 201,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    console.error("[Payment Service] Deposit failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Deposit failed",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};

/**
 * POST /withdraw { amount } — debit the caller's account if it has funds.
 *
 * The insufficient-funds check is NOT a read-then-write: it's a single
 * conditional UPDATE ... WHERE balance >= amount. The database enforces
 * atomicity, so two concurrent withdraws can never both pass the check
 * against the same funds. rowCount 0 means the balance couldn't cover it
 * (or the account doesn't exist yet) → 422.
 */
export const withdraw = async (req: Request, res: Response, db: Database = postgres.db) => {
  const amount = parseAmount(req.body);
  if (amount === null) {
    const badRequest: ApiResponse<null> = {
      success: false,
      message: "amount must be a positive number",
      status: 400,
      data: null,
    };
    return res.status(400).json(badRequest);
  }

  const userId = req.auth?.userId;
  if (!userId) {
    const unauthorized: ApiResponse<null> = {
      success: false,
      message: "Unauthorized",
      status: 401,
      data: null,
    };
    return res.status(401).json(unauthorized);
  }

  try {
    const userCheck = (await db.execute(
      sql`SELECT 1 FROM "users" WHERE "id" = ${userId} LIMIT 1`,
    )) as { rows: unknown[] };

    if (userCheck.rows.length === 0) {
      const notFound: ApiResponse<null> = {
        success: false,
        message: "User not found",
        status: 404,
        data: null,
      };
      return res.status(404).json(notFound);
    }

    // Debit + ledger row in ONE transaction.
    //
    // The conditional UPDATE is itself the concurrency guard: the balance
    // check and the subtraction happen inside a single statement, so two
    // concurrent withdraws can never both pass against the same funds.
    // Wrapping it together with the ledger insert means a failure part-way
    // can't debit without recording why.
    //
    // Insufficient funds is signalled by returning null from inside the
    // transaction rather than by sending the response here — the transaction
    // simply commits having changed nothing, and we map null -> 422 after it
    // closes. Writing the response inside would be fine too, but keeping the
    // HTTP layer outside means a rollback can't race a half-written body.
    const newBalance = await db.transaction(async (tx) => {
      const accountResult = (await tx.execute(
        sql`UPDATE "accounts"
            SET "balance" = "accounts"."balance" - ${String(amount)}
            WHERE "user_id" = ${userId}
              AND "balance" >= ${String(amount)}
            RETURNING "balance"`,
      )) as { rows: { balance: string }[] };

      // 0 rows updated = balance couldn't cover it (or no account yet).
      if (accountResult.rows.length === 0) return null;

      await tx
        .insert(transactions)
        .values({ userId, type: "WITHDRAW", amount: String(amount) });

      return accountResult.rows[0]!.balance;
    });

    if (newBalance === null) {
      const insufficient: ApiResponse<null> = {
        success: false,
        message: "Insufficient balance",
        status: 422,
        data: null,
      };
      return res.status(422).json(insufficient);
    }

    const apiResponsePayload: ApiResponse<{ userId: string; balance: number }> = {
      success: true,
      message: "Withdrawal successful",
      data: { userId, balance: toNumber(newBalance) },
      status: 201,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    console.error("[Payment Service] Withdrawal failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Withdrawal failed",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};

/**
 * GET /my — the caller's balance and full transaction history. Scoped to
 * req.auth.userId, so a user can only ever see their own money.
 */
export const getMy = async (req: Request, res: Response, db: Database = postgres.db) => {
  const userId = req.auth?.userId;

  try {
    const [acc] = await db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.userId, userId ?? ""));

    // PAGINATED. This used to select the user's ENTIRE transaction history on
    // every call, which grows without bound — a user with 10k transactions
    // made this endpoint return 10k rows, every time, forever. Two problems:
    // unbounded memory/latency in this process, and an unbounded response the
    // gateway would then have to proxy.
    //
    // Now LIMIT/OFFSET with a hard cap: `?limit=` (default 50, max 200) and
    // `?offset=`. Capped rather than merely defaulted so a client asking for
    // limit=100000 gets 200 rather than the whole table.
    //
    // `newest first` ordering pairs with offset pagination, which is what a
    // "recent activity" view wants; the index on (user_id, created_at) makes
    // the ORDER BY + LIMIT cheap instead of a full sort per call.
    const limit = parseLimit(req.query.limit, PAGE_SIZE_DEFAULT);
    const offset = parseLimit(req.query.offset, 0);

    const txns = await db
      .select({
        id: transactions.id,
        type: transactions.type,
        amount: transactions.amount,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId ?? ""))
      .orderBy(sql`${transactions.createdAt} desc`)
      .limit(limit)
      .offset(offset);

    // Total row count for the client to compute "page 2 of N". A separate
    // cheap COUNT query rather than inferring from the page size, which
    // can't distinguish "exactly one more page" from "many more".
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.userId, userId ?? ""));

    const apiResponsePayload: ApiResponse<{
      balance: number;
      transactions: typeof txns;
      pagination: { limit: number; offset: number; total: number };
    }> = {
      success: true,
      message: "Account fetched successfully",
      data: {
        balance: toNumber(acc?.balance),
        transactions: txns,
        pagination: { limit, offset, total: Number(countRow?.count ?? 0) },
      },
      status: 200,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    console.error("[Payment Service] fetch failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Failed to fetch account",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};

/**
 * GET /getAll — every account in the system. Enforced twice: the gateway
 * roleMap already restricts the route to ADMIN/MANAGER at the edge, and
 * this service re-checks req.auth.role from the verified JWT (never
 * trusting a forwarded header) as defense in depth.
 */
export const getAll = async (req: Request, res: Response, db: Database = postgres.db) => {
  const role = req.auth?.role;
  if (role !== "ADMIN" && role !== "MANAGER") {
    const forbidden: ApiResponse<null> = {
      success: false,
      message: "Forbidden",
      status: 403,
      data: null,
    };
    return res.status(403).json(forbidden);
  }

  try {
    // PAGINATED for the same reason as /my's history: this was an unbounded
    // SELECT * over every account, so response size scaled with total users.
    const limit = parseLimit(req.query.limit, PAGE_SIZE_DEFAULT);
    const offset = parseLimit(req.query.offset, 0);

    const rows = await db.select().from(accounts).limit(limit).offset(offset);
    const data = rows.map((r) => ({ userId: r.userId, balance: toNumber(r.balance) }));

    const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(accounts);

    const apiResponsePayload: ApiResponse<{
      accounts: typeof data;
      pagination: { limit: number; offset: number; total: number };
    }> = {
      success: true,
      message: "Accounts fetched successfully",
      // Response shape CHANGED: the account list moved under `data.accounts`
      // to make room for `data.pagination`. The old shape was a bare array,
      // which left no room to add pagination without a breaking change —
      // making the break explicit now rather than later.
      data: { accounts: data, pagination: { limit, offset, total: Number(countRow?.count ?? 0) } },
      status: 200,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    console.error("[Payment Service] fetch all failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Failed to fetch accounts",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};

export const rateLimiterCheck = (req: Request, res: Response) => {
  const resPayload: ApiResponse<null> = {
    success: true,
    message: "Rate limit check passed",
    data: null,
    status: 200,
  };
  return res.status(resPayload.status).json(resPayload);
};
import type { Request, Response } from "express";
import dotenv from "dotenv";
import { eq, sql } from "drizzle-orm";
import { PostgresClient } from "../db/client.js";
import { accounts, transactions } from "../db/schema.js";
dotenv.config();

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

    // Atomic upsert: one statement creates the account on first deposit or
    // bumps the existing balance — INSERT ... ON CONFLICT. The database
    // serializes the increment, so concurrent deposits can't lose money.
    const accountResult = (await db.execute(
      sql`INSERT INTO "accounts" ("user_id", "balance")
          VALUES (${userId}, ${String(amount)})
          ON CONFLICT ("user_id")
          DO UPDATE SET "balance" = "accounts"."balance" + ${String(amount)}
          RETURNING "balance"`,
    )) as { rows: { balance: string }[] };

    await db
      .insert(transactions)
      .values({ userId, type: "DEPOSIT", amount: String(amount) });

    const apiResponsePayload: ApiResponse<{ userId: string; balance: number }> = {
      success: true,
      message: "Deposit successful",
      data: { userId, balance: toNumber(accountResult.rows[0]?.balance) },
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

    // Atomic guard: a single conditional UPDATE ... WHERE balance >= amount.
    // The database enforces the check inside the statement, so two concurrent
    // withdraws can never both pass against the same funds. rowCount 0 means
    // the balance couldn't cover it (or there's no account yet) → 422.
    const accountResult = (await db.execute(
      sql`UPDATE "accounts"
          SET "balance" = "accounts"."balance" - ${String(amount)}
          WHERE "user_id" = ${userId}
            AND "balance" >= ${String(amount)}
          RETURNING "balance"`,
    )) as { rows: { balance: string }[] };

    if (accountResult.rows.length === 0) {
      const insufficient: ApiResponse<null> = {
        success: false,
        message: "Insufficient balance",
        status: 422,
        data: null,
      };
      return res.status(422).json(insufficient);
    }

    // rows[0] is safe here: the 422 branch above already returned when
    // the array was empty, so we only reach this line with a row in hand.
    const newBalance = accountResult.rows[0]!.balance;

    await db
      .insert(transactions)
      .values({ userId, type: "WITHDRAW", amount: String(amount) });

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

    const txns = await db
      .select({
        id: transactions.id,
        type: transactions.type,
        amount: transactions.amount,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId ?? ""))
      .orderBy(sql`${transactions.createdAt} desc`);

    const apiResponsePayload: ApiResponse<{ balance: number; transactions: typeof txns }> = {
      success: true,
      message: "Account fetched successfully",
      data: { balance: toNumber(acc?.balance), transactions: txns },
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
    const rows = await db.select().from(accounts);
    const data = rows.map((r) => ({ userId: r.userId, balance: toNumber(r.balance) }));

    const apiResponsePayload: ApiResponse<typeof data> = {
      success: true,
      message: "Accounts fetched successfully",
      data,
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
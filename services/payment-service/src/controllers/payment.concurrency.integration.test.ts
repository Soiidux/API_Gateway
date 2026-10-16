/**
 * Concurrency tests for the payment money paths — against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS AND WHY IT NEEDS A DATABASE
 *
 * The deposit upsert and the withdraw guard are the subtlest code in the
 * project, and their correctness comes entirely from how POSTGRES executes
 * them:
 *
 *   deposit:   INSERT ... ON CONFLICT DO UPDATE SET balance = balance + $1
 *   withdraw:  UPDATE ... WHERE user_id = $1 AND balance >= $1 RETURNING balance
 *
 * Neither is atomic because of anything in TypeScript. They are atomic
 * because Postgres serialises conflicting writes to the same row. A unit test
 * with a fake db cannot demonstrate that — the fake returns whatever the test
 * told it to, so "the balance never goes negative" would be a property of the
 * mock rather than of the system. These tests run the real SQL against the
 * real engine and assert on the real ledger.
 *
 * THE BUG THIS GUARDS AGAINST
 *
 * A naive withdraw — read the balance, check it in application code, then
 * write the new value — has a race: two requests both read 100, both decide
 * they can take 80, and both write 20. The account ends at 20 having paid out
 * 160, and the ledger records 160 that only ever existed once. Test 2 fires
 * concurrent withdrawals at a shared balance and asserts the total paid out
 * can never exceed the money that was there.
 *
 * RUN WITH:  npm run test:integration     (needs DATABASE_URL)
 * Skips itself when DATABASE_URL is unset, so `npm test` stays offline-safe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import type { Request, Response } from "express";

import { deposit, withdraw } from "./payment.controllers.js";
import * as schema from "../db/schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;

/** Captures status + parsed body the way Express would deliver them. */
function makeRes() {
  const captured: { status?: number; body?: { message?: string; data?: unknown } } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: { status: number; message: string; data?: unknown }) {
      captured.body = payload;
      return this;
    },
  };
  return { res: res as unknown as Response, captured };
}

function authedReq(body: unknown, userId: string) {
  return {
    body,
    auth: { userId, role: "USER" },
  } as unknown as Request;
}

/**
 * Runs N handler invocations truly concurrently.
 *
 * Promise.all over the handlers is the point: each one reaches Postgres on its
 * own pooled connection, so the statements genuinely overlap in the engine
 * rather than being serialised by an await chain inside one function.
 */
async function concurrently<T>(count: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => fn(i)));
}

/** Current balance straight from Postgres — ground truth, never from a handler. */
async function balanceOf(userId: string): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT balance FROM accounts WHERE user_id = ${userId}`,
  )) as { rows: { balance: string }[] };
  return rows.rows[0]?.balance ?? "absent";
}

/** Sum of the ledger for a user, computed independently of the balance column. */
async function ledgerOf(userId: string): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT COALESCE(SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE -amount END), 0) AS total
        FROM transactions WHERE user_id = ${userId}`,
  )) as { rows: { total: string }[] };
  return rows.rows[0]?.total ?? "0";
}

async function txnCount(userId: string): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM transactions WHERE user_id = ${userId}`,
  )) as { rows: { n: number }[] };
  return rows.rows[0]?.n ?? 0;
}

describeIfDb("payment concurrency (real Postgres)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL!, max: 25 });
    db = drizzle(pool, { schema });

    // Recreate the two tables this service owns, matching drizzle/0000. Using
    // the same DDL keeps the tests honest — if a migration changes the shape,
    // this drifts and someone notices.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "accounts" (
        "user_id"      text PRIMARY KEY,
        "balance"      numeric(10,2) NOT NULL DEFAULT '0',
        "updated_at"   timestamptz NOT NULL DEFAULT now()
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "transactions" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"    text NOT NULL,
        "type"       text NOT NULL,
        "amount"     numeric(10,2) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);

    // The handlers verify the caller exists against user-service's `users`
    // table (a raw SQL check, deliberately not a Drizzle mirror). payment's own
    // migrations never create it, so the suite creates just enough of it to
    // satisfy that check.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"    text PRIMARY KEY,
        "email" text NOT NULL UNIQUE
      )`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // TRUNCATE (not DELETE) so a previous test's rows can't influence the next
    // one's assertions, and so no lock ordering carries over.
    await db.execute(sql`TRUNCATE accounts, transactions RESTART IDENTITY`);
    await db.execute(sql`DELETE FROM users`);
  });

  afterEach(() => {
    // nothing to clean per-test; beforeEach handles isolation
  });

  // -------------------------------------------------------------------------
  it("20 concurrent deposits all land — the ON CONFLICT upsert loses nothing", async () => {
    const user = "concurrent-depositor";
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@x.com`})`);

    const results = await concurrently(20, async () => {
      const { res, captured } = makeRes();
      await deposit(authedReq({ amount: 10 }, user), res, db);
      return captured;
    });

    // Every request individually succeeded...
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);

    // ...and, more importantly, the money is all still there. This is the
    // assertion that fails if the upsert were a read-then-write: 20 x 10
    // deposited into a balance that raced would total less than 200.
    expect(await balanceOf(user)).toBe("200.00");
    expect(await ledgerOf(user)).toBe("200.00");
    expect(await txnCount(user)).toBe(20);
  });

  // -------------------------------------------------------------------------
  it("creates exactly ONE account row when concurrent first-deposits race the insert", async () => {
    const user = "first-deposit-race";
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@x.com`})`);
    expect(await balanceOf(user)).toBe("absent");

    await concurrently(10, async () => {
      const { res } = makeRes();
      await deposit(authedReq({ amount: 5 }, user), res, db);
    });

    // The classic upsert race: without ON CONFLICT, several concurrent
    // inserts would each see "no such account" and one would fail on the
    // primary key. With it, they serialise and accumulate.
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM accounts WHERE user_id = ${user}`,
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]?.n).toBe(1);
    expect(await balanceOf(user)).toBe("50.00");
    expect(await ledgerOf(user)).toBe("50.00");
  });

  // -------------------------------------------------------------------------
  // THE CRITICAL ONE. A naive implementation (read balance -> check in
  // application code -> write) passes every sequential test and fails here.
  it("concurrent withdrawals can never overdraw — the guard is atomic in Postgres", async () => {
    const user = "concurrent-withdrawer";
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@x.com`})`);

    // Seed 100.
    const { res: seedRes } = makeRes();
    await deposit(authedReq({ amount: 100 }, user), seedRes, db);
    expect(await balanceOf(user)).toBe("100.00");

    // 20 concurrent attempts to take 10 each. Only 10 can succeed; the other
    // 10 must be rejected. Critically, the total taken must be <= 100.
    const results = await concurrently(20, async () => {
      const { res, captured } = makeRes();
      await withdraw(authedReq({ amount: 10 }, user), res, db);
      return captured;
    });

    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 422);
    const other = results.filter((r) => r.status !== 201 && r.status !== 422);

    expect(other).toEqual([]); // no 503s, no unexpected codes
    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((r) => r.body?.message === "Insufficient balance")).toBe(true);

    // The money invariants. Balance hits exactly zero, never below it, and the
    // ledger agrees — no transaction exists that isn't backed by a real
    // movement.
    expect(await balanceOf(user)).toBe("0.00");
    expect(await ledgerOf(user)).toBe("0.00");
    expect(await txnCount(user)).toBe(11); // 1 seed deposit + 10 withdrawals
  });

  // -------------------------------------------------------------------------
  it("each concurrent withdrawal sees its own balance, never a stale read", async () => {
    const user = "stale-read-check";
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@x.com`})`);

    const { res: seedRes } = makeRes();
    await deposit(authedReq({ amount: 300 }, user), seedRes, db);

    // 30 concurrent withdrawals of 10 against 300 — every one must succeed.
    // If the guard read a cached balance instead of the committed row, some
    // would 422 despite ample funds.
    const results = await concurrently(30, async () => {
      const { res, captured } = makeRes();
      await withdraw(authedReq({ amount: 10 }, user), res, db);
      return captured;
    });

    expect(results.filter((r) => r.status === 201)).toHaveLength(30);
    expect(await balanceOf(user)).toBe("0.00");
    expect(await ledgerOf(user)).toBe("0.00");
  });

  // -------------------------------------------------------------------------
  it("mixed concurrent deposits and withdrawals keep the ledger equal to the balance", async () => {
    const user = "mixed-traffic";
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@x.com`})`);

    const { res: seedRes } = makeRes();
    await deposit(authedReq({ amount: 200 }, user), seedRes, db);

    // 15 withdrawals of 10 and 15 deposits of 10, all at once. Some
    // withdrawals will legitimately 422 depending on interleaving — what must
    // hold is that the ledger ALWAYS reconciles with the balance, since every
    // committed row came from a transaction that committed.
    await concurrently(30, async (i) => {
      const { res } = makeRes();
      const body = { amount: 10 };
      if (i % 2 === 0) {
        await withdraw(authedReq(body, user), res, db);
      } else {
        await deposit(authedReq(body, user), res, db);
      }
    });

    const balance = await balanceOf(user);
    const ledger = await ledgerOf(user);

    expect(balance).toBe(ledger);
    expect(Number(balance)).toBeGreaterThanOrEqual(0);
  });
});
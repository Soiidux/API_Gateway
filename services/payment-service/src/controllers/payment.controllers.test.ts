import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { deposit, withdraw, getMy, getAll } from "./payment.controllers.js";

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(body: unknown, auth?: { userId: string; role: string }) {
  const req = { body, auth };
  return req as unknown as Request & { auth?: { userId: string; role: string } };
}

/**
 * Minimal fake of the Drizzle db handle. Controllers touch exactly:
 *  - db.transaction(cb)            -> wraps balance + ledger in one unit
 *  - db.execute(sql)               -> raw SQL (user existence, deposit/withdraw)
 *  - db.insert(tbl).values(obj)    -> ledger rows (deposit/withdraw)
 *  - db.select(cols).from(tbl)...  -> reads (getMy/getAll)
 *
 * `executeQueue` is one resolved value per execute() call; pass an Error
 * inside the queue to simulate a DB failure. `select` is a stub that tests
 * replace when they exercise getMy/getAll. `failInsert` makes the ledger
 * insert reject, to exercise the "ledger write failed" path.
 *
 * NOTE ON SCOPE: `transaction` here just runs the callback against the same
 * fakes and reports whether it committed. That verifies the two statements
 * are issued *inside one transaction callback* — it cannot prove Postgres
 * rolls back on failure, because there's no real database involved. The
 * atomicity guarantee itself is Postgres's (and Drizzle's); what's asserted
 * here is that we actually use it, and that a failed ledger write surfaces
 * as an error rather than a success.
 */
function makeDb({ executeQueue = [] as unknown[], failInsert = false } = {}) {
  let call = 0;
  const execute = vi.fn().mockImplementation(async () => {
    const next = executeQueue[call];
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const insertValues = failInsert
    ? vi.fn().mockRejectedValue(new Error("ledger insert failed"))
    : vi.fn().mockResolvedValue({});
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const select = vi.fn(() => {
    throw new Error("select not stubbed for this test");
  });

  // The tx handle handed to the callback delegates to the same fakes, so a
  // test can still count execute/insert calls globally.
  const tx = { execute, insert, select };
  const transaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

  return { execute, insert, insertValues, select, transaction };
}

describe("deposit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when amount is missing or not a positive number", async () => {
    const db = makeDb();
    const res = makeRes();
    await deposit(makeReq({}, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(400);

    await deposit(makeReq({ amount: -5 }, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 401 without an authenticated user", async () => {
    const db = makeDb();
    const res = makeRes();
    await deposit(makeReq({ amount: 50 }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 404 when the user does not exist in the users table", async () => {
    const db = makeDb({ executeQueue: [{ rows: [] }] });
    const res = makeRes();
    await deposit(makeReq({ amount: 50 }, { userId: "ghost", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 201 and credits the account when the user exists", async () => {
    const db = makeDb({
      executeQueue: [{ rows: [{}] }, { rows: [{ balance: "150.00" }] }],
    });
    const res = makeRes();
    await deposit(makeReq({ amount: 150 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "DEPOSIT", amount: "150" }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: "u1", balance: 150 } }),
    );
  });

  it("returns 503 when the database throws", async () => {
    const db = makeDb({ executeQueue: [new Error("db down")] });
    const res = makeRes();
    await deposit(makeReq({ amount: 50 }, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("withdraw", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when amount is missing or invalid", async () => {
    const db = makeDb();
    const res = makeRes();
    await withdraw(makeReq({}, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(400);

    await withdraw(makeReq({ amount: "ten" }, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 401 without an authenticated user", async () => {
    const db = makeDb();
    const res = makeRes();
    await withdraw(makeReq({ amount: 10 }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 404 when the user does not exist", async () => {
    const db = makeDb({ executeQueue: [{ rows: [] }] });
    const res = makeRes();
    await withdraw(makeReq({ amount: 10 }, { userId: "ghost", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 422 (Insufficient balance) when the guarded UPDATE returns no row", async () => {
    const db = makeDb({ executeQueue: [{ rows: [{}] }, { rows: [] }] });
    const res = makeRes();
    await withdraw(makeReq({ amount: 10 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 201 and debits the account when funds are available", async () => {
    const db = makeDb({ executeQueue: [{ rows: [{}] }, { rows: [{ balance: "40.00" }] }] });
    const res = makeRes();
    await withdraw(makeReq({ amount: 10 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "WITHDRAW", amount: "10" }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: "u1", balance: 40 } }),
    );
  });

  it("returns 503 on database error", async () => {
    const db = makeDb({ executeQueue: [new Error("db down")] });
    const res = makeRes();
    await withdraw(makeReq({ amount: 10 }, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

/** Stubs db.select(...).from(...) so where() resolves to an (empty) array
 *  that also chains .orderBy(rows) — matches how getMy destructures the
 *  accounts row ([acc]) and calls orderBy on the transactions query. */
function stubSelect(db: ReturnType<typeof makeDb>, rows: unknown[]) {
  const where = vi.fn().mockImplementation(() => {
    const result: unknown[] & { orderBy?: ReturnType<typeof vi.fn> } = [];
    result.orderBy = vi.fn().mockResolvedValue(rows);
    return result;
  });
  db.select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  }) as never;
}

describe("getMy", () => {
  it("returns the caller's balance and transactions", async () => {
    const db = makeDb();
    stubSelect(db, [{ id: "t1", type: "DEPOSIT", amount: "50.00", createdAt: new Date() }]);

    const res = makeRes();
    await getMy(makeReq({}, { userId: "u1", role: "USER" }), res, db as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ balance: 0, transactions: expect.any(Array) }),
      }),
    );
  });
});

describe("getAll", () => {
  it("returns 403 when the caller is not ADMIN or MANAGER", async () => {
    const db = makeDb();
    const res = makeRes();
    await getAll(makeReq({}, { userId: "u1", role: "USER" }), res, db as never);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns all accounts for an ADMIN", async () => {
    const db = makeDb();
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { userId: "u1", balance: "100.00" },
        { userId: "u2", balance: "25.50" },
      ]),
    }) as never;

    const res = makeRes();
    await getAll(makeReq({}, { userId: "admin", role: "ADMIN" }), res, db as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { userId: "u1", balance: 100 },
          { userId: "u2", balance: 25.5 },
        ],
      }),
    );
  });
});
/**
 * Transactionality: the balance movement and its ledger row must be issued
 * inside ONE db.transaction(), so Postgres commits them together.
 *
 * As noted in makeDb's comment, these assert that we USE the transaction and
 * that failures propagate — the actual rollback guarantee comes from Postgres,
 * which a fake db can't exercise.
 */
describe("transactional integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wraps the deposit balance update AND ledger insert in one transaction", async () => {
    const db = makeDb({ executeQueue: [{ rows: [{}] }, { rows: [{ balance: "100.00" }] }] });
    const res = makeRes();

    await deposit(makeReq({ amount: 100 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    // user-existence check runs outside the tx; the balance write runs inside.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "DEPOSIT", amount: "100" }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("wraps the withdraw balance update AND ledger insert in one transaction", async () => {
    const db = makeDb({ executeQueue: [{ rows: [{}] }, { rows: [{ balance: "70.00" }] }] });
    const res = makeRes();

    await withdraw(makeReq({ amount: 30 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "WITHDRAW", amount: "30" }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns 503 (not 201) when the deposit ledger insert fails, so no balance is reported as moved", async () => {
    const db = makeDb({
      executeQueue: [{ rows: [{}] }, { rows: [{ balance: "100.00" }] }],
      failInsert: true,
    });
    const res = makeRes();

    await deposit(makeReq({ amount: 100 }, { userId: "u1", role: "USER" }), res, db as never);

    // The error propagates out of the transaction (which rolls it back in
    // real Postgres) and is reported as a failure, never as a success.
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, status: 503 }),
    );
  });

  it("returns 503 when the withdraw ledger insert fails", async () => {
    const db = makeDb({
      executeQueue: [{ rows: [{}] }, { rows: [{ balance: "70.00" }] }],
      failInsert: true,
    });
    const res = makeRes();

    await withdraw(makeReq({ amount: 30 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 422 for insufficient funds without writing a ledger row", async () => {
    // Second execute (the conditional UPDATE) matches no rows.
    const db = makeDb({ executeQueue: [{ rows: [{}] }, { rows: [] }] });
    const res = makeRes();

    await withdraw(makeReq({ amount: 50 }, { userId: "u1", role: "USER" }), res, db as never);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(db.insertValues).not.toHaveBeenCalled();
  });
});

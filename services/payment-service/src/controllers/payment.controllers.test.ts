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
 *  - db.execute(sql)               -> raw SQL (user existence, deposit/withdraw)
 *  - db.insert(tbl).values(obj)    -> ledger rows (deposit/withdraw)
 *  - db.select(cols).from(tbl)...  -> reads (getMy/getAll)
 *
 * `executeQueue` is one resolved value per execute() call; pass an Error
 * inside the queue to simulate a DB failure. `select` is a stub that tests
 * replace when they exercise getMy/getAll.
 */
function makeDb({ executeQueue = [] as unknown[] } = {}) {
  let call = 0;
  const execute = vi.fn().mockImplementation(async () => {
    const next = executeQueue[call];
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const insertValues = vi.fn().mockResolvedValue({});
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const select = vi.fn(() => {
    throw new Error("select not stubbed for this test");
  });

  return { execute, insert, insertValues, select };
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
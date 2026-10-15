import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

vi.mock("../config.js", () => ({
  default: {
    JWT_SECRET: "test-secret",
    INSTANCE_ID: "test",
    PORT: 3001,
  },
}));

import { getUsers, loginUser, registerUser } from "./user.controllers.js";
import type { Request, Response } from "express";

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(body: unknown, query: Record<string, unknown> = {}) {
  // `query` defaults to {} so handlers that read pagination params (getUsers
  // reads ?limit/?offset) work with the plain makeReq({}) call sites.
  return { body, query } as Request;
}

/** Minimal chainable fake of the Drizzle query builder.
 *  Pass a thrown `Error` as `whereResult` to simulate a DB failure. */
function chainableDb(whereResult: unknown) {
  const where = vi.fn().mockImplementation(async () => {
    if (whereResult instanceof Error) throw whereResult;
    return whereResult;
  });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue({}),
  });
  return { select, insert };
}

describe("registerUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when required fields are missing", async () => {
    const res = makeRes();
    await registerUser(makeReq({ email: "a@b.com", role: "USER" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns 400 for an invalid role", async () => {
    const res = makeRes();
    await registerUser(
      makeReq({ userId: "u1", email: "a@b.com", password: "pw", role: "GOD" }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns 409 when the email is already registered", async () => {
    const db = chainableDb([{ id: "existing" }]);
    const res = makeRes();
    await registerUser(
      makeReq({ userId: "u1", email: "dup@b.com", password: "pw", role: "USER" }),
      res,
      db as never,
    );
    expect(db.select).toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("returns 503 when the database throws", async () => {
    const db = chainableDb(new Error("db down"));
    const res = makeRes();
    await registerUser(
      makeReq({ userId: "u1", email: "a@b.com", password: "pw", role: "USER" }),
      res,
      db as never,
    );
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 201 with the created user (no token) and stores a bcrypt hash, never plaintext", async () => {
    const db = chainableDb([]);
    const res = makeRes();
    await registerUser(
      makeReq({ userId: "u1", email: "a@b.com", password: "hunter2", role: "ADMIN" }),
      res,
      db as never,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = res.json.mock.calls[0]?.[0] as { data: { userId: string; email: string; role: string } };
    expect(jsonArg.data).toEqual({ userId: "u1", email: "a@b.com", role: "ADMIN" });

    const insertedValues = db.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(insertedValues.passwordHash).not.toBe("hunter2");
    expect(insertedValues.passwordHash).toMatch(/^\$2[aby]\$/);
  });
});

describe("loginUser", () => {
  const VALID_JWT = "test-secret";
  const HASHED = bcrypt.hashSync("hunter2", 10);
  const knownUser = [{ userId: "u1", email: "a@b.com", role: "ADMIN", passwordHash: HASHED }];

  /** Fake of the query builder whose `where` returns the given rows. */
  function dbReturning(rows: unknown) {
    const where = vi.fn().mockImplementation(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    });
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
    } as never;
  }

  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when required fields are missing", async () => {
    const res = makeRes();
    await loginUser(makeReq({ email: "a@b.com" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns 401 for an unknown email", async () => {
    const res = makeRes();
    await loginUser(makeReq({ email: "ghost@b.com", password: "pw" }), res, dbReturning([]));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("returns 401 for a wrong password", async () => {
    const res = makeRes();
    await loginUser(
      makeReq({ email: "a@b.com", password: "wrong" }),
      res,
      dbReturning(knownUser),
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 200 with a JWT carrying the role from the DB row", async () => {
    const res = makeRes();
    await loginUser(
      makeReq({ email: "a@b.com", password: "hunter2" }),
      res,
      dbReturning(knownUser),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const jsonArg = res.json.mock.calls[0]?.[0] as { data: { token: string } };
    const payload = jwt.verify(jsonArg.data.token, VALID_JWT) as { userId: string; role: string };
    expect(payload.userId).toBe("u1");
    expect(payload.role).toBe("ADMIN");
  });

  it("returns 503 when the database throws", async () => {
    const res = makeRes();
    await loginUser(
      makeReq({ email: "a@b.com", password: "hunter2" }),
      res,
      dbReturning(new Error("db down")),
    );
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("getUsers", () => {
  /**
   * getUsers is PAGINATED (?limit= default 50 max 200, ?offset=), so the fake
   * db has to be a full query-builder chain: select().from().orderBy().limit()
   * .offset(), plus a second select() for the COUNT. `from()` returning a
   * single thenable object would break the chain, hence building it explicitly.
   */
  function paginatedDb(rows: unknown[]) {
    // Chain order in the controller is
    //   select().from().orderBy().limit().offset()   <- the page
    //   select({count}).from()                       <- the total (awaited directly)
    //
    // So `from()` has to satisfy two shapes: chaining onward AND being
    // awaitable as an array. Returning a real array with the chain methods
    // attached satisfies both — `await` yields the array, while .orderBy() etc.
    // still work on it.
    const offset = vi.fn().mockResolvedValue(rows);
    const limit = vi.fn(() => ({ offset }));
    const orderBy = vi.fn(() => ({ limit }));

    const pageResult = [] as unknown as unknown[] & Record<string, unknown>;
    pageResult.orderBy = orderBy;
    pageResult.limit = limit;

    // The count query resolves to a one-row shape like [{ count: n }].
    const countResult = [{ count: rows.length }];
    let call = 0;
    const from = vi.fn(() => (call++ === 0 ? pageResult : countResult));

    const select = vi.fn(() => ({ from }));
    return { db: { select } as never, limit, offset, orderBy, from, select };
  }

  it("returns the rows under data.users with pagination metadata", async () => {
    const rows = [{ id: "u1", email: "a@b.com", name: "A", role: "USER", createdAt: new Date() }];
    const { db, limit, offset } = paginatedDb(rows);
    const res = makeRes();

    await getUsers(makeReq({}, {}), res, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: {
          users: rows,
          pagination: { limit: 50, offset: 0, total: 1 },
        },
      }),
    );
    // Default page size is applied by default.
    expect(limit).toHaveBeenCalledWith(50);
    expect(offset).toHaveBeenCalledWith(0);
  });

  it("honours ?limit and ?offset from the query string", async () => {
    const { db, limit, offset } = paginatedDb([]);
    const res = makeRes();

    await getUsers(makeReq({}, { limit: "10", offset: "20" }), res, db);

    expect(limit).toHaveBeenCalledWith(10);
    expect(offset).toHaveBeenCalledWith(20);
  });

  it("clamps an oversized ?limit to the 200 maximum", async () => {
    const { db, limit } = paginatedDb([]);
    const res = makeRes();

    await getUsers(makeReq({}, { limit: "100000" }), res, db);

    // Unbounded page sizes are exactly the problem pagination is fixing.
    expect(limit).toHaveBeenCalledWith(200);
  });

  it("falls back to defaults for a malformed ?limit rather than erroring", async () => {
    const { db, limit, offset } = paginatedDb([]);
    const res = makeRes();

    await getUsers(makeReq({}, { limit: "abc", offset: "-5" }), res, db);

    expect(limit).toHaveBeenCalledWith(50);
    expect(offset).toHaveBeenCalledWith(0);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
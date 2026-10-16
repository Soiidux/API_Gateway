import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

vi.mock("../config.js", () => ({
  default: {
    JWT_SECRET: "test-secret",
    INSTANCE_ID: "test",
    PORT: 1,
    // loginUser signs with `expiresIn: config.TOKEN_TTL`, so the mock must
    // provide it or jwt.sign throws on undefined.
    TOKEN_TTL: 3600,
  },
}));

// The revocation store is a real Redis connection at import time; stub the
// module so unit tests never touch the network.
vi.mock("../db/redisClient.js", () => ({
  default: { get: vi.fn(), set: vi.fn(), quit: vi.fn() },
  revokeUserTokens: vi.fn().mockResolvedValue(undefined),
  isRevoked: vi.fn().mockResolvedValue(false),
  revokedKey: (id: string) => `revoked:${id}`,
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

import { getUsers, loginUser, logout, registerUser } from "./user.controllers.js";
import { revokeUserTokens } from "../db/redisClient.js";
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
/**
 * Logout / token revocation.
 *
 * A JWT is self-contained, so deleting the client's copy doesn't un-issue it.
 * Logout writes `revoked:<userId> = <now>` to Redis, and the gateway rejects
 * any token whose `iat` is at or before that moment.
 *
 * These tests pin the two behaviours that are easy to get wrong:
 *  - the identity comes from req.auth (the verified token), never the body, so
 *    nobody can revoke someone else's sessions by guessing a userId;
 *  - a failed write reports 503 rather than pretending success, because a
 *    client told "logged out" when nothing was revoked is worse off than one
 *    told the truth.
 */
describe("logout", () => {
  beforeEach(() => vi.clearAllMocks());

  function authedReq(userId: string) {
    return { body: {}, auth: { userId, role: "USER" } } as unknown as Request;
  }

  it("records a revocation marker keyed by the verified userId", async () => {
    const res = makeRes();

    await logout(authedReq("u1"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(revokeUserTokens).toHaveBeenCalledTimes(1);
    // Second arg must be integer epoch seconds — the JWT `iat` claim is an
    // integer, so a fractional marker breaks the comparison boundary.
    const [, at] = (revokeUserTokens as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBeGreaterThan(0);
  });

  it("ignores any userId in the request body and revokes only the token's user", async () => {
    const res = makeRes();
    const req = {
      body: { userId: "victim" },
      auth: { userId: "attacker", role: "USER" },
    } as unknown as Request;

    await logout(req, res);

    // The body's userId must be ignored entirely — otherwise anyone could
    // revoke another account's sessions.
    expect(revokeUserTokens).toHaveBeenCalledWith("attacker", expect.any(Number));
  });

  it("returns 401 when there is no verified identity", async () => {
    const res = makeRes();

    await logout({ body: {} } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(revokeUserTokens).not.toHaveBeenCalled();
  });

  it("returns 503 when the revocation marker could NOT be written", async () => {
    (revokeUserTokens as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("redis down"),
    );
    const res = makeRes();

    await logout(authedReq("u1"), res);

    // Reporting 200 here would tell the user they're safe when they are not.
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("is idempotent — a second logout still succeeds", async () => {
    const res1 = makeRes();
    const res2 = makeRes();

    await logout(authedReq("u1"), res1);
    await logout(authedReq("u1"), res2);

    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res2.status).toHaveBeenCalledWith(200);
  });
});

describe("token lifetime", () => {
  it("issues a token whose exp - iat equals TOKEN_TTL (1 hour), not 7 days", async () => {
    // loginUser issues a token, so this test is really about the signing
    // config rather than the DB — the fake just has to satisfy the handler.
    const db = chainableDb([
      { userId: "u1", email: "a@b.com", role: "USER", passwordHash: "h" },
    ]);
    // Real bcrypt round-trip rather than a spy: this test only cares about the
    // SIGNING config (expiresIn), so the password check just has to pass.
    const realHash = bcrypt.hashSync("x", 4); // low rounds: speed, not security
    const ttlRes = makeRes();

    await loginUser(
      makeReq({ email: "a@b.com", password: "x" }),
      ttlRes,
      chainableDb([{ userId: "u1", email: "a@b.com", role: "USER", passwordHash: realHash }]) as never,
    );

    const token = (ttlRes.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].data.token;
    const decoded = jwt.decode(token) as { iat: number; exp: number };

    expect(decoded.exp - decoded.iat).toBe(3600);
    // 7 days was the old value; assert the change explicitly so a silent
    // reversion to a week-long token is caught here.
    expect(decoded.exp - decoded.iat).not.toBe(7 * 24 * 3600);
  });
});

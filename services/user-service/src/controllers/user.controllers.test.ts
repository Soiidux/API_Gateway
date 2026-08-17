import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../config.js", () => ({
  default: {
    JWT_SECRET: "test-secret",
    INSTANCE_ID: "test",
    PORT: 3001,
  },
}));

import { getUsers, registerUser } from "./user.controllers.js";
import type { Request, Response } from "express";

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(body: unknown) {
  return { body } as Request;
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

const VALID_JWT = "test-secret";

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

  it("returns 201 with a JWT and stores a bcrypt hash, never plaintext", async () => {
    const db = chainableDb([]);
    const res = makeRes();
    await registerUser(
      makeReq({ userId: "u1", email: "a@b.com", password: "hunter2", role: "ADMIN" }),
      res,
      db as never,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = res.json.mock.calls[0]?.[0] as { data: string };
    const payload = jwt.verify(jsonArg.data, VALID_JWT) as { userId: string; role: string };
    expect(payload.userId).toBe("u1");
    expect(payload.role).toBe("ADMIN");

    const inserted = db.insert.mock.calls[0]?.[0];
    const insertedValues = db.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(inserted).toBeDefined();
    expect(insertedValues.passwordHash).not.toBe("hunter2");
    expect(insertedValues.passwordHash).toMatch(/^\$2[aby]\$/);
  });
});

describe("getUsers", () => {
  it("returns the rows from the database", async () => {
    const rows = [{ id: "u1", email: "a@b.com", name: "A", role: "USER", createdAt: new Date() }];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
      }),
    };
    const res = makeRes();

    await getUsers(makeReq({}), res, db as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: rows, success: true }),
    );
  });
});
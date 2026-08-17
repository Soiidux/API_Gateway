import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  default: { JWT_SECRET: "test-secret" },
}));

import jwt from "jsonwebtoken";
import { requireAuth } from "./requireAuth.js";
import type { NextFunction, Request, Response } from "express";

function makeStubs() {
  const headers: Record<string, unknown> = {};
  const req = { headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next, headers };
}

describe("requireAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when no Authorization header is present", () => {
    const { req, res, next } = makeStubs();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a token that fails verification", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = "Bearer tampered.token.here";
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a header without the Bearer prefix", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = jwt.sign({ userId: "u1", role: "ADMIN" }, "test-secret");
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("attaches the verified payload to req.auth and calls next", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${jwt.sign({ userId: "u1", role: "MANAGER" }, "test-secret")}`;

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Request & { auth?: { userId: string; role: string } }).auth).toEqual(
      expect.objectContaining({ userId: "u1", role: "MANAGER" }),
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects a token signed with a different secret", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${jwt.sign({ userId: "u1", role: "ADMIN" }, "wrong-secret")}`;
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
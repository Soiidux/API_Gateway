import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../config.js", () => ({
  default: { JWT_SECRET: "test-secret" },
}));

import { requireAuth } from "./requireAuth.js";
import type { NextFunction, Request, Response } from "express";

function makeStubs() {
  const req = { headers: {} } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
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
    const { req, res, next } = makeStubs();
    req.headers["authorization"] = "Bearer tampered.token.here";
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("attaches the verified payload to req.auth and calls next", () => {
    const token = jwt.sign({ userId: "u1", role: "USER" }, "test-secret");
    const { req, res, next } = makeStubs();
    req.headers["authorization"] = `Bearer ${token}`;
    requireAuth(req, res, next);

    expect(req.auth).toMatchObject({ userId: "u1", role: "USER" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
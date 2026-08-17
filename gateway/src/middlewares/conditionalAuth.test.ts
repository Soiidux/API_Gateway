import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  default: { JWT_SECRET: "test-secret" },
}));

import jwt from "jsonwebtoken";
import conditionalAuth from "./conditionalAuth.js";
import type { NextFunction, Request, Response } from "express";

function makeStubs(path = "/getAll") {
  const headers: Record<string, unknown> = {};
  const req = { path, headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next, headers };
}

function sign(role: string): string {
  return jwt.sign({ userId: "u1", role }, "test-secret", { expiresIn: "1h" });
}

describe("conditionalAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows public routes without a token", () => {
    const { req, res, next } = makeStubs("/register");

    conditionalAuth(["/register"])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when no token is present", () => {
    const { req, res, next } = makeStubs();

    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("returns 401 for a malformed Authorization header", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = "NotBearer something";

    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 for a tampered/invalid token", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = "Bearer not.a.valid.jwt";

    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 when the role is not permitted for the route", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${sign("USER")}`;

    conditionalAuth([], { "/getAll": ["ADMIN", "MANAGER"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("sets x-user-id / x-user-role and calls next for a permitted role", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers["x-user-id"]).toBe("u1");
    expect(req.headers["x-user-role"]).toBe("ADMIN");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("falls back to defaultRoles when the route is not in the roleMap", () => {
    const { req, res, next, headers } = makeStubs("/anywhere");
    headers["authorization"] = `Bearer ${sign("USER")}`;

    // defaultRoles = ["ADMIN"] -> USER should be rejected
    conditionalAuth([], {}, ["ADMIN"])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
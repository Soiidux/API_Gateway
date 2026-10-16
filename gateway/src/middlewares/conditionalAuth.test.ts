import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  default: { JWT_SECRET: "test-secret", TOKEN_TTL: 3600 },
}));

// The revocation store is a real Redis connection at import time. Stub the
// module so these tests stay offline; the revocation logic itself is covered
// in tokenRevocation.test.ts.
vi.mock("../utils/tokenRevocation.js", () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
  revokedKey: (id: string) => `revoked:${id}`,
}));

import jwt from "jsonwebtoken";
import conditionalAuth from "./conditionalAuth.js";
import { isRevoked } from "../utils/tokenRevocation.js";
import type { NextFunction, Request, Response } from "express";

const revoked = () => isRevoked as unknown as ReturnType<typeof vi.fn>;

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

    // Synchronous: the no-token path returns before the revocation await.
    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 for a tampered/invalid token", () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = "Bearer not.a.valid.jwt";

    conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 when the role is not permitted for the route", async () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${sign("USER")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN", "MANAGER"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("sets x-user-id / x-user-role and calls next for a permitted role", async () => {
    const { req, res, next, headers } = makeStubs();
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers["x-user-id"]).toBe("u1");
    expect(req.headers["x-user-role"]).toBe("ADMIN");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("falls back to defaultRoles when the route is not in the roleMap", async () => {
    const { req, res, next, headers } = makeStubs("/anywhere");
    headers["authorization"] = `Bearer ${sign("USER")}`;

    // defaultRoles = ["ADMIN"] -> USER should be rejected
    await conditionalAuth([], {}, ["ADMIN"])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  /**
   * Header-stripping (security regression tests).
   *
   * These headers are set FROM a verified JWT and are trusted downstream by
   * rateLimitMiddleware (which picks its bucket from `x-user-id`) and
   * cacheKey (which scopes cached responses by it). HTTP headers are
   * caller-controlled, so a forged `x-user-id` arriving on a PUBLIC route —
   * where this middleware returns early, before it would overwrite anything —
   * used to make an anonymous request look authenticated. That handed the
   * attacker the 20-token bucket instead of the 2-token one, and rotating the
   * header per request got a fresh bucket every time: unlimited throughput
   * against endpoints that bcrypt-hash passwords.
   *
   * The fix is to delete both headers unconditionally before any branching.
   * These tests pin that behaviour so it can't regress silently.
   */
  describe("strips caller-supplied identity headers", () => {
    it("removes forged x-user-id / x-user-role on a PUBLIC route", () => {
      const { req, res, next, headers } = makeStubs("/register");
      headers["x-user-id"] = "forged-id";
      headers["x-user-role"] = "ADMIN";

      conditionalAuth(["/register"])(req, res, next);

      // Route is public, so no token is required...
      expect(next).toHaveBeenCalledTimes(1);
      // ...but the request must carry NO identity, so downstream cannot
      // mistake it for an authenticated caller.
      expect(req.headers["x-user-id"]).toBeUndefined();
      expect(req.headers["x-user-role"]).toBeUndefined();
    });

    it("removes forged headers even when the route is public AND a token is sent", () => {
      const { req, res, next, headers } = makeStubs("/register");
      headers["x-user-id"] = "forged-id";
      headers["x-user-role"] = "ADMIN";
      headers["authorization"] = `Bearer ${sign("USER")}`;

      conditionalAuth(["/register"])(req, res, next);

      // Public routes short-circuit before any JWT verification, so the
      // forged headers must not survive the early return.
      expect(req.headers["x-user-id"]).toBeUndefined();
      expect(req.headers["x-user-role"]).toBeUndefined();
    });

    it("overwrites forged headers with the verified identity on a protected route", async () => {
      const { req, res, next, headers } = makeStubs("/getAll");
      headers["authorization"] = `Bearer ${sign("ADMIN")}`;
      headers["x-user-id"] = "forged-id";
      headers["x-user-role"] = "USER";

      await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(req.headers["x-user-id"]).toBe("u1");      // from the token...
      expect(req.headers["x-user-role"]).toBe("ADMIN");  // ...not the client's
    });

    it("leaves no forged identity behind on a 401 rejection", () => {
      const { req, res, next, headers } = makeStubs();
      headers["x-user-id"] = "forged-id";
      headers["x-user-role"] = "ADMIN";

      conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      // Even a rejected request must not carry a forged identity onward.
      expect(req.headers["x-user-id"]).toBeUndefined();
      expect(req.headers["x-user-role"]).toBeUndefined();
    });
  });
});
/**
 * Revocation integration in conditionalAuth.
 *
 * A valid signature is necessary but NOT sufficient: the user may have logged
 * out since the token was minted. These pin that the check actually happens
 * before the token's role is trusted, and that a revoked token gets no identity
 * headers attached even if it would otherwise pass RBAC.
 */
describe("conditionalAuth — revoked tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revoked().mockResolvedValue(false);
  });

  it("checks revocation with the token's userId and iat after verifying the JWT", async () => {
    const { req, res, next, headers } = makeStubs("/getAll");
    const token = sign("ADMIN");
    headers["authorization"] = `Bearer ${token}`;
    const decoded = jwt.decode(token) as { userId: string; iat: number };

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(revoked()).toHaveBeenCalledWith("u1", decoded.iat);
  });

  it("returns 401 and does NOT authenticate a revoked token", async () => {
    revoked().mockResolvedValue(true);
    const { req, res, next, headers } = makeStubs("/getAll");
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    // Critically: no identity headers, so nothing downstream can act on it.
    expect(next).not.toHaveBeenCalled();
    expect(req.headers["x-user-id"]).toBeUndefined();
    expect(req.headers["x-user-role"]).toBeUndefined();
  });

  it("rejects a revoked token even when its role would be permitted", async () => {
    revoked().mockResolvedValue(true);
    const { req, res, next, headers } = makeStubs("/getAll");
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    // Revocation is checked BEFORE the role check, so a still-valid signature
    // carrying ADMIN gains nothing.
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows a non-revoked token through normally", async () => {
    const { req, res, next, headers } = makeStubs("/getAll");
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers["x-user-id"]).toBe("u1");
  });

  it("does not consult the revocation store for a PUBLIC route (no identity to check)", async () => {
    const { req, res, next } = makeStubs("/register");

    await conditionalAuth(["/register"])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(revoked()).not.toHaveBeenCalled();
  });
});

/**
 * JWT algorithm pinning.
 *
 * `verify` is called with `algorithms: ["HS256"]` rather than jsonwebtoken's
 * default of "whatever the header claims, as long as it works with this key".
 * This isn't exploitable today — we sign with a symmetric secret and v9
 * rejects `alg: none` — but pinning means a future key-type change can't
 * silently widen what this endpoint accepts.
 */
describe("conditionalAuth — algorithm pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revoked().mockResolvedValue(false);
  });

  it("accepts a token signed with HS256 (the algorithm we issue)", async () => {
    const { req, res, next, headers } = makeStubs("/getAll");
    headers["authorization"] = `Bearer ${sign("ADMIN")}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers["x-user-id"]).toBe("u1");
  });

  it("rejects an unsigned token (alg: none)", async () => {
    const { req, res, next, headers } = makeStubs("/getAll");
    // header.payload. with an empty signature and alg: none.
    //
    // NOTE: this passes with OR without the algorithms pin — jsonwebtoken v9
    // rejects `none` regardless. Kept as a regression guard on that behaviour,
    // since a downgrade would reintroduce the classic unsigned-token bypass.
    const unsigned =
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ userId: "u1", role: "ADMIN" })).toString("base64url") +
      ".";
    headers["authorization"] = `Bearer ${unsigned}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token declaring an algorithm outside the allowlist", async () => {
    const { req, res, next, headers } = makeStubs("/getAll");
    // Correctly signed with the same secret, but claims a different algorithm.
    // Without pinning, "does it work with this key" would be the only test.
    const swapped =
      Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ userId: "u1", role: "ADMIN" })).toString("base64url") +
      "." +
      require("node:crypto")
        .createHmac("sha512", "test-secret")
        .update(
          Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url") +
            "." +
            Buffer.from(JSON.stringify({ userId: "u1", role: "ADMIN" })).toString("base64url"),
        )
        .digest("base64url");
    headers["authorization"] = `Bearer ${swapped}`;

    await conditionalAuth([], { "/getAll": ["ADMIN"] })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

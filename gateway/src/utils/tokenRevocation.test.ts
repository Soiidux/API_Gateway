/**
 * Token revocation (gateway side).
 *
 * The comparison rule is the whole feature: a token is revoked when its `iat`
 * is at or before the recorded logout time. Everything else here exists to pin
 * the edges of that rule and, more importantly, the FAIL-OPEN behavior when
 * Redis is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/redisClient.js", () => ({
  default: { get: vi.fn(), set: vi.fn(), quit: vi.fn() },
}));

vi.mock("../config.js", () => ({
  default: { JWT_SECRET: "test-secret", TOKEN_TTL: 3600 },
}));

import redisClient from "../db/redisClient.js";
import { isRevoked, revokedKey } from "./tokenRevocation.js";

const get = () => redisClient.get as unknown as ReturnType<typeof vi.fn>;

describe("isRevoked", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a per-user key", () => {
    expect(revokedKey("alice")).toBe("revoked:alice");
  });

  it("is false when no revocation has ever been recorded", async () => {
    get().mockResolvedValue(null);
    expect(await isRevoked("alice", 1000)).toBe(false);
  });

  it("is false for a token issued AFTER the logout", async () => {
    get().mockResolvedValue("1000");
    expect(await isRevoked("alice", 1001)).toBe(false);
  });

  it("is true for a token issued BEFORE the logout", async () => {
    get().mockResolvedValue("2000");
    expect(await isRevoked("alice", 1000)).toBe(true);
  });

  it("treats a same-second token as revoked (iat <= revokedAt)", async () => {
    get().mockResolvedValue("2000");
    // `<=` not `<`: logging back in within the same second isn't a real
    // scenario, whereas racing a deliberate logout is.
    expect(await isRevoked("alice", 2000)).toBe(true);
  });

  it("is false when the token carries no usable iat", async () => {
    // Locking out every token that lacks the claim would be worse than
    // failing to judge it.
    expect(await isRevoked("alice", undefined)).toBe(false);
    expect(await isRevoked("alice", Number.NaN)).toBe(false);
  });

  it("is false when the stored value is garbage", async () => {
    get().mockResolvedValue("not-a-number");
    expect(await isRevoked("alice", 1000)).toBe(false);
  });

  it("FAILS OPEN when Redis errors — a dependency outage must not log everyone out", async () => {
    get().mockRejectedValue(new Error("ECONNREFUSED"));
    // This is the deliberate trade: availability wins over the revocation
    // guarantee, bounded by TOKEN_TTL because a leaked token still expires.
    expect(await isRevoked("alice", 1000)).toBe(false);
  });
});

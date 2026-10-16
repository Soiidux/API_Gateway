/**
 * Redis client for the user-service — the REVOCATION store.
 *
 * This service doesn't cache or rate-limit; it uses Redis for exactly one
 * thing: recording that a user's tokens have been revoked (see
 * controllers/user.controllers.ts `logout`).
 *
 * Why a separate client from the gateway's: they're different processes with
 * different lifetimes and different failure modes. Sharing a connection isn't
 * possible across a container boundary anyway — each process needs its own.
 *
 * FAIL-OPEN philosophy (and it is a deliberate choice, not an oversight):
 * revocation is a security convenience layered on top of token expiry, not the
 * primary control. If Redis is unreachable, `isRevoked()` returns false and
 * the user is NOT logged out — the app stays available, and the blast radius
 * of the outage is bounded by TOKEN_TTL, because a stolen token still expires
 * on schedule regardless of whether we can check a deny-list.
 *
 * That's why TOKEN_TTL is short (1h). If the deny-list were the ONLY control,
 * failing open here would silently restore every revoked token. Paired with a
 * short expiry, failing open costs at most one hour of exposure instead of a
 * week.
 *
 * This is the mirror image of the rate limiter, which fails CLOSED (surfaces
 * 500 on a Redis error) because letting unbounded traffic through during an
 * outage is worse than rejecting it. Different dependency, different failure
 * mode worth worrying about.
 */
import { Redis } from "ioredis";
import config from "../config.js";

const redisClient = new Redis(config.REDIS_URL);

redisClient.on("connect", () => {
  console.log("[User Service] Redis connected (revocation store)");
});

redisClient.on("error", (err: Error) => {
  // Never throw from an event handler — an unhandled error here would crash
  // the process. Revocation failing open is the intended behavior.
  console.error("[User Service] Redis error:", err.message);
});

/** Revocation key for a user. One key per user, not per token. */
export function revokedKey(userId: string): string {
  return `revoked:${userId}`;
}

/**
 * Has this user's token been revoked as of `issuedAtEpochSeconds`?
 *
 * Returns true (treat as revoked) only when we positively know the token
 * predates a revocation. Any error or missing key returns false — see the
 * fail-open note above.
 */
export async function isRevoked(userId: string, issuedAtEpochSeconds: number): Promise<boolean> {
  try {
    const revokedAt = await redisClient.get(revokedKey(userId));
    if (revokedAt === null) return false;
    const revokedAtSeconds = Number(revokedAt);
    if (!Number.isFinite(revokedAtSeconds)) return false;
    // `<=` rather than `<`: a token minted in the same second as the logout
    // should also be treated as revoked. Logging out and back in within one
    // second is not a real scenario, whereas an attacker racing a logout is.
    return issuedAtEpochSeconds <= revokedAtSeconds;
  } catch (error) {
    console.error("[User Service] Revocation check failed, failing open:", error);
    return false;
  }
}

/**
 * Revoke every token this user currently holds, by recording "everything
 * issued at or before now is dead".
 *
 * The key expires after TOKEN_TTL seconds, because after that point NO token
 * issued before the revocation can still be valid — so the record is useless
 * and can be dropped. That bounds the key space by user count rather than by
 * how many times anyone has logged out.
 */
export async function revokeUserTokens(userId: string, nowEpochSeconds: number): Promise<void> {
  const key = revokedKey(userId);
  const seconds = Math.max(config.TOKEN_TTL, 60);
  await redisClient.set(key, String(nowEpochSeconds), "EX", seconds);
}

/** Graceful shutdown: close the connection with the rest of the resources. */
export async function closeRedis(): Promise<void> {
  try {
    await redisClient.quit();
  } catch {
    // Already closed or unreachable — nothing useful to do during shutdown.
  }
}

export default redisClient;
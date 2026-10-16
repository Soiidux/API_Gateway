/**
 * Token revocation, gateway side.
 *
 * A JWT is self-contained: nobody asks the server "is this still valid?", we
 * just check the signature and trust the payload. That is fast, and it is also
 * why a token cannot be taken back — logging out only deletes the CLIENT's
 * copy, while a copy stolen elsewhere keeps working until it expires.
 *
 * The fix is a deny-list keyed by USER, not by token:
 *
 *     logout:  SET revoked:<userId>  <epoch seconds>
 *     verify:  reject if the token's `iat` <= that value
 *
 * One key per user rather than one per token, so the key space is bounded by
 * user count and the entry can self-expire (TTL = TOKEN_TTL, after which no
 * pre-revocation token can still be alive).
 *
 * A useful side effect: this also handles role changes. A token minted while
 * someone was an admin still says "ADMIN" in its payload; bumping their
 * revocation time kills that immediately instead of waiting out the expiry.
 *
 * FAIL-OPEN — deliberate, and the reasoning matters:
 *
 * This lookup sits on EVERY authenticated request, so Redis is now on the
 * critical path for all authenticated traffic. If it fails, we treat the
 * token as NOT revoked and let the request through.
 *
 * That is safe only because it is paired with a short TOKEN_TTL. Revocation is
 * a convenience layer over expiry, not the primary control: a leaked token
 * dies at its `exp` whether or not Redis was reachable. So a Redis outage costs
 * at most TOKEN_TTL of exposure for a token whose owner explicitly logged out
 * — bounded and small — instead of taking authentication down entirely.
 *
 * Failing CLOSED here would invert that: an outage in a single dependency
 * would lock every user out of a system that was working fine a second ago.
 *
 * (Note the deliberate asymmetry with the rate limiter, which fails CLOSED.
 * Different dependency, opposite failure mode worth worrying about: there, an
 * outage that lets unbounded traffic through is worse than one that rejects
 * requests. Here, it's the reverse.)
 */
import redisClient from "../db/redisClient.js";

/** Revocation key for a user. Must match user-service's revokedKey(). */
export function revokedKey(userId: string): string {
  return `revoked:${userId}`;
}

/**
 * Is this specific token revoked?
 *
 * `iat` is the token's issued-at time in epoch seconds (jsonwebtoken adds it
 * automatically). Returns true only when we positively know the token predates
 * a revocation; a missing key or a Redis error returns false.
 */
export async function isRevoked(
  userId: string,
  issuedAt: number | undefined,
): Promise<boolean> {
  // No `iat` means we can't place the token on a timeline, so we can't judge
  // it against a revocation point. Treat as NOT revoked rather than locking
  // out every token that somehow lacks the claim.
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return false;

  try {
    const revokedAt = await redisClient.get(revokedKey(userId));
    if (revokedAt === null) return false;
    const revokedAtSeconds = Number(revokedAt);
    if (!Number.isFinite(revokedAtSeconds)) return false;
    // `<=`, not `<`: a token minted in the same second as the logout should
    // also count as revoked. Logging back in within one second isn't a real
    // scenario, whereas racing a deliberate logout is.
    return issuedAt <= revokedAtSeconds;
  } catch (error) {
    // Fail open — see the module note. Bounded by TOKEN_TTL.
    console.error("[Gateway] Revocation check failed, failing open:", error);
    return false;
  }
}
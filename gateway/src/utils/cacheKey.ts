import type { Request } from "express";

/**
 * Builds the Redis key under which a response is cached.
 *
 * Keyed by method + URL so the same read gets the same key. When the
 * request is authenticated (conditionalAuth has already stamped
 * x-user-id) the key is ALSO scoped by the user id — two different
 * users never share a cached entry, which keeps per-user data from
 * leaking across a shared cache. Anonymous requests share an "anon"
 * bucket (safe, since they carry no identity).
 */
function buildCacheKey(req: Request): string {
  const { method, originalUrl } = req;
  const userId = req.headers["x-user-id"] ?? "anon";
  return `cache:${userId}:${method}:${originalUrl}`;
}

export default buildCacheKey;

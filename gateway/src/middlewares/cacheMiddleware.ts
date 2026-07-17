import type { Request, Response, NextFunction } from "express";
import buildCacheKey from "../utils/cacheKey.js";
import redisClient from "../db/redisClient.js";

/**
 * cacheMiddleware
 * ----------------
 * Checks Redis for a cached response BEFORE the request reaches the
 * proxy/backend. On a cache hit, responds immediately and skips
 * everything downstream (proxy, backend service, all of it).
 * On a miss, lets the request continue as normal — the actual
 * writing to the cache happens later, in the proxy's response
 * handler, once the backend's real response comes back.
 *
 * @param cacheableRoutes - map of route path -> { ttl } (seconds).
 *   Only routes explicitly listed here are ever checked/cached.
 *   Example: { "/getAll": { ttl: 30 } }
 */
const cacheMiddleware = (cacheableRoutes: Record<string, { ttl: number }>) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // only GET requests are safe to cache — POST/PUT/DELETE mutate
    // state and must always hit the real backend
    if (req.method !== "GET") return next();

    const relPath = req.path;

    // check if this route was explicitly opted into caching.
    // matches either an exact path ("/getAll") or a sub-path
    // ("/getAll/something") under a configured prefix
    const matchKey = Object.keys(cacheableRoutes).find(
      r => relPath === r || relPath.startsWith(`${r}/`),
    );

    // not a cacheable route -> skip caching entirely, proceed normally
    if (!matchKey) return next();

    // build the Redis key this request's response would be stored under
    // (e.g. includes method + path + query, possibly user id — see buildCacheKey)
    const cacheKey = buildCacheKey(req);

    // stash the key + this route's TTL on req, so the proxy's response
    // handler (later in the chain) knows what to store the eventual
    // backend response under, and for how long
    req.cacheKey = cacheKey;
    req.cacheTTL = cacheableRoutes[matchKey]?.ttl ?? 0;

    try {
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        console.log("cache hit", cacheKey);

        // cached is a JSON string wrapping the ORIGINAL response's
        // status code, body (itself already a JSON string), and
        // content-type — reconstructed exactly as the backend sent it
        const { status, body, contentType } = JSON.parse(cached);

        res.setHeader("Content-Type", contentType);
        res.setHeader("x-cache", "HIT"); // lets callers/curl see whether this was served from cache

        // use .send(), not .json() — `body` is ALREADY a JSON string
        // (it was stored as text). .json() would stringify it AGAIN,
        // producing double-escaped output like \"key\":\"value\"
        return res.status(status).send(body);
      }
    } catch (error) {
      // Redis being down/erroring should never break the actual
      // request — log it and fall through to the real backend,
      // same as a cache miss (fail open, not fail closed)
      console.error(error);
    }

    // no cached entry (or Redis errored) -> proceed to the real
    // backend as normal; something downstream is responsible for
    // actually writing the response into the cache once it comes back
    console.log("cache miss", cacheKey);
    res.setHeader("x-cache", "MISS");
    next();
  };
};

export default cacheMiddleware;
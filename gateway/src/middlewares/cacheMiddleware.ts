/**
 * Cache read path, at the edge of the gateway.
 *
 * Rationale: /getAll returns the same data to everyone, so hitting N
 * backend replicas per request is wasteful. This middleware only READS
 * Redis on the way in:
 *   - HIT  → reply immediately, never reach the backend
 *   - MISS → call next(); the WRITE happens later in
 *            ProxyUtil.handleProxyResponse once the backend answers.
 * The key + TTL are stashed on req.cacheKey / req.cacheTTL so that
 * response handler (a different function) knows where to store the data.
 *
 * `req.cacheKey` is not a real Express field — it's added by augmenting
 * the Request type in src/types/express.d.ts.
 */
import type { NextFunction, Request, Response } from "express";
import buildCacheKey from "../utils/cacheKey.js";
import redisClient from "../db/redisClient.js";
import logPublisher from "../utils/rabbitMq/index.js";

export class CacheMiddleware {
  /**
   * Factory. Takes the per-service cacheableRoutes map so the returned
   * middleware knows which routes to cache and for how long.
   *   e.g. { "/getAll": { ttl: 900000 } }
   */
  static create(cacheableRoutes: Record<string, { ttl: number }>) {
    return async (req: Request, res: Response, next: NextFunction) => {
      // only GET requests are safe to cache — POST/PUT/DELETE mutate
      // state and must always hit the real backend
      if (req.method !== "GET") return next();

      const relPath = req.path;

      // check if this route was explicitly opted into caching.
      // matches either an exact path ("/getAll") or a sub-path
      // ("/getAll/something") under a configured prefix
      const matchKey = Object.keys(cacheableRoutes).find(
        (r) => relPath === r || relPath.startsWith(`${r}/`),
      );

      // not a cacheable route -> skip caching entirely, proceed normally
      if (!matchKey) return next();

      // build the Redis key this request's response would be stored under
      // (method + URL, scoped by x-user-id when authenticated — see
      // utils/cacheKey.ts: two users never share a cache entry)
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
          // NEW: publish a hit event so the logs show cache effectiveness.
          void logPublisher.publishEvent("info", "Cache hit", { cacheKey });

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
      void logPublisher.publishEvent("info", "Cache miss", { cacheKey });
      res.setHeader("x-cache", "MISS");
      next();
    };
  }
}

export default CacheMiddleware;
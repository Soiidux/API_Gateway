/**
 * Rate limiting middleware, built as a configurable component.
 *
 * Uses Redis token buckets (utils/rateLimiter/*) to let N requests
 * through per key and reject the rest. The decision logic lives in the
 * limiter; here we only choose which limiter + key apply:
 *   - authenticated users (x-user-id set by conditionalAuth) → generous
 *     bucket keyed by user id
 *   - anonymous (public routes) → strict bucket keyed by IP
 *
 * On a 429 we also publish a "warn" log event so rate-limit abuse is
 * visible in the worker's Postgres table.
 *
 * Class with static `create()` to match RequestLogger/CacheMiddleware.
 */

import type { NextFunction, Request, Response } from "express";
import { authenticatedRateLimiter, anonymousRateLimiter } from "../utils/rateLimiter/rateLimiterInstances.js";
import generateApiResponse from "../utils/generateApiResponse.js";
import logPublisher from "../utils/rabbitMq/index.js";

export class RateLimitMiddleware {
  static create(): (req: Request, res: Response, next: NextFunction) => unknown {
    return async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.headers["x-user-id"] as string | undefined; //1.  Get the user ID from the request headers
      const isAuthenticated = userId !== undefined;
      const rateLimiter = isAuthenticated ? authenticatedRateLimiter : anonymousRateLimiter; //2.  Get the rate limiter based on authentication status
      const key: string = isAuthenticated ? `ratelimit:user:${userId}` : `ratelimit:ip:${req.ip}`; //3.  Generate the rate limit key based on authentication status
      try {
        const allowed: boolean = await rateLimiter.allow(key); //4.  Check if the request is allowed based on the rate limiter
        if (!allowed) {
          // NEW: instead of only replying 429, also publish a warn log event
          // so we can see rate-limit abuse in the worker's Postgres table.
          void logPublisher.publishEvent("warn", "Rate limit exceeded", {
            key,
            userId: userId ?? null,
            ip: req.ip,
          });
          const responsePayload: ApiResponse<null> = generateApiResponse(null, "Too Many Requests", 429); //5.  Send 429 Too Many Requests if the request is not allowed
          return res.status(responsePayload.status).json(responsePayload);
        }
        next(); //6.  Proceed to the next middleware if the request is allowed
      } catch (error) {
        console.error("Rate limit error:", error); // In case of an error, log it and pass it to the next middleware
        next(error);
      }
    };
  }
}

export default RateLimitMiddleware;
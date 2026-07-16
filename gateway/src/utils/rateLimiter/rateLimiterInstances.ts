import redisClient from "../../db/redisClient.js";
import RateLimiter from "./rateLimiter.js";


/**
 * Rate limiter instance for authenticated users.
 */
export const authenticatedRateLimiter = new RateLimiter(redisClient, {
  capacity: 20,
  refillRate: 5,
});

/**
 * Rate limiter instance for anonymous users (more strict).
 */
export const anonymousRateLimiter = new RateLimiter(redisClient, {
  capacity: 2,
  refillRate: 1,
});


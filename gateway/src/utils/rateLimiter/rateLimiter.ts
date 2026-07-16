/**
 * Rate limiter class that uses a token bucket algorithm to limit the rate of requests.
 * 
 * It has 3 parameters: `capacity` (max tokens the bucket can hold), `refillRate` (tokens added per second) along with the redis instance.
 * It has only one method: `allow` which takes a key and returns a boolean indicating whether the request is allowed or not on the basis of the token bucket algorithmn lua script.
 */
import type { Redis } from "ioredis";
import { TOKEN_BUCKET_SCRIPT } from "./tokenBucket.lua.js"; //the lua script for the token bucket algorithm

interface RateLimiterOptions {
  capacity: number; // the maximum number of tokens the bucket can hold
  refillRate: number; // the number of tokens added per second
}

class RateLimiter {
  constructor(
    private redis: Redis, // the redis instance
    private options: RateLimiterOptions, // the rate limiter options
  ) {}

  async allow(key: string): Promise<boolean> {
    const now = Date.now(); // the current time in milliseconds for the token bucket algorithm
    const result = await this.redis.eval(
      TOKEN_BUCKET_SCRIPT, // the lua script for the token bucket algorithm
      1,                   // the number of keys to pass to the script
      key,                 // the key to rate limit
      this.options.capacity, // the maximum number of tokens the bucket can hold
      this.options.refillRate, // the number of tokens added per second
      now,                 // the current time in milliseconds for the token bucket algorithm
    )
    return result === 1; // returns true if the request is allowed, false otherwise
  }
}

export default RateLimiter;

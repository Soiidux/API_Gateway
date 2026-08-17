/**
 * redisClient — shared Redis connection (ioredis) for the gateway.
 *
 * Used by three callers:
 *   1. Rate limiting   — token-bucket state per client (utils/rateLimiter/)
 *   2. Response cache  — cached GET responses for `cachebleRoutes`
 *   3. Graceful shutdown — index.ts quits the connection on SIGTERM/SIGINT
 *
 * One connection is exported and reused everywhere. It is NOT part of
 * the RabbitMQ log pipeline — that has its own connection in
 * utils/rabbitMq/. Failure to connect is logged but doesn't crash the
 * process: the cache read path fails OPEN (falls through to the backend),
 * while the rate limiter would surface a 500 while Redis is down.
 * Set REDIS_URL to point at the `gateway_redis` container in
 * docker-compose.
 */

import { Redis } from "ioredis";
import config from "../config.js";

const redisClient = new Redis(config.REDIS_URL);

redisClient.on("connect", () => {
  console.log("Redis connected");
});

redisClient.on("error", (err: Error) => {
  console.error("Redis error:", err);
});

export default redisClient;
// Redis client setup

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
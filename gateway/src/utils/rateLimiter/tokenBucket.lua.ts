/**
 * Token bucket rate limiting script for Redis written in Lua.
 * 
 */


export const TOKEN_BUCKET_SCRIPT = `
-- KEYS[1] = bucket key (e.g. "ratelimit:user:123")
-- ARGV[1] = capacity      (max tokens the bucket can hold)
-- ARGV[2] = refillRate    (tokens added per second)
-- ARGV[3] = now           (current time, ms)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- read current state of this bucket (empty if first request ever)
local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1])
local lastRefill = tonumber(bucket[2])

if tokens == nil then
  -- first request from this key: start with a full bucket
  tokens = capacity
  lastRefill = now
end

-- how much time passed since we last touched this bucket, in seconds
local elapsedSeconds = math.max(0, now - lastRefill) / 1000

-- add tokens for the time that passed, capped at capacity
tokens = math.min(capacity, tokens + (elapsedSeconds * refillRate))

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1  -- spend one token for this request
  allowed = 1
end

-- save the new state
redis.call("HMSET", key, "tokens", tokens, "timestamp", now)

-- let idle buckets expire from Redis instead of living forever
-- (give it enough time to fully refill twice over, as a safety margin)
redis.call("EXPIRE", key, math.ceil((capacity / refillRate) * 2))

return allowed
`;
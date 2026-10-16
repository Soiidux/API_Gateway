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
--
-- GUARDED: (capacity / refillRate) divides by zero when refillRate is 0 or
-- negative, making idleSeconds infinite, which Redis rejects with "ERR value
-- is not an integer or out of range". The script would then throw on EVERY
-- request for that key -- and because this limiter fails CLOSED on a Redis
-- error, one misconfigured rate would take the whole gateway down rather
-- than merely misbehave. So clamp instead of dividing.
local idleSeconds
if refillRate > 0 then
  idleSeconds = math.ceil((capacity / refillRate) * 2)
else
  -- No usable refill rate. Fall back to a fixed hour so keys still expire
  -- instead of accumulating forever. A bucket that never refills is almost
  -- certainly a misconfiguration, but it should degrade to "throttled for an
  -- hour", not to a divide-by-zero.
  idleSeconds = 3600
end
redis.call("EXPIRE", key, idleSeconds)

return allowed
`;
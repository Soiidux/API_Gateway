/**
 * Concurrency test for the token-bucket rate limiter — against a REAL Redis.
 *
 * WHY THIS NEEDS REDIS
 *
 * The bucket is decremented and refilled inside a Lua script, executed via
 * EVAL. That is the only reason the limiter is correct under concurrency:
 * Redis runs a script to completion without interleaving another command, so
 * read-modify-write on the bucket is atomic. A mocked Redis would return
 * whatever the test dictated, proving nothing — the property under test is
 * precisely that Redis's execution model provides it.
 *
 * THE BUG THIS GUARDS AGAINST
 *
 * The naive limiter is read the token count -> if > 0 then decrement -> allow.
 * Fire N requests at once and several read the same "1 token remaining", all
 * decide to allow, and the bucket hands out far more than its capacity. The
 * limit silently stops being a limit. These tests assert the bucket admits
 * EXACTLY capacity requests when every request arrives simultaneously, which
 * holds only if the Lua script is genuinely atomic.
 *
 * RUN WITH:  npm run test:integration     (needs REDIS_URL)
 * Skips itself when REDIS_URL is unset, so `npm test` stays offline-safe.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";

import RateLimiter from "./rateLimiter.js";

const REDIS_URL = process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;

let redis: Redis;

/** Fires N calls at once so their EVAL calls genuinely overlap in Redis. */
async function concurrently<T>(count: number, fn: () => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, fn));
}

describeIfRedis("rate limiter concurrency (real Redis)", () => {
  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("admits EXACTLY capacity requests when they arrive simultaneously", async () => {
    // 0.001 tokens/sec is effectively no refill (a whole token every ~17
    // minutes), so capacity is the hard ceiling for the duration of the test
    // and any over-admission is unambiguous. Not literally 0: the script's
    // idle-TTL calculation divides by refillRate, and a test pinning that
    // edge case lives below.
    const limiter = new RateLimiter(redis, { capacity: 20, refillRate: 0.001 });
    const key = "conc:exact-capacity";
    await redis.del(key);

    // 50 simultaneous requests against a capacity of 20.
    const results = await concurrently(50, () => limiter.allow(key));

    const allowed = results.filter(Boolean).length;

    // A read-then-decrement limiter would let far more than 20 through here.
    expect(allowed).toBe(20);
  });

  it("never lets a burst exceed capacity even across many parallel batches", async () => {
    const limiter = new RateLimiter(redis, { capacity: 5, refillRate: 0.001 });
    const key = "conc:repeated-bursts";
    await redis.del(key);

    // Three rounds of 10 concurrent requests against a capacity of 5, with
    // effectively no refill in between. The FIRST round drains the bucket to
    // exactly capacity; every round after it must be refused outright. Getting
    // 5 in round one and 0 in rounds two and three is what proves the tokens
    // were really consumed, rather than the bucket merely under-reporting
    // while handing out credit it does not have.
    const first = await concurrently(10, () => limiter.allow(key));
    expect(first.filter(Boolean).length).toBe(5);

    for (const round of [2, 3]) {
      const results = await concurrently(10, () => limiter.allow(key));
      expect(results.filter(Boolean).length, `round ${round} should be fully drained`).toBe(0);
    }
  });

  it("keeps separate buckets independent under load", async () => {
    const limiter = new RateLimiter(redis, { capacity: 3, refillRate: 0.001 });
    await redis.del("conc:alice", "conc:bob");

    const [alice, bob] = await Promise.all([
      concurrently(10, () => limiter.allow("conc:alice")),
      concurrently(10, () => limiter.allow("conc:bob")),
    ]);

    // Two users hammering simultaneously must not share a budget — this is the
    // property that a single global counter would break.
    expect(alice.filter(Boolean).length).toBe(3);
    expect(bob.filter(Boolean).length).toBe(3);
  });

  it("does not mint tokens beyond capacity when refilling is slow", async () => {
    // 1 token/sec refills a 2-capacity bucket. Hammer it for ~1s and the total
    // admitted should be capacity plus roughly one refill — NOT capacity times
    // the request count, which is what a naive refill calculation would allow.
    const limiter = new RateLimiter(redis, { capacity: 2, refillRate: 1 });
    const key = "conc:slow-refill";
    await redis.del(key);

    const started = Date.now();
    let allowed = 0;
    // 400 sequential-ish requests spread over ~1 second.
    while (Date.now() - started < 1000) {
      if (await limiter.allow(key)) allowed += 1;
    }

    // Capacity 2 + at most ~1 refilled token + the one just granted.
    expect(allowed).toBeLessThanOrEqual(5);
  });
});
/**
 * Regression guard for the idle-TTL division in the Lua script.
 *
 * The script originally computed its key expiry as `(capacity / refillRate) * 2`,
 * which is a division by zero when refillRate is 0. Redis rejects the resulting
 * infinity ("ERR value is not an integer or out of range"), so the script threw
 * on EVERY request for that key — and because the rate limiter fails CLOSED on
 * a Redis error, one misconfigured rate would have taken the whole gateway
 * down rather than merely misbehaving.
 *
 * The script now clamps. This pins that behaviour so it can't be "simplified"
 * back into a division.
 */
describeIfRedis("rate limiter idle-TTL guard", () => {
  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("does not throw when refillRate is 0 (idle TTL used to divide by it)", async () => {
    const limiter = new RateLimiter(redis, { capacity: 10, refillRate: 0 });
    const key = "conc:zero-refill";
    await redis.del(key);

    // Would previously reject with "ERR value is not an integer". A separate
    // key from the burst below, so this call doesn't spend one of its tokens.
    await expect(limiter.allow("conc:zero-refill-single")).resolves.toBeTypeOf("boolean");

    // A bucket that never refills should still consume its initial capacity and
    // then stop granting requests, rather than erroring.
    const results = await concurrently(15, () => limiter.allow(key));
    expect(results.filter(Boolean).length).toBe(10);
  });

  it("still sets a finite TTL so idle buckets cannot accumulate forever", async () => {
    const limiter = new RateLimiter(redis, { capacity: 4, refillRate: 2 });
    const key = "conc:ttl-present";
    await redis.del(key);
    await limiter.allow(key);

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(86400);
  });
});

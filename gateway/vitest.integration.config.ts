/**
 * Vitest config for tests that need real backing services (Postgres, Redis).
 *
 * Separate from `vitest.config.ts`, which stays offline and fast. These suites
 * assert properties that are properties of the DATABASE or the CACHE, not of
 * this TypeScript: that Postgres serialises the atomic upsert and the
 * conditional UPDATE, and that Redis executes a Lua script without
 * interleaving. A mock returns whatever the test dictates, so it can never
 * demonstrate either.
 *
 * Run with:  npm run test:integration   (needs DATABASE_URL and/or REDIS_URL)
 * Every suite here skips itself when its variable is missing, so a partial
 * environment runs whatever it can instead of failing confusingly.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Concurrency suites open pools and fire dozens of simultaneous requests,
    // so they need more headroom than the unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Sequential: the Postgres suite TRUNCATEs shared tables, and the Redis
    // suite shares keyspace, so parallel files would interfere.
    fileParallelism: false,
    include: ["src/**/*.concurrency.test.ts", "src/**/*.integration.test.ts"],
  },
});
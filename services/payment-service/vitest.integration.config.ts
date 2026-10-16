/**
 * Integration-test Vitest config for the payment service.
 *
 * Separate from `vitest.config.ts` because these tests need a REAL Postgres.
 * The unit suite injects a fake db, which is right for testing handler logic
 * but useless for the question that actually matters here: does Postgres
 * execute the atomic statements correctly when two requests collide?
 *
 * A fake cannot answer that. `INSERT ... ON CONFLICT` and the conditional
 * `UPDATE ... WHERE balance >= amount` are atomic because of how POSTGRES
 * serialises them — a mock returns whatever the test told it to return. So
 * the double-spend guard has to be tested against the real engine.
 *
 * Run with:  npm run test:integration   (needs DATABASE_URL)
 * Skips itself with a clear message when DATABASE_URL is unset, so the
 * default `npm test` stays runnable offline.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Longer timeout: the suite opens a pool, runs migrations, and issues
    // dozens of genuinely concurrent transactions.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Sequential by design. The tests TRUNCATE shared tables between cases,
    // so running files in parallel would have them deleting each other's rows.
    fileParallelism: false,
    include: ["src/**/*.integration.test.ts"],
  },
});
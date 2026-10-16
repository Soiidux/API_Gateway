/**
 * Vitest configuration for the payment service package.
 * Tests live next to the code (the *.test.ts files under src/).
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The concurrency suite needs a real Postgres, so it lives in its own
    // config (`vitest.integration.config.ts`). Excluded here so the fast unit
    // run doesn't match those files — they'd skip rather than fail, but a
    // silently-skipped suite in the fast job is how a broken test hides.
    // Spreading configDefaults.exclude keeps the defaults.
    exclude: [
      ...configDefaults.exclude,
      "src/**/*.concurrency.test.ts",
      "src/**/*.integration.test.ts",
    ],
    coverage: {
      reporter: ["text", "html"],
      enabled: false, // report-only: enable with `npm test -- --coverage`
    },
  },
});
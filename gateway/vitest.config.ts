/**
 * Vitest configuration for the gateway package.
 *
 * Tests live next to the code (the *.test.ts files under src/) and run
 * in the Node environment. Coverage is kept report-only (off by
 * default) — enable it on demand with `npm test -- --coverage`.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The concurrency suite needs a real Redis, so it lives in its own config
    // (`vitest.integration.config.ts`). Without this exclusion the unit run
    // would match those files too — they'd skip rather than fail, but a
    // silently-skipped suite in the fast job is exactly how a broken test
    // hides itself. Spreading configDefaults.exclude keeps the defaults.
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
/**
 * Vitest configuration for the gateway package.
 *
 * Tests live next to the code (the *.test.ts files under src/) and run
 * in the Node environment. Coverage is kept report-only (off by
 * default) — enable it on demand with `npm test -- --coverage`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      enabled: false, // report-only: enable with `npm test -- --coverage`
    },
  },
});
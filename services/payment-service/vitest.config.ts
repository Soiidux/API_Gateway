/**
 * Vitest configuration for the payment service package.
 * Tests live next to the code (the *.test.ts files under src/).
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
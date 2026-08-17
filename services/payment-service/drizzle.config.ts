/**
 * drizzle-kit CLI config — NOT part of the running service. Read when you
 * run:
 *   npm run db:generate → create SQL in drizzle/ from src/db/schema.ts
 *   npm run db:migrate  → apply them (also done at boot by db/client.ts)
 */
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
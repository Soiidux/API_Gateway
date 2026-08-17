import express, { type RequestHandler } from "express";
import dotenv from "dotenv";
import { getUsers, rateLimiterCheck, registerUser } from "./controllers/user.controllers.js";
import { requireAuth } from "./middlewares/requireAuth.js";
import { PostgresClient } from "./db/client.js";
import config from "./config.js";
dotenv.config();

/**
 * The gateway runs THREE replicas of this service, all sharing one
 * database. Running DDL from every replica at once races (they'd each
 * try to CREATE TABLE users and one would fail) — so:
 *   - replicas marked INSTANCE_ID=1 own schema migrations at boot;
 *   - the other replicas wait until the users table exists (with a
 *     timeout) before serving, so they never 500 on a missing table.
 *
 * We check information_schema rather than the migration ledger so a
 * freshly-created DB is handled either way.
 */
const MAX_SCHEMA_WAIT_MS = 15_000;

async function ensureUsersTable(postgres: PostgresClient): Promise<void> {
  if (config.INSTANCE_ID === "1") {
    await postgres.runMigrations();
    console.log(`[User Service ${config.INSTANCE_ID}] Migrations applied (schema owner).`);
    return;
  }

  const deadline = Date.now() + MAX_SCHEMA_WAIT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result: unknown = await postgres.db.execute(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      )`,
    );
    const exists = (result as { rows: { exists: boolean }[] }).rows[0]?.exists ?? false;
    if (exists) {
      console.log(`[User Service ${config.INSTANCE_ID}] users table ready.`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the users table to be created by replica 1.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const postgres = new PostgresClient();
  await ensureUsersTable(postgres);
  console.log(`[User Service ${config.INSTANCE_ID}] database ready.`);

  const app = express();
  app.use(express.json());

  // /getAll is role-restricted at the gateway (ADMIN/MANAGER) AND verified
  // again here via requireAuth — the service never trusts proxy headers.
  // (as unknown as RequestHandler: controllers accept an injectable db arg
  // for tests, which Express's handler typing doesn't know about.)
  app.get("/getAll", requireAuth, getUsers as unknown as RequestHandler);
  app.post("/register", registerUser as unknown as RequestHandler);
  app.get("/", rateLimiterCheck);

  app.listen(config.PORT, () => {
    console.log(`User Service ${config.INSTANCE_ID} running internally on port ${config.PORT}`);
  });
}

main().catch((error) => {
  console.error("[User Service] Fatal error:", error);
  process.exit(1);
});
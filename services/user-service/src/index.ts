import express, { type Request, type RequestHandler, type Response } from "express";
import dotenv from "dotenv";
import { getUsers, loginUser, logout, rateLimiterCheck, registerUser } from "./controllers/user.controllers.js";
import { requireAuth } from "./middlewares/requireAuth.js";
import { PostgresClient } from "./db/client.js";
import { closeRedis } from "./db/redisClient.js";
import { Readiness } from "./health.js";
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

  // Liveness + readiness, registered BEFORE the business routes so a health
  // probe is never rejected by auth. Docker's HEALTHCHECK polls /ready; until
  // it passes, Compose holds back anything that depends_on this service.
  const readiness = new Readiness();
  app.get("/health", readiness.liveness);
  app.get("/ready", readiness.readiness);

  // /getAll is role-restricted at the gateway (ADMIN/MANAGER) AND verified
  // again here via requireAuth — the service never trusts proxy headers.
  // (as unknown as RequestHandler: controllers accept an injectable db arg
  // for tests, which Express's handler typing doesn't know about.)
  //
  // The controllers take (req, res, db = postgres.db) so tests can inject a
  // fake db. Express would call them as (req, res, next) — handing `next`
  // to the db param — so we mount thin wrappers that only forward req/res
  // and let the default kick in.
  app.get("/getAll", requireAuth, ((req: Request, res: Response) => getUsers(req, res)) as unknown as RequestHandler);
  app.post("/register", ((req: Request, res: Response) => registerUser(req, res)) as unknown as RequestHandler);
  app.post("/login", ((req: Request, res: Response) => loginUser(req, res)) as unknown as RequestHandler);
  // /logout is JWT-protected on purpose: the identity comes from the verified
  // token, so there's no way to revoke someone ELSE's sessions by guessing a
  // userId. The gateway's defaultRoles already gates this route — it isn't in
  // publicRoutes — and requireAuth re-verifies the token at this hop.
  app.post("/logout", requireAuth, ((req: Request, res: Response) => logout(req, res)) as unknown as RequestHandler);
  app.get("/", rateLimiterCheck);

  const server = app.listen(config.PORT, () => {
    console.log(`User Service ${config.INSTANCE_ID} running internally on port ${config.PORT}`);
  });

  // Only now that the schema is guaranteed present do we accept traffic.
  // Ordering matters: markReady() after ensureUsersTable() means a replica
  // can never report healthy and then fail its first real request.
  readiness.markReady();

  /**
   * Graceful shutdown (mirrors the gateway and log-worker).
   *
   * On SIGTERM (docker stop / compose down / rolling restart) Docker allows
   * roughly 10 seconds before SIGKILL. The sequence:
   *   1. markDraining()  -> /ready starts returning 503, so the load
   *      balancer (and Compose) stops routing new requests here.
   *   2. server.close() -> stop accepting new connections and let in-flight
   *      requests finish rather than severing them mid-response.
   *   3. postgres.end() -> close the connection pool last, so no query is
   *      cut off while draining.
   * The timeout is a safety net so a hung request can't outlive the shutdown.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[User Service ${config.INSTANCE_ID}] ${signal} received, draining...`);
    readiness.markDraining();

    setTimeout(() => {
      console.error("[User Service] Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();

    server.close(async () => {
      try {
        await postgres.end();
        // Close Redis last-ish: it's the revocation store, and an in-flight
        // logout that has already passed the DB stage still needs it to write
        // its marker. Quitting it before the drain finished would silently
        // turn a successful logout into a 503.
        await closeRedis();
        console.log("[User Service] Shutdown complete.");
        process.exit(0);
      } catch (error) {
        console.error("[User Service] Error during shutdown:", error);
        process.exit(1);
      }
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[User Service] Fatal error:", error);
  process.exit(1);
});
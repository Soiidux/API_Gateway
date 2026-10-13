import express, { type Request, type RequestHandler, type Response } from "express";
import dotenv from "dotenv";
import {
  deposit,
  getAll,
  getMy,
  rateLimiterCheck,
  withdraw,
} from "./controllers/payment.controllers.js";
import { requireAuth } from "./middlewares/requireAuth.js";
import { PostgresClient } from "./db/client.js";
import { Readiness } from "./health.js";
import config from "./config.js";
dotenv.config();

/**
 * Same schema-ownership pattern as user-service: the gateway runs THREE
 * replicas of this service, all sharing one database. Running DDL from
 * every replica at once would race, so:
 *   - INSTANCE_ID=1 owns the payment migrations at boot;
 *   - other replicas wait until the accounts table exists (15s timeout)
 *     before serving.
 *
 * The `users` table is NOT part of this service's schema ownership — it
 * belongs to user-service. We only read it (see controllers).
 */
const MAX_SCHEMA_WAIT_MS = 15_000;

async function ensurePaymentTables(postgres: PostgresClient): Promise<void> {
  if (config.INSTANCE_ID === "1") {
    await postgres.runMigrations();
    console.log(`[Payment Service ${config.INSTANCE_ID}] Migrations applied (schema owner).`);
    return;
  }

  const deadline = Date.now() + MAX_SCHEMA_WAIT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result: unknown = await postgres.db.execute(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'accounts'
      )`,
    );
    const exists = (result as { rows: { exists: boolean }[] }).rows[0]?.exists ?? false;
    if (exists) {
      console.log(`[Payment Service ${config.INSTANCE_ID}] accounts table ready.`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the accounts table to be created by replica 1.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const postgres = new PostgresClient();
  await ensurePaymentTables(postgres);
  console.log(`[Payment Service ${config.INSTANCE_ID}] database ready.`);

  const app = express();
  app.use(express.json());

  // Liveness + readiness, registered BEFORE the business routes so a health
  // probe is never rejected by auth. Docker's HEALTHCHECK polls /ready; until
  // it passes, Compose holds back anything that depends_on this service.
  const readiness = new Readiness();
  app.get("/health", readiness.liveness);
  app.get("/ready", readiness.readiness);

  // Every money-touching route demands a service-side verified JWT; the
  // injected user identity comes from the token (req.auth), never from the
  // request body or a forwarded header. getMy/getAll are cached at the
  // gateway. / is the plain liveness/rate-limit check.
  //
  // (as unknown as RequestHandler: controllers accept an injectable db arg
  // for tests, which Express's handler typing doesn't know about. The
  // wrappers below pass only req/res so Express's (req,res,next) call can't
  // land on the db param.)
  app.post("/deposit", requireAuth, ((req: Request, res: Response) => deposit(req, res)) as unknown as RequestHandler);
  app.post("/withdraw", requireAuth, ((req: Request, res: Response) => withdraw(req, res)) as unknown as RequestHandler);
  app.get("/my", requireAuth, ((req: Request, res: Response) => getMy(req, res)) as unknown as RequestHandler);
  app.get("/getAll", requireAuth, ((req: Request, res: Response) => getAll(req, res)) as unknown as RequestHandler);
  app.get("/", rateLimiterCheck);

  const server = app.listen(config.PORT, () => {
    console.log(`Payment Service ${config.INSTANCE_ID} running internally on port ${config.PORT}`);
  });

  // Only now that accounts/transactions are guaranteed present do we accept
  // traffic. Ordering matters: markReady() after ensurePaymentTables() means
  // a replica can never report healthy and then fail its first real request.
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
   *
   * This matters more here than in user-service: cutting a connection
   * mid-transaction is exactly the case that could leave a balance updated
   * without its matching ledger row.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Payment Service ${config.INSTANCE_ID}] ${signal} received, draining...`);
    readiness.markDraining();

    setTimeout(() => {
      console.error("[Payment Service] Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();

    server.close(async () => {
      try {
        await postgres.end();
        console.log("[Payment Service] Shutdown complete.");
        process.exit(0);
      } catch (error) {
        console.error("[Payment Service] Error during shutdown:", error);
        process.exit(1);
      }
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[Payment Service] Fatal error:", error);
  process.exit(1);
});
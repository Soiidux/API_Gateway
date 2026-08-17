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

  app.listen(config.PORT, () => {
    console.log(`Payment Service ${config.INSTANCE_ID} running internally on port ${config.PORT}`);
  });
}

main().catch((error) => {
  console.error("[Payment Service] Fatal error:", error);
  process.exit(1);
});
/**
 * The two pieces of database plumbing (same pattern as user-service):
 *  1. Pool (pg) — reusable DB connections.
 *  2. drizzle(pool, { schema }) — typed queries over accounts/transactions
 *     plus the read-only `users` mirror.
 *
 * runMigrations() applies the compiled SQL in drizzle/. A fresh Postgres
 * container gets its accounts/transactions tables automatically.
 *
 * MIGRATION LEDGER — why `migrationsTable` is set explicitly:
 *
 * All three services share ONE Postgres database, and Drizzle's migrator
 * records what it has run in a ledger table (default: __drizzle_migrations
 * in the `drizzle` schema). That default is shared too, which is a real bug
 * waiting to happen: Drizzle skips any migration whose journal timestamp is
 * OLDER than the newest timestamp in the ledger. Since each service has its
 * own journal generated at a different time, whichever service happens to
 * migrate first "claims" the ledger and the others' migrations get silently
 * skipped — their tables never appear.
 *
 * That isn't hypothetical: it happened here (log-worker's migrations were the
 * oldest, so a user-service-first boot made log-worker skip them and the logs
 * table never got created).
 *
 * Giving each service its OWN ledger table means each tracks only its own
 * migrations, so ordering between services no longer matters. The tables all
 * still live in the same physical database — see the README's trade-offs for
 * why a real deployment would use a database per service.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import config from "../config.js";
import * as schema from "./schema.js";

export class PostgresClient {
  readonly db: NodePgDatabase<typeof schema>;
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: config.DATABASE_URL });
    this.db = drizzle(this.pool, { schema });
  }

  async runMigrations(): Promise<void> {
    await migrate(this.db, {
      migrationsFolder: "./drizzle",
      migrationsTable: "payment_service_migrations", // own ledger; see header note
      migrationsSchema: "drizzle",
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
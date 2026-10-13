/**
 * The two pieces of database plumbing:
 *  1. Pool (pg) — a set of reusable DB connections. Creating a connection
 *     is expensive, so we keep a pool and hand connections out on demand.
 *  2. drizzle(pool, { schema }) — wraps the pool so we can write typed
 *     queries like postgres.db.insert(logs).values(...) instead of raw SQL.
 *
 * runMigrations() reads the compiled SQL in drizzle/ and applies anything
 * not yet run (tracked in a drizzle-migrations table). So a fresh Postgres
 * container gets its logs table automatically — no manual psql/init.
 *
 * Note: auto-running migrations at boot is fine for this demo; large apps
 * run them as a separate deploy step so multiple replicas don't race.
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
 * That isn't hypothetical: this service's journals were generated EARLIEST,
 * so a user-service-first boot made log-worker skip both of its migrations —
 * it reported "Migrations applied" while the `logs` table never existed, and
 * every log insert then failed with `relation "logs" does not exist`.
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
      migrationsTable: "log_worker_migrations", // own ledger; see header note
      migrationsSchema: "drizzle",
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
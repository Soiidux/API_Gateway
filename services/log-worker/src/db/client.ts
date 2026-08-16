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
    await migrate(this.db, { migrationsFolder: "./drizzle" });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
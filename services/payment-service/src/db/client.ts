/**
 * The two pieces of database plumbing (same pattern as user-service):
 *  1. Pool (pg) — reusable DB connections.
 *  2. drizzle(pool, { schema }) — typed queries over accounts/transactions
 *     plus the read-only `users` mirror.
 *
 * runMigrations() applies the compiled SQL in drizzle/. A fresh Postgres
 * container gets its accounts/transactions tables automatically.
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
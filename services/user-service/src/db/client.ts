/**
 * The two pieces of database plumbing:
 *  1. Pool (pg) — a set of reusable DB connections. Creating a connection
 *     is expensive, so we keep a pool and hand connections out on demand.
 *  2. drizzle(pool, { schema }) — wraps the pool so we can write typed
 *     queries like postgres.db.insert(users).values(...) instead of raw SQL.
 *
 * runMigrations() reads the compiled SQL in drizzle/ and applies anything
 * not yet run (tracked in a drizzle-migrations table). So a fresh Postgres
 * container gets its users table automatically — no manual psql/init.
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
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      // POOL SIZING. node-postgres defaults to max: 10, which is fine for a
      // single process but wrong here: three services x three replicas each
      // means up to 90 connections against a Postgres whose own default
      // max_connections is 100. The database would run out of connections
      // (and start refusing new ones) before the app reached any single
      // process's own limit.
      //
      // Postgres's limit is a shared budget across everything that connects —
      // this pool, the other two services' pools, and any psql session — so
      // the per-process number is deliberately small. Overflow beyond it
      // makes a request WAIT (bounded by connectionTimeoutMillis) rather than
      // crash, which is the failure mode you want: graceful degradation
      // instead of connection errors.
      //
      // With 3 services x 3 replicas x 5 = 45, leaving headroom under 100.
      // If you ever add a replica or a fourth service, raise these together
      // and confirm Postgres's max_connections can absorb the total.
      max: 5,
      // Don't hang a request forever waiting for a connection that will never
      // come. Without this, pool exhaustion shows up as requests that never
      // respond; with it, they fail fast with a 503 (the controllers map any
      // DB error to 503) and the logs say why.
      connectionTimeoutMillis: 5_000,
      // Don't hold connections open forever for an idle client either.
      idleTimeoutMillis: 30_000,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async runMigrations(): Promise<void> {
    await migrate(this.db, {
      migrationsFolder: "./drizzle",
      migrationsTable: "user_service_migrations", // own ledger; see header note
      migrationsSchema: "drizzle",
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
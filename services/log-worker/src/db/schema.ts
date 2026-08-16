/**
 * Drizzle table definition: describes the `logs` table in TypeScript and
 * generates the SQL for it. `request_id` maps to the x-request-id the
 * gateway stamps on every request — indexed so `WHERE request_id = '...'`
 * pulls one request's full log story fast.
 *
 * The index(...) declarations create DB indexes on frequently-queried
 * columns (ts, status, request_id); scanning a table without an index
 * gets slow as it grows.
 *
 * Whenever this file changes you must run `npm run db:generate` to create
 * a new versioned migration in drizzle/ — that's the whole point of
 * versioned migrations.
 */
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const logs = pgTable(
  "logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    level: text("level").notNull(),
    service: text("service").notNull(),
    requestId: text("request_id"),
    method: text("method"),
    path: text("path"),
    status: integer("status"),
    latencyMs: integer("latency_ms"),
    userId: text("user_id"),
    ip: text("ip"),
    message: text("message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("logs_ts_idx").on(t.ts),
    index("logs_status_idx").on(t.status),
    index("logs_request_id_idx").on(t.requestId),
  ],
);

/** Convenience: `typeof logs.$inferInsert` = the object shape Drizzle
 *  expects when INSERTING a row (id is omittable since it's serial). */
export type LogRow = typeof logs.$inferInsert;
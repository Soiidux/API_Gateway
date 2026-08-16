/**
 * The only place SQL-shape logic lives: maps a LogEntry to the Drizzle
 * insert shape and writes many at once. Also exposes deleteOlderThan()
 * for the retention cleanup.
 *
 * The LogBatchWriter interface lets the BatchBuffer depend on "anything
 * that can insert a batch" instead of this concrete class (dependency
 * inversion): production uses LogRepository, tests use a tiny fake.
 *
 * Why multi-row insert? `INSERT ... VALUES (...), (...)` in ONE round-trip
 * is dramatically cheaper than 50 separate statements — each round-trip
 * is network latency + transaction overhead.
 */
import { lt } from "drizzle-orm";
import { logs } from "./db/schema.js";
import type { PostgresClient } from "./db/client.js";
import type { LogEntry } from "./LogEntry.js";

/** Anything able to persist a batch of log entries (real or fake). */
export interface LogBatchWriter {
  insertBatch(entries: LogEntry[]): Promise<void>;
}

export class LogRepository implements LogBatchWriter {
  constructor(private readonly postgres: PostgresClient) {}

  async insertBatch(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // LogEntry (string ts, optional fields) → Drizzle insert shape.
    const values = entries.map((entry) => ({
      ts: new Date(entry.ts),
      level: entry.level,
      service: entry.service,
      requestId: entry.requestId,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      latencyMs: entry.latencyMs,
      userId: entry.userId,
      ip: entry.ip,
      message: entry.message,
      metadata: entry.metadata ?? null,
    }));

    // One multi-row INSERT statement for the whole batch.
    await this.postgres.db.insert(logs).values(values);
  }

  /**
   * Deletes log rows OLDER than `cutoff`. Used by the retention cleanup
   * to stop the table from growing forever. Returns deleted row count.
   */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.postgres.db
      .delete(logs)
      .where(lt(logs.ts, cutoff))
      .returning({ id: logs.id });

    return result.length;
  }
}
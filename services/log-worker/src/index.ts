/**
 * Composition root: wires the components together, then starts them.
 * This is the ONE place `new X()` calls and constructor arguments live,
 * so every class stays decoupled and testable.
 *
 * Sequencing matters:
 *  1. Migrations run BEFORE consuming — rows can't land in a missing table.
 *  2. Retention starts alongside consumption — it prunes rows on a timer.
 *  3. SIGTERM/SIGINT => flush the buffer, then close connections. We wait
 *     for the flush because un-flushed messages would otherwise be
 *     redelivered by the broker (duplicates, not loss) after shutdown.
 */
import { BatchBuffer } from "./BatchBuffer.js";
import { LogConsumer } from "./LogConsumer.js";
import { LogRepository } from "./LogRepository.js";
import { RetentionCleanup } from "./RetentionCleanup.js";
import { PostgresClient } from "./db/client.js";

async function main(): Promise<void> {
  // 1. Database first (so the table exists before anything writes).
  const postgres = new PostgresClient();
  await postgres.runMigrations();
  console.log("[LogWorker] Migrations applied.");

  // 2. Repository (SQL via Drizzle) → buffer (memory + ack/nack).
  const repository = new LogRepository(postgres);
  const buffer = new BatchBuffer(repository, 50, 3000);

  // 3. Retention: prune logs older than N days on an interval.
  const retention = new RetentionCleanup(repository);
  retention.start();

  // 4. Consumer pulls from RabbitMQ; connect() never returns until OK,
  //    so this blocks (forever, if need be) until we're fully running.
  const consumer = new LogConsumer(buffer);
  await consumer.start();

  // 5. Graceful shutdown: flush pending logs, then close everything.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[LogWorker] ${signal} received, flushing pending logs...`);
    await buffer.flush();
    await consumer.shutdown();
    retention.stop();
    await postgres.end();
    console.log("[LogWorker] Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[LogWorker] Fatal error:", error);
  process.exit(1);
});
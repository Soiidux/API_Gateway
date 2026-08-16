/**
 * PRODUCER side of the logging pipeline: drops LogEntry objects onto the
 * RabbitMQ queue instead of writing to Postgres directly (that's the
 * worker's job).
 *
 * Durability ("at-least-once delivery"): durable queue = the queue itself
 * survives a broker restart; persistent msg = each message is written to
 * disk before ack. Together a message may be duplicated in a crash, but
 * never silently lost.
 *
 * FAIL-OPEN design: publish() never throws. If RabbitMQ is down we log to
 * console and move on — a logging pipeline must never break the API it's
 * observing (mirrors the Redis cache middleware's fail-open behavior).
 *
 * JSON encoding: RabbitMQ deals in raw bytes, so we do
 * JSON.stringify(entry) → Buffer → sendToQueue; the consumer reverses it.
 */
import { LOG_QUEUE, type LogEntry } from "./LogEntry.js";
import { RabbitMQConnectionManager } from "./RabbitConnectionManager.js";
import config from "../../config.js";

export class RabbitMqPublisher {
  private readonly connectionManager: RabbitMQConnectionManager;
  private queueEnsured = false;

  /**
   * Dependency injection: the caller MAY pass in their own connection
   * manager (e.g. for tests), but by default we build one from env and
   * subscribe to its onReconnect hook so the queueEnsured flag (which is
   * only valid for the current broker session) is forgotten on reconnect.
   * Accepting a dependency instead of hard-coding it is called
   * "dependency injection" and is what makes classes testable.
   */
  constructor(connectionManager?: RabbitMQConnectionManager) {
    this.connectionManager =
      connectionManager ??
      new RabbitMQConnectionManager(config.RABBITMQ_URL, () => {
        this.queueEnsured = false;
      });
  }

  async publish(entry: LogEntry): Promise<void> {
    try {
      // Lazily open the socket/channel (see RabbitConnectionManager).
      await this.connectionManager.connect();
      const channel = await this.connectionManager.getChannel();

      // assertQueue is idempotent — "make sure this queue exists".
      // Doing it once per process keeps the messages from hitting a
      // queue that nobody declared (which would silently drop them).
      if (!this.queueEnsured) {
        await channel.assertQueue(LOG_QUEUE, { durable: true });
        this.queueEnsured = true;
      }

      // Buffer.from(JSON.stringify(entry)) = encode object -> JSON text -> bytes
      // persistent: true = write to disk before acking (see durability above)
      channel.sendToQueue(LOG_QUEUE, Buffer.from(JSON.stringify(entry)), {
        persistent: true,
      });
    } catch (error) {
      // THE fail-open path: log to console, swallow the error.
      console.error("[RabbitMqPublisher] Failed to publish log entry:", error);
    }
  }

  /** Closes the connection, e.g. during gateway shutdown. */
  async closeConnection(): Promise<void> {
    await this.connectionManager.disconnect();
    this.queueEnsured = false;
  }
}
/**
 * The RabbitMQ consumer side of the pipeline (the gateway's
 * RabbitMqPublisher is the matching producer). Opens the "api_gateway_logs"
 * queue, and for each delivered message hands it to the BatchBuffer.
 *
 * Backpressure: prefetch(5) means "don't deliver more than 5 unacked
 * messages at once" — RabbitMQ waits for acks before sending more, so the
 * worker can't be overwhelmed. consume({ noAck: false }) requires explicit
 * ack/nack per message (BatchBuffer does it); noAck: true would auto-delete
 * on delivery = data loss if we crash.
 *
 * Poison messages: if JSON.parse fails on garbage, acking would lose it and
 * nack-requeue would redeliver it forever, so we reject(msg, false) to
 * discard without requeue.
 *
 * Reconnection: AMQP doesn't reconnect itself. We listen for 'close' and
 * re-run start(), and start() itself retries with exponential backoff so
 * the worker also survives the broker not being up when the container
 * first starts.
 */
import amqp, { type Channel, type ChannelModel, type Message } from "amqplib";
import config from "./config.js";
import { LOG_QUEUE, type LogEntry } from "./LogEntry.js";
import type { BatchBuffer } from "./BatchBuffer.js";

export class LogConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private reconnecting = false;

  constructor(private readonly buffer: BatchBuffer) {}

  /** Connect (retrying with exponential backoff until success). */
  async start(): Promise<void> {
    let delayMs = 1000;
    for (;;) {
      try {
        await this.connect();
        return;
      } catch (error) {
        console.error(`[LogConsumer] Connect failed, retrying in ${delayMs}ms:`, error);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 30000); // 1s → 2s → 4s ... cap 30s
      }
    }
  }

  private async connect(): Promise<void> {
    this.connection = await amqp.connect(config.RABBITMQ_URL);
    // Socket-level events: log errors; on close, go back to loop.
    this.connection.on("error", (err) => console.error("[LogConsumer] Connection error:", err));
    this.connection.on("close", () => {
      console.warn("[LogConsumer] Connection closed, reconnecting...");
      this.channel = null;
      this.connection = null;
      void this.reconnect();
    });

    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(LOG_QUEUE, { durable: true });
    await this.channel.prefetch(5); // backpressure: max 5 unacked in flight

    // Give BatchBuffer the ack/nack so it can confirm after DB writes.
    this.buffer.bind(
      (msg) => msg !== null && this.channel !== null && this.channel.ack(msg),
      (msg) => msg !== null && this.channel !== null && this.channel.nack(msg, false, true),
    );
    this.buffer.start(); // time-based flush timer

    // Register to receive messages. Handled sequentially per message.
    await this.channel.consume(LOG_QUEUE, (msg) => {
      void this.handleMessage(msg);
    });

    console.log("[LogConsumer] Consuming from queue:", LOG_QUEUE);
  }

  private async handleMessage(msg: Message | null): Promise<void> {
    if (!msg) return;

    try {
      // Re-hydrate the JSON into the LogEntry shape from the contract.
      const entry: LogEntry = JSON.parse(msg.content.toString()) as LogEntry;
      await this.buffer.push(msg, entry);
    } catch (error) {
      // Unparseable message — rejecting without requeue avoids a
      // poison-message infinite loop.
      console.error("[LogConsumer] Malformed message, discarding:", error);
      this.channel?.reject(msg, false);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return; // guard against multiple loops
    this.reconnecting = true;
    await sleep(1000);
    await this.start();
    this.reconnecting = false;
  }

  /**
   * Graceful teardown: cancel the buffer timer, then close channel +
   * connection. Unacked messages are automatically requeued by the broker
   * on channel close — so we don't lose them (worst case: redelivered).
   */
  async shutdown(): Promise<void> {
    this.buffer.stop();
    try {
      await this.channel?.close();
    } catch (error) {
      console.error("[LogConsumer] Error closing channel:", error);
    }
    try {
      await this.connection?.close();
    } catch (error) {
      console.error("[LogConsumer] Error closing connection:", error);
    }
    this.channel = null;
    this.connection = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
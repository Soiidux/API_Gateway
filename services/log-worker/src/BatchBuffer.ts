/**
 * In-memory buffer between RabbitMQ and Postgres.
 *
 * The consumer receives messages one-by-one but we don't want a DB insert
 * per message, so we buffer: flush to Postgres when either the `threshold`
 * (50) is reached or the `flushIntervalMs` (3s) ticks with fewer queued.
 * This bounds memory AND keeps writes batching at low traffic too.
 *
 * Acked-vs-written (at-least-once): RabbitMQ only forgets a message on
 * ack. On insert success we ack (data IS in Postgres); on failure we
 * nack-with-requeue so the broker redelivers. A crash between insert and
 * ack can hence duplicate a row, but never lose one — the correct trade
 * off for logs.
 *
 * ack/nack are INJECTED via bind() rather than passed in because the
 * amqplib channel doesn't exist until LogConsumer connects; binding
 * post-construction keeps the buffer testable and independent of
 * RabbitMQ's lifecycle.
 */
import type { Message } from "amqplib";
import type { LogEntry } from "./LogEntry.js";
import type { LogBatchWriter } from "./LogRepository.js";

interface BufferedMessage {
  msg: Message | null; // the raw RabbitMQ message (needed for ack/nack)
  entry: LogEntry;     // the parsed log we'll actually INSERT
}

export class BatchBuffer {
  private buffer: BufferedMessage[] = [];
  private flushing = false; // guard: prevents two concurrent flushes
  private timer: ReturnType<typeof setInterval> | null = null;
  private ackFn: ((msg: Message | null) => void) | null = null;
  private nackFn: ((msg: Message | null) => void) | null = null;

  constructor(
    private readonly repository: LogBatchWriter,
    private readonly threshold: number = 50,       // flush when 50 queued
    private readonly flushIntervalMs: number = 3000, // ...or every 3s
  ) {}

  /** Stop the time-based flush timer (used during shutdown/test teardown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** LogConsumer supplies the ack/nack once its channel is live. */
  bind(ack: (msg: Message | null) => void, nack: (msg: Message | null) => void): void {
    this.ackFn = ack;
    this.nackFn = nack;
  }

  /** Kick off the time-based flush. unref() lets the process exit too. */
  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  async push(msg: Message | null, entry: LogEntry): Promise<void> {
    this.buffer.push({ msg, entry });
    // Threshold reached? flush (and ack) right now instead of waiting.
    if (this.buffer.length >= this.threshold) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.repository.insertBatch(batch.map((b) => b.entry));
      // DB write OK -> tell the broker these are handled.
      batch.forEach((b) => this.ackFn?.(b.msg));
    } catch (error) {
      // DB down -> put them back on the queue for later delivery.
      console.error("[BatchBuffer] Insert failed, requeueing batch:", error);
      batch.forEach((b) => this.nackFn?.(b.msg));
    } finally {
      this.flushing = false;
    }
  }
}
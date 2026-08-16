/**
 * High-level logging API — the ONLY thing the rest of the gateway talks
 * to when it logs.
 *
 * Layering: RabbitConnectionManager (socket/channel plumbing) →
 * RabbitMqPublisher (queue write) → LogPublisher (request/event API).
 * Keeping callers behind this facade means swapping RabbitMQ for Kafka or
 * a file logger only changes the two inner classes, never the callers.
 *
 * Optional fields are built with conditional spreads `...(x ? {x} : {})`
 * so truly-absent values don't appear as `undefined` in the JSON (TS
 * optional fields made actually optional at runtime).
 */
import type { Request, Response } from "express";
import { RabbitMqPublisher } from "./RabbitMqPublisher.js";
import type { LogEntry, LogLevel } from "./LogEntry.js";

export class LogPublisher {
  /**
   * Same DI trick as the publisher: default one for you, but you could
   * pass a mock in a test.
   */
  constructor(
    private readonly publisher: RabbitMqPublisher = new RabbitMqPublisher(),
  ) {}

  /**
   * Called by RequestLogger when a request has COMPLETED (the response
   * was sent). Builds a request-log entry from everything available.
   */
  async publishRequest(req: Request, res: Response, startTime: number): Promise<void> {
    const status = res.statusCode;
    const userId = toString(req.headers["x-user-id"]);
    const ip = toString(req.ip);
    const requestId = toString(req.headers["x-request-id"]);

    // Derive a log LEVEL from the HTTP status:
    //   2xx → info, 4xx → warn (client's fault), 5xx → error (server's fault)
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      service: "gateway",
      method: req.method,
      path: req.originalUrl,
      status,
      latencyMs: Date.now() - startTime,
      message: `${req.method} ${req.originalUrl} -> ${status}`,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ...(ip !== undefined ? { ip } : {}),
    };

    this.logToConsole(entry);
    await this.publisher.publish(entry);
  }

  /**
   * Called everywhere else: circuit breaker trips, 429 blocks, cache
   * hits/misses, proxy errors. `metadata` rides along as free-form JSON.
   */
  async publishEvent(
    level: LogLevel,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      service: "gateway",
      message,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    this.logToConsole(entry);
    await this.publisher.publish(entry);
  }

  /** Closes the RabbitMQ connection during gateway shutdown. */
  async shutdown(): Promise<void> {
    await this.publisher.closeConnection();
  }

  /**
   * Console mirror of every entry. Gives instant local-dev observability
   * even when RabbitMQ is down (RabbitMqPublisher fails open silently),
   * and matches the existing console.log() style of this codebase.
   */
  private logToConsole(entry: LogEntry): void {
    const parts = [
      `[${entry.ts}]`,
      entry.service,
      entry.level.toUpperCase(),
      entry.requestId ? `req=${entry.requestId}` : undefined,
      entry.method ? `"${entry.method} ${entry.path}"` : `"${entry.message}"`,
      entry.status !== undefined ? `status=${entry.status}` : undefined,
      entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : undefined,
      entry.userId !== undefined ? `user=${entry.userId}` : undefined,
      entry.ip !== undefined ? `ip=${entry.ip}` : undefined,
    ].filter(Boolean);

    console.log(parts.join(" "), entry.metadata ?? "");
  }
}

/**
 * Helper: Express headers can be a string OR a list of strings.
 * We only want the single-string case.
 */
function toString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
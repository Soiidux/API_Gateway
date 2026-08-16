/**
 * Shared log contract between the gateway (producer) and the log-worker
 * (consumer). Both sides must serialize exactly this shape onto the
 * RabbitMQ queue; the worker then maps one entry to one Postgres row.
 *
 * `type` is used for the LogLevel union (a closed set of allowed values);
 * `interface` describes the LogEntry object shape. Optional fields (`?`)
 * may be absent at runtime — e.g. a circuit-breaker event has no
 * method/path — so the contract stays permissive while the DB columns
 * remain nullable.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  service: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  latencyMs?: number;
  userId?: string;
  ip?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** The single queue name both sides use. Kept in one constant so it
 *  can never be typo'd differently in the publisher vs the consumer. */
export const LOG_QUEUE = "api_gateway_logs";
/**
 * Mirror copy of the gateway's LogEntry contract. The two containers
 * cannot import each other's code, so the agreed-upon JSON shape lives on
 * both sides and must stay in sync (the worker is on the receiving end).
 *
 * Once pulled off the queue each entry maps to ONE row in the logs table.
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

/** MUST match the queue name the gateway publishes to. */
export const LOG_QUEUE = "api_gateway_logs";
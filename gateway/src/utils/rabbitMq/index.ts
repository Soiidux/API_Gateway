/**
 * Barrel file: re-exports the rabbitMq modules so callers import from one
 * place — `import ... from "./utils/rabbitMq/index.js"`.
 *
 * The `export default new LogPublisher()` singleton evaluates once at
 * first import and is shared by every gateway component that imports it
 * (RateLimitMiddleware, CacheMiddleware, circuit-breaker hooks,
 * RequestLogger). Sharing matters: one lazy connection/channel serves all
 * producers instead of one TCP socket per module.
 *
 * Layering (low → high): LogEntry (contract) → RabbitConnectionManager
 * (socket/channel) → RabbitMqPublisher (queue write) → LogPublisher
 * (request/event API) → this shared singleton.
 */
export { RabbitMQConnectionManager } from "./RabbitConnectionManager.js";
export { RabbitMqPublisher } from "./RabbitMqPublisher.js";
export { LogPublisher } from "./LogPublisher.js";
export { LOG_QUEUE, type LogEntry, type LogLevel } from "./LogEntry.js";

import { LogPublisher } from "./LogPublisher.js";

/**
 * Shared log publisher singleton for all gateway components.
 */
export default new LogPublisher();
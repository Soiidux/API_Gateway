/**
 * All environment-dependent values, read from process.env (populated by
 * dotenv). `?? default` fallbacks let the worker run out-of-the-box if
 * vars are missing — defaults point at localhost for laptop dev, while
 * Docker/compose overrides them via the container's environment.
 */
import "dotenv/config";

const config = {
  RABBITMQ_URL: process.env.RABBITMQ_URL ?? "amqp://localhost:5672",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://gateway_user:gateway_secure_password@localhost:5432/gateway_db",
  // Retention: delete log rows older than RETENTION_DAYS, checked every
  // RETENTION_INTERVAL_HOURS. (Also handled at boot — see RetentionCleanup.)
  RETENTION_DAYS: parseInt(process.env.RETENTION_DAYS ?? "30", 10),
  RETENTION_INTERVAL_HOURS: parseInt(process.env.RETENTION_INTERVAL_HOURS ?? "6", 10),
};

export default config;
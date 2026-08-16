/**
 * All environment-dependent values for the user-service.
 *
 * Defaults point at localhost for laptop dev (matching the compose
 * credentials); Docker overrides them via the container's environment
 * (see docker-compose.yml).
 */
import "dotenv/config";

const config = {
  PORT: parseInt(process.env.PORT || "3001", 10),
  INSTANCE_ID: process.env.INSTANCE_ID || "0",
  JWT_SECRET: process.env.JWT_SECRET || "gateway_secret_is_super_secure",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://gateway_user:gateway_secure_password@localhost:5432/gateway_db",
};

export default config;
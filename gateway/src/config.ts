/**
 * Central configuration for the gateway.
 *
 * dotenv loads the gateway/.env file into process.env; we extract the
 * values this app cares about and give them types via the `Config`
 * interface (src/types/types.d.ts).
 *
 * Precedence: docker-compose injects env vars (service-name hostnames)
 * in container deployments, .env provides them for local dev, and the
 * `|| ""` fallbacks keep the gateway bootable when a value is missing.
 *
 * Comma-separated URL lists (USER/PAYMENT_SERVICE_URLS) are split into
 * arrays by getServiceUrls because the load balancer needs the list of
 * replica URLs rather than one long string.
 */
import dotenv from "dotenv";
import getServiceUrls from "./utils/getServiceUrls.js";
dotenv.config();

const config: Config = {
  PORT: parseInt(process.env.PORT || "3000"),
  JWT_SECRET: process.env.JWT_SECRET || "",
  USER_SERVICE_URLS: process.env.USER_SERVICE_URLS ? getServiceUrls(process.env.USER_SERVICE_URLS) : [],
  PAYMENT_SERVICE_URLS: process.env.PAYMENT_SERVICE_URLS ? getServiceUrls(process.env.PAYMENT_SERVICE_URLS) : [],
  REDIS_URL: process.env.REDIS_URL || "",
  RABBITMQ_URL: process.env.RABBITMQ_URL || "",
}

export default config;
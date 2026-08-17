/**
 * Global ambient types for the gateway.
 *
 * Declared with `declare global` so every file can use them without an
 * import. These sit at the boundary between the routing config
 * (proxyUtil) and the middleware that consumes it:
 *
 *  - ApiResponse<T>      : the standard response envelope produced by
 *                          generateApiResponse and every backend
 *  - Config              : the resolved env config (see config.ts)
 *  - ServiceConfig       : one proxied service's routing table —
 *                          path/urls/roles/bodySchemas/caching
 */
import { z } from "zod";

declare global {
  interface ApiResponse<T> {
    data: T;
    message: string;
    status: number;
    success: boolean;
  }
  interface Config {
    PORT: number;
    JWT_SECRET: string;
    USER_SERVICE_URLS: string[];
    PAYMENT_SERVICE_URLS: string[];
    REDIS_URL: string;
    RABBITMQ_URL: string;
  }
  interface ServiceConfig {
    path: string;
    urls: string[];
    name: string;
    timeout?: number;
    publicRoutes?: string[];
    roleMap?: Record<string, string[]>;
    defaultRoles?: string[];
    bodySchemas?: Record<string, z.ZodSchema>;
    cachebleRoutes?: Record<string, {
      ttl: number;
    }>;
  }
}

export { };
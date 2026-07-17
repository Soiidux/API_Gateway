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
import type { Request } from "express";

function buildCacheKey(req: Request): string {
  const { method, originalUrl } = req;
  return `cache:${method}:${originalUrl}`;
}

export default buildCacheKey;
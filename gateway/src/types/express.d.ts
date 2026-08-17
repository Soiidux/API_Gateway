/**
 * Express request augmentation.
 *
 * The gateway's middleware chain stashes per-request state directly on
 * `req` and later middleware/helpers read it back. These fields are
 * declared here so TypeScript knows they exist:
 *
 *  - proxyServer      : the upstream server selected by selectServer()
 *  - proxyServiceName : the logical service being proxied
 *  - cacheKey / cacheTTL : set by CacheMiddleware on a cache MISS
 *  - requestId        : set by RequestLogger for log correlation
 *
 * Files are .d.ts declaration files — no runtime code, purely types.
 */
declare global {
  namespace Express {
    interface Request {
      proxyServer: string;
      proxyServiceName: string;
      cacheKey: string;
      cacheTTL: number;
      requestId: string;
    }
  }
}

export {};
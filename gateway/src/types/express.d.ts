declare global {
  namespace Express {
    interface Request {
      proxyServer: string;
      proxyServiceName: string;
      cacheKey: string;
      cacheTTL: number;
    }
  }
}

export {};
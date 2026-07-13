declare global {
  namespace Express {
    interface Request {
      proxyServer: string;
      proxyServiceName: string;
    }
  }
}

export {};
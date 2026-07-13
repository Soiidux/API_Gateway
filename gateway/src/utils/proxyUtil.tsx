import { type Application, type NextFunction, type Response , type Request} from "express";
import { createProxyMiddleware, type Options, fixRequestBody } from "http-proxy-middleware";
import config from "../config.js";
import RoundRobinLoadBalancer from "./loadBalancer.js";
import conditionalAuth from "../middlewares/conditionalAuth.js";
import * as schema from "../libs/zod.schemas.js"
import validateBody from "../middlewares/validateBody.js";

class ProxyUtil {
  private static readonly serviceConfigs: ServiceConfig[] = [
    {
      path: "/api/v1/users",
      urls: config.USER_SERVICE_URLS,
      name: "user-service",
      timeout: 5000,
      publicRoutes: ["/register"],
      roleMap: {
        "/getAll": ["ADMIN", "MANAGER"],
      },
      bodySchemas: {
        "/register": schema.registerUserSchema,
      },
    },
    {
      path: "/api/v1/payments",
      urls: config.PAYMENT_SERVICE_URLS,
      name: "payment-service",
      defaultRoles: ["ADMIN"],
    }
  ];

  //one balancer per service path
  private static balancers = new Map<string, RoundRobinLoadBalancer>();


  private static selectServer(serviceName: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const balancer = ProxyUtil.balancers.get(serviceName);
      try {
        req.proxyServer = balancer!.getNextServer();
        req.proxyServiceName = serviceName;
        next();
      }
      catch (error) {
        const responsePayload: ApiResponse<null> = {
          message: 'Service unavailable: ' + new Date().toISOString() + ' ' + (error as Error).message,
          status: 503,
          success: false,
          data: null,
        };
        return res.status(503).json(responsePayload);
      }
    }
  }
  private static createProxyOptions(serviceConfig: ServiceConfig): Options {
    return {
      target: serviceConfig.urls[0]!,
      changeOrigin: true,
      timeout: serviceConfig.timeout ?? 5000,
      router: (req: any) => {
        return req.proxyServer;
      },
      on: {
        error: ProxyUtil.handleProxyError,
        proxyReq: ProxyUtil.handleProxyRequest,
        proxyRes: ProxyUtil.handleProxyResponse,
      }
    }
  }

  private static handleProxyError(err: Error, req: any, res: any): void {
    const balancer = ProxyUtil.balancers.get(req.proxyServiceName);
    if (req.proxyServer) {
      balancer?.recordFailure(req.proxyServer);
    }
    
    const errorResponse: ApiResponse<null> = {
      message: 'Service unavailable: ' + new Date().toISOString() + ' ' + (err as Error).message,
      status: 503,
      success: false,
      data: null,
    };

    return res
      .status(503)
      .setHeader('Content-Type', 'application/json')
      .end(JSON.stringify(errorResponse))
  }

  private static handleProxyRequest(proxyReq: any, req: any): void {
    console.log("Proxy hit");
    if (req.body) {
      fixRequestBody(proxyReq, req);
    }
    if (req.headers["x-user-id"]) {
      proxyReq.setHeader("x-user-id", req.headers["x-user-id"] as string);
    }
    if (req.headers["x-user-role"]) {
      proxyReq.setHeader("x-user-role", req.headers["x-user-role"] as string);
    }
  }

  private static handleProxyResponse(proxyRes: any, req: any): void {
    const balancer = ProxyUtil.balancers.get(req.proxyServiceName);
    if (req.proxyServer) {
      balancer?.recordSuccess(req.proxyServer);
    } else {
      balancer?.recordFailure(req.proxyServer);
    }
  }

  public static setUpProxy(app: Application): void {
    ProxyUtil.serviceConfigs.forEach((service) => {
      ProxyUtil.balancers.set(service.name, new RoundRobinLoadBalancer(service.urls));
      const proxyOptions: Options = ProxyUtil.createProxyOptions(service);
      app.use(service.path, conditionalAuth(service.publicRoutes, service.roleMap, service.defaultRoles), validateBody(service.bodySchemas), ProxyUtil.selectServer(service.name), createProxyMiddleware(proxyOptions));
    })
  }
}

const proxyServices = (app: Application) => {
  ProxyUtil.setUpProxy(app);
}

export default proxyServices;

import { type Application } from "express";
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

  private static createProxyOptions(serviceConfig: ServiceConfig): Options {
    const balancer = new RoundRobinLoadBalancer(serviceConfig.urls);
    return {
      target: serviceConfig.urls[0]!,
      changeOrigin: true,
      timeout: serviceConfig.timeout ?? 5000,
      router: () => {
        const target = balancer.getNextServer();
        return target;
      },
      on: {
        error: ProxyUtil.handleProxyError,
        proxyReq: ProxyUtil.handleProxyRequest,
        proxyRes: ProxyUtil.handleProxyResponse,
      }
    }
  }

  private static handleProxyError(err: Error, req: any, res: any): void {
    const errorResponse: ApiResponse<null> = {
      message: 'Service unavailable: ' + new Date().toISOString() + ' ' + err.message,
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
    // logger.debug(`Received response for ${req.path}`);
  }

  public static setUpProxy(app: Application): void {
    ProxyUtil.serviceConfigs.forEach((config) => {
      const proxyOptions: Options = ProxyUtil.createProxyOptions(config);
      app.use(config.path, conditionalAuth(config.publicRoutes, config.roleMap, config.defaultRoles), validateBody(config.bodySchemas), createProxyMiddleware(proxyOptions));
    })
  }
}

const proxyServices = (app: Application) => {
  ProxyUtil.setUpProxy(app);
}

export default proxyServices;

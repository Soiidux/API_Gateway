import { type Application, type NextFunction, type Response, type Request } from "express";
import { createProxyMiddleware, type Options, fixRequestBody } from "http-proxy-middleware";
import config from "../config.js";
import RoundRobinLoadBalancer from "./loadBalancer.js";
import conditionalAuth from "../middlewares/conditionalAuth.js";
import * as schema from "../libs/zod.schemas.js";
import validateBody from "../middlewares/validateBody.js";
import rateLimitMiddleware from "../middlewares/rateLimitMiddleware.js";
class ProxyUtil {
  // ---------------------------------------------------------------------
  // The list of backend services this gateway knows how to proxy to.
  // Each entry describes ONE service: where it lives (urls), which
  // routes are public, which routes need specific roles, and which
  // routes need body validation before being forwarded.
  // ---------------------------------------------------------------------
  private static readonly serviceConfigs: ServiceConfig[] = [
    {
      path: "/api/v1/users",              // any request starting with this path goes to user-service
      urls: config.USER_SERVICE_URLS,      // list of instance URLs (round robin targets)
      name: "user-service",                // used as the key for this service's load balancer
      timeout: 5000,                       // how long to wait before giving up on a request
      publicRoutes: ["/register","/"],         // no JWT required for these
      roleMap: {
        "/getAll": ["ADMIN", "MANAGER"],   // only these roles may call /getAll
      },
      bodySchemas: {
        "/register": schema.registerUserSchema, // validate request body against this schema
      },
    },
    {
      path: "/api/v1/payments",
      urls: config.PAYMENT_SERVICE_URLS,
      name: "payment-service",
      defaultRoles: ["ADMIN"],             // EVERY route in this service requires ADMIN, unless overridden in roleMap
    },
  ];

  // ---------------------------------------------------------------------
  // One RoundRobinLoadBalancer per service, keyed by service name.
  // Created once, when the gateway starts (inside setUpProxy), and
  // reused for every request to that service afterwards.
  // ---------------------------------------------------------------------
  private static balancers = new Map<string, RoundRobinLoadBalancer>();

  /**
   * Middleware factory: picks which server instance this request should
   * go to, BEFORE the proxy actually runs. Runs once per request.
   *
   * Why do this in its own middleware instead of inside the proxy's
   * `router` option? Because middleware has normal access to `res`,
   * so if every server is unavailable we can cleanly send a 503 here
   * instead of trying to do that from inside http-proxy-middleware's
   * internals.
   */
  private static selectServer(serviceName: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const balancer = ProxyUtil.balancers.get(serviceName);
      try {
        // ask the balancer for the next healthy server (round robin,
        // skipping any server whose circuit breaker is tripped)
        req.proxyServer = balancer!.getNextServer();

        // remember which service this request belongs to, so later
        // handlers (handleProxyError / handleProxyResponse) know
        // which balancer to report back to
        req.proxyServiceName = serviceName;

        next(); // move on to the actual proxy middleware
      } catch (error) {
        // getNextServer() throws when every instance is currently
        // blocked (all circuit breakers tripped) — fail fast instead
        // of trying a doomed request
        const responsePayload: ApiResponse<null> = {
          message: 'Service unavailable: ' + new Date().toISOString() + ' ' + (error as Error).message,
          status: 503,
          success: false,
          data: null,
        };
        return res.status(503).json(responsePayload);
      }
    };
  }

  /**
   * Builds the options object that http-proxy-middleware needs to
   * actually forward a request to a backend service.
   */
  private static createProxyOptions(serviceConfig: ServiceConfig): Options {
    return {
      // fallback target — not really used since router() below always
      // overrides it with the server selectServer() already picked
      target: serviceConfig.urls[0]!,

      changeOrigin: true, // rewrites the Host header to match the target, so the backend sees itself as the recipient
      timeout: serviceConfig.timeout ?? 5000,

      // tells http-proxy-middleware WHERE to send this specific request.
      // we don't pick a server here — selectServer() already did that
      // and stashed it on req.proxyServer, we just hand it over.
      router: (req: any) => {
        return req.proxyServer;
      },

      on: {
        error: ProxyUtil.handleProxyError,     // fires if the request to the backend fails (down, timeout, refused)
        proxyReq: ProxyUtil.handleProxyRequest, // fires right before the request is sent to the backend
        proxyRes: ProxyUtil.handleProxyResponse, // fires when a response comes back from the backend
      },
    };
  }

  /**
   * Called when http-proxy-middleware fails to reach the chosen server
   * (connection refused, DNS failure, timeout, etc).
   */
  private static handleProxyError(err: Error, req: any, res: any): void {
    // tell this server's circuit breaker "that attempt failed" —
    // enough of these in a row and the breaker will block this
    // server temporarily
    const balancer = ProxyUtil.balancers.get(req.proxyServiceName);
    if (req.proxyServer) {
      balancer?.recordFailure(req.proxyServer);
    }

    // respond to the client with a generic "service unavailable"
    const errorResponse: ApiResponse<null> = {
      message: 'Service unavailable: ' + new Date().toISOString() + ' ' + (err as Error).message,
      status: 503,
      success: false,
      data: null,
    };
    return res
      .status(503)
      .setHeader('Content-Type', 'application/json')
      .end(JSON.stringify(errorResponse));
  }

  /**
   * Called right before the proxied request is sent out to the
   * backend server. Used to fix up the body and forward auth info
   * that conditionalAuth attached earlier in the chain.
   */
  private static handleProxyRequest(proxyReq: any, req: any): void {
    console.log("Proxy hit");

    // express.json() (earlier in the chain) already consumed the
    // original request stream to populate req.body — so we need to
    // manually re-write it onto the outgoing proxy request, otherwise
    // the backend receives an empty body
    if (req.body) {
      fixRequestBody(proxyReq, req);
    }

    // conditionalAuth attaches the authenticated user's id/role as
    // headers — forward those along so the backend service knows
    // who's making the request, without the backend needing to
    // verify the JWT itself
    if (req.headers["x-user-id"]) {
      proxyReq.setHeader("x-user-id", req.headers["x-user-id"] as string);
    }
    if (req.headers["x-user-role"]) {
      proxyReq.setHeader("x-user-role", req.headers["x-user-role"] as string);
    }
  }

  /**
   * Called when a response comes back from the backend server
   * (this includes error responses like 404/500 — it just means the
   * server was reachable and responded).
   */
  private static handleProxyResponse(proxyRes: any, req: any): void {
    const balancer = ProxyUtil.balancers.get(req.proxyServiceName);
    if (req.proxyServer) {
      // server responded -> tell its breaker "that worked", resetting
      // its failure count
      balancer?.recordSuccess(req.proxyServer);
    } else {
      // this branch should basically never run in practice — if
      // selectServer() couldn't pick a server, it already sent a 503
      // and next() was never called, so we'd never reach the proxy
      // at all. Kept here defensively.
      balancer?.recordFailure(req.proxyServer);
    }
  }

  /**
   * Registers all configured services onto the Express app.
   * For each service, builds this middleware chain:
   *
   *   conditionalAuth -> validateBody -> selectServer -> proxy
   *
   * (express.json() is expected to run before this, elsewhere,
   * so req.body is already parsed by the time validateBody runs)
   */
  public static setUpProxy(app: Application): void {
    ProxyUtil.serviceConfigs.forEach((service) => {
      // create this service's load balancer BEFORE registering the
      // routes, so it's guaranteed to exist by the time any request
      // comes in and selectServer() looks it up
      ProxyUtil.balancers.set(service.name, new RoundRobinLoadBalancer(service.urls));

      const proxyOptions: Options = ProxyUtil.createProxyOptions(service);

      app.use(
        service.path,
        conditionalAuth(service.publicRoutes, service.roleMap, service.defaultRoles), // 1. check JWT + role
        rateLimitMiddleware,                                                          // 2. rate limit
        validateBody(service.bodySchemas),                                            // 3. validate body shape
        ProxyUtil.selectServer(service.name),                                         // 4. pick a healthy server
        createProxyMiddleware(proxyOptions),                                          // 5. forward the request
      );
    });
  }
}

/**
 * Public entry point — call this once from index.ts to wire up
 * every configured service's proxy route.
 */
const proxyServices = (app: Application) => {
  ProxyUtil.setUpProxy(app);
};

export default proxyServices;
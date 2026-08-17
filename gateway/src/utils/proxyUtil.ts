import { type Application, type NextFunction, type Response, type Request } from "express";
import { createProxyMiddleware, type Options, fixRequestBody , responseInterceptor} from "http-proxy-middleware";
import config from "../config.js";
import RoundRobinLoadBalancer from "./loadBalancer.js";
import conditionalAuth from "../middlewares/conditionalAuth.js";
import * as schema from "../libs/zod.schemas.js";
import validateBody from "../middlewares/validateBody.js";
import RateLimitMiddleware from "../middlewares/rateLimitMiddleware.js";
import redisClient from "../db/redisClient.js";
import CacheMiddleware from "../middlewares/cacheMiddleware.js";
import RequestLogger from "../middlewares/RequestLogger.js";
import logPublisher from "./rabbitMq/index.js";

/**
 * The gateway's "brain": declares every backend service and the full
 * middleware chain applied to requests for it, plus the proxy handlers.
 *
 * Lifecycle per request (setUpProxy shows the wiring):
 *   1. RequestLogger.create()   log on response 'finish'
 *   2. conditionalAuth(...)     JWT + RBAC
 *   3. RateLimitMiddleware      publishEvent on 429
 *   4. CacheMiddleware          publishEvent on hit/miss
 *   5. validateBody(...)        zod body validation
 *   6. ProxyUtil.selectServer   pick a server via the balancer
 *   7. createProxyMiddleware    forward + log error events
 *
 * Logging fires in layers (1, 3, 4, 7) plus circuit-breaker hooks bound
 * per balancer — all via the shared rabbitMq singleton so one connection
 * serves every producer. Everything produced by `create()`/the factories
 * is a plain function, so the components compose trivially in the array
 * passed to app.use.
 */
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
      publicRoutes: ["/register", "/login", "/"],         // no JWT required for these
      roleMap: {
        "/getAll": ["ADMIN", "MANAGER"],   // only these roles may call /getAll
      },
      bodySchemas: {
        "/register": schema.registerUserSchema, // validate request body against this schema
        "/login": schema.loginUserSchema,
      },
      cachebleRoutes: {
        "/getAll": { ttl: 15 * 60 * 1000 },
      },
    },
    {
      path: "/api/v1/payments",
      urls: config.PAYMENT_SERVICE_URLS,
      name: "payment-service",
      defaultRoles: ["ADMIN"],             // EVERY route in this service requires ADMIN, unless overridden in roleMap
      cachebleRoutes: {
        "/getAll": { ttl: 15 * 60 * 1000 },
      },
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
      selfHandleResponse: true, //required for responseInterceptor to work
      on: {
        error: ProxyUtil.handleProxyError,     // fires if the request to the backend fails (down, timeout, refused)
        proxyReq: ProxyUtil.handleProxyRequest, // fires right before the request is sent to the backend
        proxyRes: responseInterceptor(ProxyUtil.handleProxyResponse), // fires when a response comes back from the backend
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

    void logPublisher.publishEvent("error", "Upstream proxy error", {
      service: req.proxyServiceName,
      server: req.proxyServer ?? null,
      error: (err as Error).message,
    });

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
    // conditionalAuth attaches the authenticated user's id/role as
    // headers — forward those along so the backend service knows
    // who's making the request. These are informational only; the
    // service (e.g. user-service requireAuth) re-verifies the actual
    // JWT itself rather than trusting them blindly.
    if (req.headers["x-user-id"]) {
      proxyReq.setHeader("x-user-id", req.headers["x-user-id"] as string);
    }
    if (req.headers["x-user-role"]) {
      proxyReq.setHeader("x-user-role", req.headers["x-user-role"] as string);
    }

    // Forward the raw Authorization header as well, so backends that do
    // their own service-level JWT verification (defense in depth) can
    // verify the token instead of trusting x-user-* headers.
    if (req.headers["authorization"]) {
      proxyReq.setHeader("authorization", req.headers["authorization"] as string);
    }

    // RequestLogger stamped a request id on every request — pass it down
    // so backend services can log under the SAME correlation id.
    if (req.headers["x-request-id"]) {
      proxyReq.setHeader("x-request-id", req.headers["x-request-id"] as string);
    }

    // Set headers BEFORE piping the body. Once the request body starts
    // streaming (below) the outbound headers are already flushed, and
    // any later setHeader would throw ERR_HTTP_HEADERS_SENT.
    // express.json() (earlier in the chain) already consumed the
    // original request stream to populate req.body — so we need to
    // manually re-write it onto the outgoing proxy request, otherwise
    // the backend receives an empty body
    if (req.body) {
      fixRequestBody(proxyReq, req);
    }
  }

  /**
   * Called when a response comes back from the backend server
   * (this includes error responses like 404/500 — it just means the
   * server was reachable and responded).
   */
   /**
    * Runs after the backend service responds, but BEFORE that response
    * is sent back to the client. Two jobs:
    *
    *   1. Report success/failure back to this server's circuit breaker
    *      (same purpose as before — just moved here, see note below).
    *   2. If this route was marked cacheable by cacheCheck middleware
    *      (req.cacheKey is set) and the response was a clean 200,
    *      store it in Redis so future identical requests can be served
    *      from cache instead of hitting the backend again.
    *
    * NOTE: this replaces the old plain `on.proxyRes` handler. Reading
    * the full response body requires `selfHandleResponse: true` on the
    * proxy options, which changes how the response is handled overall —
    * responseInterceptor buffers the whole body for us and expects this
    * function to return the (possibly unmodified) body to send onward.
    */
   private static async handleProxyResponse(
     responseBuffer: Buffer,
     proxyRes: any,
     req: any,
     res: any,
   ): Promise<Buffer> {
     // --- 1. circuit breaker reporting (unchanged logic, moved here) ---
     const balancer = ProxyUtil.balancers.get(req.proxyServiceName);
     if (req.proxyServer) {
       // we got a response at all -> the server is reachable -> success,
       // regardless of whether the response body itself is an error.
       // (a 404/500 from the backend still means the network path is fine)
       balancer?.recordSuccess(req.proxyServer);
     }
     // NOTE: the old "else -> recordFailure" branch is intentionally
     // removed. It could never actually run — selectServer() already
     // guarantees req.proxyServer is set before the proxy is ever
     // reached, or it responds with 503 and next() is never called.
   
     // --- 2. write to cache, if this route is cacheable ---
     // req.cacheKey / req.cacheTtl are only set by cacheCheck middleware
     // when this specific route was configured as cacheable AND the
     // request was a cache MISS (a HIT would have short-circuited
     // before ever reaching the proxy).
     if (req.cacheKey && proxyRes.statusCode === 200) {
       try {
         const payload = JSON.stringify({
           status: proxyRes.statusCode,
           body: responseBuffer.toString("utf8"),
           contentType: proxyRes.headers["content-type"] ?? "application/json",
         });
         await redisClient.set(req.cacheKey, payload, "EX", req.cacheTTL ?? 60);
       } catch (err) {
         // caching failure should never break the actual response —
         // log it and move on, the client still gets their data
         console.error("Failed to write response to cache:", err);
       }
     }
   
     // hand the body back unmodified — this is what actually gets sent
     // to the client (responseInterceptor requires a return value)
     return responseBuffer;
   }

  /**
   * Registers all configured services onto the Express app.
   * For each service, builds this middleware chain:
   *
   *   requestLogger -> conditionalAuth -> rateLimit -> cache -> validateBody -> selectServer -> proxy
   *
   * (express.json() is expected to run before this, elsewhere,
   * so req.body is already parsed by the time validateBody runs)
   */
  public static setUpProxy(app: Application): void {
    ProxyUtil.serviceConfigs.forEach((service) => {
      // create this service's load balancer BEFORE registering the
      // routes, so it's guaranteed to exist by the time any request
      // comes in and selectServer() looks it up. The logEvent hook
      // publishes whenever a server's circuit breaker trips/recovers.
      ProxyUtil.balancers.set(
        service.name,
        new RoundRobinLoadBalancer(service.urls, (serverUrl, state) => {
          void logPublisher.publishEvent(
            state === "OPEN" ? "warn" : "info",
            `Circuit breaker ${state} for ${serverUrl}`,
            { serverUrl, state, service: service.name },
          );
        }),
      );

      const proxyOptions: Options = ProxyUtil.createProxyOptions(service);

      app.use(
        service.path,
        RequestLogger.create(),                                                          // 1. log every request (fires on response finish)
        conditionalAuth(service.publicRoutes, service.roleMap, service.defaultRoles), // 2. check JWT + role
        RateLimitMiddleware.create(),                                                    // 3. rate limit
        CacheMiddleware.create(service.cachebleRoutes ?? {}),                            // 4. cache middleware
        validateBody(service.bodySchemas),                                            // 5. validate body shape
        ProxyUtil.selectServer(service.name),                                         // 6. pick a healthy server
        createProxyMiddleware(proxyOptions),                                          // 7. forward the request
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
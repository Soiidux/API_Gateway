import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import logPublisher from "../utils/rabbitMq/index.js";

/**
 * First consumer of the logging pipeline; also assigns request IDs.
 *
 * Correlation: every request gets a unique x-request-id. If the caller
 * already sent one we reuse it (so retries/orchestrators can tie events
 * together); otherwise we mint a UUID. The ID is echoed as a response
 * header, forwarded to backend services (see proxyUtil), and stored on
 * every log row, so one request's full story is filterable in Postgres.
 *
 * Component pattern: returns a plain middleware function from a static
 * `create()` factory, matching RateLimitMiddleware/CacheMiddleware so
 * configurable middlewares share one shape.
 *
 * 'finish' event: fires after the response is fully sent, by which point
 * downstream middleware ran (statusCode is final: 401/403/429/503/200)
 * and conditionalAuth set x-user-id. One listener captures the request's
 * entire outcome.
 */
export class RequestLogger {
  static create(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Stamp the wall-clock start of the request so we can measure latency.
      const startTime = Date.now();

      // ── request id (correlation) ────────────────────────────────────
      // Reuse a caller-provided id if present, otherwise mint a UUID.
      const incoming = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined;
      const requestId = incoming ?? randomUUID();
      req.headers["x-request-id"] = requestId;
      req.requestId = requestId;
      res.setHeader("x-request-id", requestId);

      // When the response finishes sending, publish one log row.
      // `void` = "fire the promise, don't await it" — never block the reply.
      res.on("finish", () => {
        void logPublisher.publishRequest(req, res, startTime);
      });

      // Hand the request to the NEXT middleware in the chain.
      next();
    };
  }
}

export default RequestLogger;
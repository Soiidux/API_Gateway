import express from "express";
import cors from "cors";
import helmet from "helmet";
import proxyServices from "./utils/proxyUtil.js";

/**
 * Gateway entry point.
 *
 * Middleware order matters: CORS (browser access policy) → helmet
 * (security headers) → express.json (parse bodies before anything reads
 * them; the proxy re-injects them downstream) → proxyServices(app) which
 * registers every /api/v1 route and its middleware chain (see
 * utils/proxyUtil.ts). A final error handler is the last safety net for
 * anything that throws.
 */
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(helmet());


app.use(express.json());

proxyServices(app);

app.use((err: any, req: any, res: any, next: any) => {
  console.error("🔥 Gateway CRASHED:", err.stack || err);
  return res.status(500).json({
    success: false,
    message: "Internal Microservice Error",
    error: err.message
  });
});

/**
 * Graceful shutdown.
 *
 * On SIGTERM/SIGINT (e.g. from Docker/Kubernetes) we have ~10s before
 * SIGKILL, so we close resources in order: stop accepting new requests,
 * drain, then close the RabbitMQ socket and Redis pool. This prevents
 * mid-write connection drops and lost/duplicated un-flushed log buffers.
 */
import redisClient from "./db/redisClient.js";
import logPublisher from "./utils/rabbitMq/index.js";

const server = app.listen(3000, () => {
  console.log("[Proxy] Gateway is running on port 3000");
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[Proxy] ${signal} received, shutting down gracefully...`);

  // Stop accepting new connections, then finish what's in-flight.
  server.close(() => {
    void (async () => {
      await logPublisher.shutdown(); // close RabbitMQ connection
      await redisClient.quit();      // close Redis connection
      console.log("[Proxy] Shutdown complete.");
      process.exit(0);
    })();
  });

  // Safety net: if existing requests take too long, force-exit.
  setTimeout(() => {
    console.error("[Proxy] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

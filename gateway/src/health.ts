/**
 * Health and readiness tracking.
 *
 * Two different questions, and the distinction matters in containers:
 *
 *   liveness  ("is this process alive?")    -> /health
 *   readiness ("can it serve traffic yet?")  -> /ready
 *
 * Why both: a container that is alive but not ready shouldn't receive
 * traffic — yet it also mustn't be restarted, because restarting it would
 * just restart whatever it was waiting for. Liveness answers "restart
 * me?", readiness answers "send me traffic?".
 *
 * The gateway is simpler than the backend services here: it owns no schema
 * and no migrations, so there's no wait-for-DDL phase. It's ready as soon
 * as it starts listening.
 *
 * Note it deliberately does NOT probe Redis or RabbitMQ. Both are treated
 * as optional in this design (the cache fails open, the log publisher fails
 * open), so a degraded dependency must not pull the gateway out of the load
 * balancer — that would turn a partial outage into a total one. Its
 * readiness reflects only "this process can accept and route requests".
 */
import type { Request, Response } from "express";

export class Readiness {
  private ready = false;
  /** Set once shutdown begins so the container stops attracting new traffic
   *  while in-flight requests drain. */
  private draining = false;

  /**
   * Called once the server is listening and able to route requests.
   */
  markReady(): void {
    this.ready = true;
  }

  markDraining(): void {
    this.draining = true;
  }

  isReady(): boolean {
    return this.ready && !this.draining;
  }

  /**
   * GET /health — liveness. Returns 200 whenever the event loop can answer at
   * all.
   */
  liveness = (_req: Request, res: Response): void => {
    res.status(200).json({ status: "ok" });
  };

  /**
   * GET /ready — readiness. 200 only once listening and not draining; 503
   * otherwise. Docker HEALTHCHECK points here.
   */
  readiness = (_req: Request, res: Response): void => {
    const ready = this.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : this.draining ? "draining" : "starting",
    });
  };
}

export default Readiness;
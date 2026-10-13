/**
 * Health and readiness tracking.
 *
 * Two different questions, and the distinction matters in containers:
 *
 *   liveness  ("is this process alive?")    -> /health
 *   readiness ("can it serve traffic yet?")  -> /ready
 *
 * Why both: a replica that is alive but still waiting for the schema to
 * exist must NOT be sent traffic — yet it also must NOT be restarted,
 * because restarting it would just restart the wait. Liveness answers
 * "restart me?" and readiness answers "send me traffic?".
 *
 * This is what replaces blind `depends_on` (which only waits for a
 * container to *start*) with a real readiness gate: Docker's HEALTHCHECK
 * polls /ready, and Compose's `depends_on: service_healthy` waits on that
 * result before starting anything downstream.
 *
 * The ready flag is deliberately set AFTER ensurePaymentTables() resolves,
 * not at listen() time — otherwise a replica could report healthy and
 * then 500 on its first real request because accounts/transactions
 * weren't there yet.
 */
import type { Request, Response } from "express";

export class Readiness {
  private ready = false;
  /** Set once shutdown begins so the container stops attracting new traffic
   *  while in-flight requests drain. */
  private draining = false;

  /**
   * Called once migrations have been applied (or confirmed present) and the
   * process is genuinely able to serve requests.
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
   * all. Deliberately does NOT check the database: a dead database shouldn't
   * get the container killed and restarted, it should just make it fail
   * requests (and show up as a failing readiness check instead).
   */
  liveness = (_req: Request, res: Response): void => {
    res.status(200).json({ status: "ok" });
  };

  /**
   * GET /ready — readiness. 200 only when migrations are done and we are not
   * draining; 503 otherwise. Docker HEALTHCHECK points here.
   */
  readiness = (_req: Request, res: Response): void => {
    const ready = this.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : this.draining ? "draining" : "starting",
    });
  };
}

export default Readiness;
/**
 * Circuit breaker: per-server health tracker.
 *
 * A tiny state machine that lets the load balancer decide whether a
 * server is safe to use right now:
 *   CLOSED    → healthy, requests flow
 *   OPEN      → consecutive failures exceeded the threshold; reject all
 *               traffic until the cooldown elapses
 *   HALF_OPEN → cooldown elapsed; admit ONE trial request to test recovery
 *
 * It only tracks state — it never sends traffic. The load balancer asks
 * canRequest() and feeds the outcome in via recordSuccess/recordFailure.
 *
 * The observer pattern: our injected onStateChange callback fires when
 * the breaker trips OPEN or recovers to CLOSED. The breaker doesn't know
 * who cares; the load balancer binds this to the gateway's LogPublisher,
 * so a state change becomes a log row without coupling the breaker to
 * logging/RabbitMQ.
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failureCount: number = 0; // Consecutive failures since last success
  private nextAttempt: number = 0;  // Timestamp when the cooldown elapses

  // failureThreshold + cooldownPeriod are fixed at construction; onStateChange is the
  // optional hook fired when the breaker trips OPEN or recovers to CLOSED (log event).
  // `now` is an injectable clock (defaults to Date.now) so tests can step time
  // deterministically instead of waiting on a real timer.
  constructor(
    private readonly failureThreshold: number = 5,
    private readonly cooldownPeriod: number = 30000,
    private readonly onStateChange?: (state: "OPEN" | "CLOSED") => void,
    private readonly now: () => number = () => Date.now(),
  ) {
  }

  canRequest(): boolean {
    if (this.state === "OPEN") {
      if(this.now()>=this.nextAttempt) {
        this.state = "HALF_OPEN";
        return true; // Cooldown elapsed — allow one trial request
      }
      return false; // Still cooling down
    }
    return true; // CLOSED or HALF_OPEN
  }

  recordSuccess(): void {
    const wasBlocked = this.state !== "CLOSED";
    this.failureCount = 0;
    this.state = "CLOSED";
    // Only announce recovery if we were actually blocked before.
    if (wasBlocked) {
      this.onStateChange?.("CLOSED");
    }
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.nextAttempt = this.now() + this.cooldownPeriod;
      this.onStateChange?.("OPEN");
    }
  }

  getState(): BreakerState {
    return this.state;
  }
}

export default CircuitBreaker;
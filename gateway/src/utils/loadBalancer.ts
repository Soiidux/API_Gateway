import CircuitBreaker, { type BreakerState } from "./circuitBreaker.js";

/**
 * Round-robin load balancer with per-server circuit breakers.
 *
 * Owns one CircuitBreaker per server URL. When building each breaker it
 * pins the URL in via a closure:
 *     (state) => this.logEvent(serverUrl, state)
 * The closure captures serverUrl so the breaker (which is generic and
 * knows nothing about URLs) still reports its state changes with the
 * right context — the observer stays decoupled, the callback adds detail.
 *
 * logEvent defaults to a no-op so callers that construct a balancer
 * without logging keep working (a non-breaking additive change).
 */
export default class RoundRobinLoadBalancer {
  private index = 0;
  private readonly circuitBreakersMap: Map<string, CircuitBreaker>;
  constructor(
    private readonly servers: string[],
    private readonly logEvent: (serverUrl: string, state: BreakerState) => void = () => {},
  ) {
    if (!servers.length) throw new Error("RoundRobinLoadBalancer requires at least one server");
    this.circuitBreakersMap = new Map();
    for (const serverUrl of servers) {
      this.circuitBreakersMap.set(
        serverUrl,
        // closure: pins serverUrl into the breaker's onStateChange hook
        new CircuitBreaker(5, 30000, (state) => this.logEvent(serverUrl, state)),
      );
    }
  }

  // Round-robin: advance the index each call, skip servers whose breaker
  // is open, and fail if every instance is currently unavailable.
  getNextServer(): string{
    for (let i = 0; i < this.servers.length; i++){
      const serverUrl = this.servers[this.index];
      this.index = (this.index + 1) % this.servers.length;
      if (this.circuitBreakersMap.get(serverUrl!)?.canRequest()) {
        return serverUrl!;
      }
    }
    throw new Error("All upstream instances are unavailable");
  }

  recordSuccess(serverUrl: string) : void {
    this.circuitBreakersMap.get(serverUrl)?.recordSuccess();
  }
  recordFailure(serverUrl: string) : void {
    this.circuitBreakersMap.get(serverUrl)?.recordFailure();
  }
}
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

  // Round-robin: only advance the rotation pointer when a server is
  // actually RETURNED. Skipped probes (open breakers) don't move the
  // pointer, so after a burst of blocked requests the rotation doesn't
  // drift — the next healthy pick still starts where round-robin left off.
  getNextServer(): string{
    for (let i = 0; i < this.servers.length; i++){
      const probeIndex = (this.index + i) % this.servers.length;
      const serverUrl = this.servers[probeIndex];
      if (this.circuitBreakersMap.get(serverUrl!)?.canRequest()) {
        // commit the pointer so the NEXT call starts after this server
        this.index = (probeIndex + 1) % this.servers.length;
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
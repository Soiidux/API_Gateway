import CircuitBreaker from "./circuitBreaker.js";

//Not only does round robin load balancing but wraps a circuit breaker around each target, skips open ones
export default class RoundRobinLoadBalancer {
  private index = 0;
  private readonly circuitBreakers: Map<string, CircuitBreaker>;
  constructor(private readonly servers: string[]) {
    if (!servers.length) throw new Error("RoundRobinLoadBalancer requires at least one server");
    this.circuitBreakers = new Map(servers.map(serverUrl => [serverUrl, new CircuitBreaker()]))
  }

  getNextServer(): string{
    for (let i = 0; i < this.servers.length; i++){
      const serverUrl = this.servers[this.index];
      this.index = (this.index + 1) % this.servers.length;
      if (this.circuitBreakers.get(serverUrl!)?.canRequest()) {
        return serverUrl!;
      }
    }
    throw new Error("All upstream instances are unavailable");
  }

  recordSuccess(serverUrl: string) : void {
    this.circuitBreakers.get(serverUrl)?.recordSuccess();
  }
  recordFailure(serverUrl: string) : void {
    this.circuitBreakers.get(serverUrl)?.recordFailure();
  }
}
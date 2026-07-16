import CircuitBreaker from "./circuitBreaker.js";

/*
picks which server to send a request to, cycling through them (round robin), while skipping any that their CircuitBreaker says are blocked.
It has 3 state variables:
  1.index: It remembers our position in the server list so round robin can continue from where we left off.
  2.servers: It is the list of server URLS of a particular service.
  3.circuitBreakersMap: It is a map of server URLS to their corresponding CircuitBreaker instances. Every server URL has an independent CircuitBreaker instance.

It has 3 methods:
  1.getNextServer(): string: Returns the next server URL to send a request to, using round robin and skipping any that are blocked by their CircuitBreaker.
  2.recordSuccess(serverUrl: string): void: Records a successful request for the given server URL, updating its CircuitBreaker.
  3.recordFailure(serverUrl: string): void: Records a failed request for the given server URL, updating its CircuitBreaker.
*/
export default class RoundRobinLoadBalancer {
  private index = 0; // The current index into the servers array
  private readonly circuitBreakersMap: Map<string, CircuitBreaker>; // A map of server URLS to their corresponding CircuitBreaker instances
  constructor(private readonly servers: string[]) { // The constructor takes an array of server URLS and initializes the circuitBreakersMap
    if (!servers.length) throw new Error("RoundRobinLoadBalancer requires at least one server");
    this.circuitBreakersMap = new Map(servers.map(serverUrl => [serverUrl, new CircuitBreaker()]))
  }

  // Returns the next server URL to send a request to in the following steps:
  // 1. Get the current server URL at the index, and increment the index for the next call. (Round robin)
  // 2. If the server URL is not blocked by its CircuitBreaker, return it.
  // 3. If all server URLs are blocked, throw an error, i.e no server url is returned.
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

  // Records a successful request for the given server URL, updating its CircuitBreaker.
  recordSuccess(serverUrl: string) : void {
    this.circuitBreakersMap.get(serverUrl)?.recordSuccess();
  }
  // Records a failed request for the given server URL, updating its CircuitBreaker.
  recordFailure(serverUrl: string) : void {
    this.circuitBreakersMap.get(serverUrl)?.recordFailure();
  }
}
type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

//Only manages the state of the circuit breaker, not the actual requests
class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failureCount: number = 0;
  private nextAttempt: number = 0;

  constructor(private readonly failureThreshold: number = 5, private readonly cooldownPeriod: number = 30000) {
  }
  
  canRequest(): boolean {
    if (this.state === "OPEN") {
      if(Date.now()>=this.nextAttempt) {
        this.state = "HALF_OPEN";
        return true; //allow one trial request 
      }
      return false; //still cooling down
    }
    return true; //CLOSED or HALF_OPEN
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.failureCount++;
    if(this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + this.cooldownPeriod;
    }
  }

  getState(): BreakerState {
    return this.state;
  }
}

export default CircuitBreaker;
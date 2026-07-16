/*What it's for, in one sentence: it's a health tracker for a single server 
it counts recent failures and decides "is this server okay to use right now, or should we avoid it for a bit."*/

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

//CLOSED: The server is working completely fine
//OPEN: The server has been failing for a amount greater than the failure threshold
//HALF_OPEN: A trial state to check if the server is up after the cool down period has passed

//Only manages the state of the circuit breaker, not the actual requests
// 
/*
It has 5 state variables: 
  1. state: State of the server
  2. failureCount: Number of times a proxy request failed in a row
  3. nextAttempt: A timestamp till the next attempt to reach the server 
  4. failureThreshold(readonly state): holds the failure threshold
  5. cooldownPeriod (readonly state): holds the cooldown period to send a request after the request fails after HALF_OPEN state or the failures > threshold

It has 4 methods:
  1.canRequest() : returns true/false on the basis of the state of the circuit breaker
  2.recordSuccess(): used to record success in the circuit breaker
  3.recordFailure(): used to record failure in the circuit breaker
  4.getState(): used to get the state of the circuit breaker 
*/
class CircuitBreaker {
  private state: BreakerState = "CLOSED"; //State of the server
  private failureCount: number = 0;       //How many times in a row has a server failed
  private nextAttempt: number = 0;        //A timestamp till its next attempt to reach the server or enter HALF_OPEN stateafter the server enters the OPEN State

  //At the time of construction failureThreshold and cooldownPeriod which are readonly private variables are initialized
  constructor(private readonly failureThreshold: number = 5, private readonly cooldownPeriod: number = 30000) {
  }

  //Can Request checks if request can be made to the server, it returns true for closed state and if cooldown period has passed but false otherwise
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


  //Once a proxy request is successful, it updates the failureCount to 0 and sets the state to closed
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }


  //Once a proxy request fails, it updates the failureCounter and sets the state to open if it was HALF_OPEN before or if failureThreshold is passed
  recordFailure(): void {
    this.failureCount++;
    if(this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + this.cooldownPeriod;
    }
  }


  //This simply gets the current state of the server
  getState(): BreakerState {
    return this.state;
  }
}

export default CircuitBreaker;
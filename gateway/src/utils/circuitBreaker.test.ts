import { describe, it, expect, beforeEach } from "vitest";
import CircuitBreaker, { type BreakerState } from "./circuitBreaker.js";

describe("CircuitBreaker", () => {
  let time: number;
  let states: BreakerState[] = [];

  beforeEach(() => {
    time = 1000;
    states = [];
  });

  const make = () =>
    new CircuitBreaker(3, 10000, (s) => states.push(s), () => time);

  it("starts CLOSED and allows requests", () => {
    const cb = make();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canRequest()).toBe(true);
  });

  it("trips OPEN after the threshold of consecutive failures", () => {
    const cb = make();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(states).toEqual(["OPEN"]);
    expect(cb.canRequest()).toBe(false);
  });

  it("blocks requests during the cooldown, then HALF_OPEN allows a trial", () => {
    const cb = make();
    for (let i = 0; i < 3; i++) cb.recordFailure();

    expect(cb.canRequest()).toBe(false); // inside cooldown

    time += 10000; // cooldown elapses
    const before = cb.getState();
    expect(cb.canRequest()).toBe(true); // HALF_OPEN admits one trial
    expect(cb.getState()).toBe("HALF_OPEN");
    expect(before).toBe("OPEN");
  });

  it("recovers to CLOSED on success in HALF_OPEN", () => {
    const cb = make();
    for (let i = 0; i < 3; i++) cb.recordFailure();
    time += 10000;
    expect(cb.canRequest()).toBe(true); // HALF_OPEN

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canRequest()).toBe(true);
    expect(states).toEqual(["OPEN", "CLOSED"]);
  });

  it("a failure in HALF_OPEN re-trips OPEN immediately", () => {
    const cb = make();
    for (let i = 0; i < 3; i++) cb.recordFailure();
    time += 10000;
    expect(cb.canRequest()).toBe(true);

    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canRequest()).toBe(false);
  });

  it("records success resets the failure count", () => {
    const cb = make();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // two more failures are now under the (3) threshold
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");
  });
});
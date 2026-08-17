import { describe, it, expect } from "vitest";
import RoundRobinLoadBalancer from "./loadBalancer.js";

describe("RoundRobinLoadBalancer", () => {
  it("throws if constructed with no servers", () => {
    expect(() => new RoundRobinLoadBalancer([])).toThrow(
      "requires at least one server",
    );
  });

  it("rotates through servers in order", () => {
    const lb = new RoundRobinLoadBalancer(["http://s1", "http://s2", "http://s3"]);
    const picked = Array.from({ length: 6 }, () => lb.getNextServer());
    expect(picked).toEqual([
      "http://s1", "http://s2", "http://s3",
      "http://s1", "http://s2", "http://s3",
    ]);
  });

  it("skips a server whose breaker is open", () => {
    const lb = new RoundRobinLoadBalancer(["http://a", "http://b", "http://c"]);
    // trip b's breaker: 5 consecutive failures (default threshold)
    for (let i = 0; i < 5; i++) lb.recordFailure("http://b");

    const picked = Array.from({ length: 6 }, () => lb.getNextServer());
    // b is never selected; a and c keep perfect round-robin order
    expect(picked.includes("http://b")).toBe(false);
    expect(picked).toEqual([
      "http://a", "http://c", "http://a", "http://c", "http://a", "http://c",
    ]);
  });

  it("throws when every server is unavailable", () => {
    const lb = new RoundRobinLoadBalancer(["http://x", "http://y"]);
    for (let i = 0; i < 5; i++) {
      lb.recordFailure("http://x");
      lb.recordFailure("http://y");
    }
    expect(() => lb.getNextServer()).toThrow("All upstream instances are unavailable");
  });

  it("recovers a server after its breaker trip if given a success", () => {
    const lb = new RoundRobinLoadBalancer(["http://a", "http://b"]);
    for (let i = 0; i < 5; i++) lb.recordFailure("http://a");

    // b is unaffected, so it keeps serving; a is skipped
    expect(lb.getNextServer()).toBe("http://b");

    // success on a resets it -> full rotation resumes
    lb.recordSuccess("http://a");
    const picked = new Set(Array.from({ length: 4 }, () => lb.getNextServer()));
    expect(picked).toEqual(new Set(["http://a", "http://b"]));
  });
});
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RetentionCleanup } from "./RetentionCleanup.js";
import type { LogRepository } from "./LogRepository.js";

function makeRepository() {
  const deleteOlderThan = vi.fn<LogRepository["deleteOlderThan"]>().mockResolvedValue(0);
  return { deleteOlderThan };
}

describe("RetentionCleanup", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-01-15T12:00:00Z")));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deletes rows older than keepDays (keepDays * 24h before now)", async () => {
    const repo = makeRepository();
    const cleanup = new RetentionCleanup(repo as unknown as LogRepository, 30, 1);

    await cleanup.cleanup();

    const cutoff = repo.deleteOlderThan.mock.calls[0]?.[0] as Date;
    expect(cutoff.getTime()).toBe(new Date("2025-12-16T12:00:00Z").getTime());
  });

  it("does not throw when the repository errors", async () => {
    const repo = makeRepository();
    repo.deleteOlderThan.mockRejectedValue(new Error("db gone"));
    const cleanup = new RetentionCleanup(repo as unknown as LogRepository, 30, 1);

    await expect(cleanup.cleanup()).resolves.toBeUndefined();
  });

  it("start() runs an immediate cleanup and starts the interval", async () => {
    const repo = makeRepository();
    const cleanup = new RetentionCleanup(repo as unknown as LogRepository, 30, 1);
    const spy = vi.spyOn(cleanup, "cleanup");

    cleanup.start();
    // immediate first pass + no other calls yet
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(2);

    cleanup.stop();
  });

  it("stop() clears the interval", async () => {
    const repo = makeRepository();
    const cleanup = new RetentionCleanup(repo as unknown as LogRepository, 30, 1);
    const spy = vi.spyOn(cleanup, "cleanup");

    cleanup.start();
    cleanup.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BatchBuffer } from "./BatchBuffer.js";
import type { Message } from "amqplib";
import type { LogEntry } from "./LogEntry.js";
import type { LogBatchWriter } from "./LogRepository.js";

function fakeMsg(): Message {
  return { content: Buffer.from("{}") } as unknown as Message;
}

function fakeEntry(): LogEntry {
  return {
    level: "info",
    service: "gateway",
    message: "request",
  } as unknown as LogEntry;
}

function makeRepository() {
  const insertBatch = vi.fn<LogBatchWriter["insertBatch"]>().mockResolvedValue(undefined);
  return { insertBatch };
}

describe("BatchBuffer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flushes and acks when the threshold is reached", async () => {
    const repo = makeRepository();
    const buffer = new BatchBuffer(repo, 2, 1000);
    const ack = vi.fn();
    const nack = vi.fn();
    buffer.bind(ack, nack);

    const m1 = fakeMsg();
    const m2 = fakeMsg();
    await buffer.push(m1, fakeEntry());
    await buffer.push(m2, fakeEntry());

    expect(repo.insertBatch).toHaveBeenCalledTimes(1);
    expect(repo.insertBatch).toHaveBeenCalledWith([expect.anything(), expect.anything()]);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledWith(m1);
    expect(ack).toHaveBeenCalledWith(m2);
    expect(nack).not.toHaveBeenCalled();
  });

  it("acks nothing when the insert fails, and nacks the whole batch for requeue", async () => {
    const repo = makeRepository();
    repo.insertBatch.mockRejectedValue(new Error("db down"));
    const buffer = new BatchBuffer(repo, 2, 1000);
    const ack = vi.fn();
    const nack = vi.fn();
    buffer.bind(ack, nack);

    const m1 = fakeMsg();
    const m2 = fakeMsg();
    await buffer.push(m1, fakeEntry());
    await buffer.push(m2, fakeEntry());

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledTimes(2);
  });

  it("does not flush below the threshold until the interval ticks", async () => {
    vi.useFakeTimers();
    try {
      const repo = makeRepository();
      const buffer = new BatchBuffer(repo, 50, 3000);
      const ack = vi.fn();
      buffer.bind(ack, vi.fn());
      buffer.start();

      await buffer.push(fakeMsg(), fakeEntry());
      expect(repo.insertBatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);
      expect(repo.insertBatch).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledTimes(1);

      buffer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards against concurrent flushes (single batch written at a time)", async () => {
    const repo = makeRepository();
    let resolveFirst!: () => void;
    let callCount = 0;
    repo.insertBatch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return new Promise<void>((res) => { resolveFirst = res; });
      return Promise.resolve();
    });

    const buffer = new BatchBuffer(repo, 2, 1000);
    const ack = vi.fn();
    buffer.bind(ack, vi.fn());

    const p1 = buffer.push(fakeMsg(), fakeEntry());
    const p2 = buffer.push(fakeMsg(), fakeEntry());

    // Both pushes hit the threshold while the first flush is still pending;
    // the second must NOT start a second insert.
    expect(repo.insertBatch).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(ack).toHaveBeenCalledTimes(2);
  });
});
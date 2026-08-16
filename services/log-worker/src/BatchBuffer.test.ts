/**
 * Unit tests for BatchBuffer's core guarantee: ack ONLY after a
 * successful insert; nack+requeue when the insert fails.
 *
 * Dependency-free & fast: BatchBuffer depends on the `LogBatchWriter`
 * INTERFACE, not LogRepository — so the test hands it a tiny fake that
 * records what it saw and can be told to throw. No Postgres, no RabbitMQ,
 * no network.
 *
 * Run with: npm test (node:test + tsx)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "amqplib";
import { BatchBuffer } from "./BatchBuffer.js";
import type { LogEntry, LogLevel } from "./LogEntry.js";
import type { LogBatchWriter } from "./LogRepository.js";

interface FakeMsg {
  content: Buffer;
}

function makeEntry(i: number): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: "info" as LogLevel,
    service: "test",
    message: `entry ${i}`,
  };
}

/** A fake RabbitMQ message — BatchBuffer only needs it to ack/nack by reference. */
function fakeMsg(id: number): Message {
  return { content: Buffer.from(JSON.stringify({ id })) } as unknown as Message;
}

function makeFakeRepository(): { repo: LogBatchWriter; inserted: LogEntry[][] } {
  const inserted: LogEntry[][] = [];
  const repo: LogBatchWriter = {
    insertBatch: async (entries) => {
      inserted.push([...entries]);
    },
  };
  return { repo, inserted };
}

test("acks every message after a successful batch insert", async () => {
  const { repo, inserted } = makeFakeRepository();
  const buffer = new BatchBuffer(repo, /*threshold*/ 3, /*interval*/ 100_000);
  const acked: unknown[] = [];
  const nacked: unknown[] = [];
  buffer.bind((m) => acked.push(m), (m) => nacked.push(m));

  await buffer.push(fakeMsg(1), makeEntry(1));
  await buffer.push(fakeMsg(2), makeEntry(2));
  // threshold of 3 reached on the next push → flush happens inline
  await buffer.push(fakeMsg(3), makeEntry(3));

  assert.equal(inserted.length, 1, "one batch of 3 should be inserted");
  assert.equal(inserted[0]?.length, 3);
  assert.equal(acked.length, 3, "all 3 messages acked after insert");
  assert.equal(nacked.length, 0, "nothing nacked on success");
});

test("nacks + requeues (no ack) when the insert fails", async () => {
  const failingRepo: LogBatchWriter = {
    insertBatch: async () => {
      throw new Error("database down");
    },
  };
  const buffer = new BatchBuffer(failingRepo, /*threshold*/ 1, /*interval*/ 100_000);
  const acked: unknown[] = [];
  const nacked: unknown[] = [];
  buffer.bind((m) => acked.push(m), (m) => nacked.push(m));

  await buffer.push(fakeMsg(9), makeEntry(9));

  assert.equal(acked.length, 0, "never ack on failure");
  assert.equal(nacked.length, 1, "the failed message is nacked (requeued)");
});

test("flush() is a no-op when the buffer is empty", async () => {
  const { repo, inserted } = makeFakeRepository();
  const buffer = new BatchBuffer(repo, 50, 100_000);

  await buffer.flush();

  assert.equal(inserted.length, 0, "no insert when nothing buffered");
});
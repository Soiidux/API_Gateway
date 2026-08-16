/**
 * Keeps the logs table from growing unbounded: deletes rows older than
 * `keepDays`, on a schedule. Same setInterval pattern as the BatchBuffer's
 * flush timer, pointed at a DELETE instead of an INSERT.
 *
 * start() runs an initial cleanup then a periodic timer; the timer is
 * unref'd so it never keeps the process alive on its own.
 */
import type { LogRepository } from "./LogRepository.js";
import config from "./config.js";

export class RetentionCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: LogRepository,
    private readonly keepDays: number = config.RETENTION_DAYS,
    private readonly intervalHours: number = config.RETENTION_INTERVAL_HOURS,
  ) {}

  start(): void {
    void this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup();
    }, this.intervalHours * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanup(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.keepDays * 24 * 60 * 60 * 1000);
      const deleted = await this.repository.deleteOlderThan(cutoff);
      if (deleted > 0) {
        console.log(`[Retention] Deleted ${deleted} log rows older than ${this.keepDays} days`);
      }
    } catch (error) {
      // Retention must never crash the worker — just log and move on.
      console.error("[Retention] Cleanup failed:", error);
    }
  }
}
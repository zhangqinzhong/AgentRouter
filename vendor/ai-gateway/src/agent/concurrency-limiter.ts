/**
 * Simple semaphore-based concurrency limiter.
 *
 * Limits how many async operations can run simultaneously.
 * Callers `acquire()` a slot and must call the returned `release()`
 * when done (typically in a `finally` block).
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void }> = [];

  constructor(private readonly maxConcurrency: number) {}

  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve(() => this.release());
      return;
    }

    this.active -= 1;
  }
}

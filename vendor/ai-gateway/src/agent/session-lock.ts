export interface SessionLockAcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface SessionLockWaiter {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SessionLockState {
  locked: boolean;
  queue: SessionLockWaiter[];
}

export class SessionLockAcquireTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number
  ) {
    super(`Timed out acquiring session lock for "${sessionId}" after ${timeoutMs}ms.`);
    this.name = 'SessionLockAcquireTimeoutError';
  }
}

/**
 * Per-session exclusive lock.
 *
 * Ensures that at most one async operation (e.g. an LLM call) runs
 * concurrently for any given session, while allowing different sessions
 * to proceed in parallel.
 */
export class SessionLockManager {
  private readonly locks = new Map<string, SessionLockState>();

  /**
   * Acquire an exclusive lock for the given session.
   * Returns a release function that MUST be called (typically in a `finally` block).
   */
  acquire(sessionId: string, options: SessionLockAcquireOptions = {}): Promise<() => void> {
    const state = this.ensureState(sessionId);
    if (!state.locked) {
      state.locked = true;
      return Promise.resolve(this.createRelease(sessionId));
    }

    return new Promise<() => void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const waiter: SessionLockWaiter = {
        resolve,
        reject
      };
      this.attachWaiterTimeout(sessionId, state, waiter, options.timeoutMs);
      this.attachWaiterAbort(sessionId, state, waiter, options.signal);
      state.queue.push(waiter);
    });
  }

  /**
   * Returns `true` if the given session currently has an active (unreleased) lock.
   */
  isLocked(sessionId: string): boolean {
    return this.locks.get(sessionId)?.locked ?? false;
  }

  /**
   * Release all lock state. Call during shutdown.
   */
  clear(): void {
    for (const state of this.locks.values()) {
      for (const waiter of state.queue) {
        this.cleanupWaiter(waiter);
        waiter.reject(new Error('Session lock manager cleared.'));
      }
    }
    this.locks.clear();
  }

  private ensureState(sessionId: string): SessionLockState {
    const existing = this.locks.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionLockState = {
      locked: false,
      queue: []
    };
    this.locks.set(sessionId, created);
    return created;
  }

  private attachWaiterTimeout(
    sessionId: string,
    state: SessionLockState,
    waiter: SessionLockWaiter,
    timeoutMs: number | undefined
  ): void {
    const normalizedTimeoutMs =
      Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
        ? Math.floor(timeoutMs as number)
        : undefined;
    if (normalizedTimeoutMs === undefined) {
      return;
    }

    waiter.timeout = setTimeout(() => {
      this.removeWaiter(state, waiter);
      waiter.reject(new SessionLockAcquireTimeoutError(sessionId, normalizedTimeoutMs));
      this.cleanupWaiter(waiter);
      this.cleanupStateIfIdle(sessionId, state);
    }, normalizedTimeoutMs);
  }

  private attachWaiterAbort(
    sessionId: string,
    state: SessionLockState,
    waiter: SessionLockWaiter,
    signal: AbortSignal | undefined
  ): void {
    if (!signal) {
      return;
    }

    waiter.signal = signal;
    waiter.onAbort = () => {
      this.removeWaiter(state, waiter);
      waiter.reject(createAbortError());
      this.cleanupWaiter(waiter);
      this.cleanupStateIfIdle(sessionId, state);
    };

    signal.addEventListener('abort', waiter.onAbort, { once: true });
  }

  private createRelease(sessionId: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.release(sessionId);
    };
  }

  private release(sessionId: string): void {
    const state = this.locks.get(sessionId);
    if (!state) {
      return;
    }

    const waiter = state.queue.shift();
    if (!waiter) {
      state.locked = false;
      this.cleanupStateIfIdle(sessionId, state);
      return;
    }

    this.cleanupWaiter(waiter);
    waiter.resolve(this.createRelease(sessionId));
  }

  private removeWaiter(state: SessionLockState, target: SessionLockWaiter): void {
    const index = state.queue.indexOf(target);
    if (index >= 0) {
      state.queue.splice(index, 1);
    }
  }

  private cleanupWaiter(waiter: SessionLockWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = undefined;
    }

    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.signal = undefined;
    waiter.onAbort = undefined;
  }

  private cleanupStateIfIdle(sessionId: string, state: SessionLockState): void {
    if (!state.locked && state.queue.length === 0 && this.locks.get(sessionId) === state) {
      this.locks.delete(sessionId);
    }
  }
}

function createAbortError(): Error {
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
}

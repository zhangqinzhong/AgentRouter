import type { AgentRetryPolicyConfig } from '../types';
import type { AgentRuntimeLogger } from './types';

export interface RetryExecutionOptions<T> {
  stage: string;
  operation: (attempt: number) => Promise<T>;
  policy: AgentRetryPolicyConfig;
  signal?: AbortSignal;
  logger?: AgentRuntimeLogger;
  context?: Record<string, unknown>;
  shouldRetry?: (error: unknown) => boolean;
}

export async function runWithRetry<T>(options: RetryExecutionOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.policy.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    try {
      return await options.operation(attempt);
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || options.signal?.aborted) {
        throw createAbortError();
      }

      const canRetry = attempt < maxAttempts && (options.shouldRetry?.(error) ?? true);
      if (!canRetry) {
        throw error;
      }

      const delayMs = computeBackoffDelayMs(options.policy, attempt);
      options.logger?.warn?.(
        {
          stage: options.stage,
          attempt,
          maxAttempts,
          delayMs,
          details: toErrorMessage(error),
          ...options.context
        },
        'Operation failed and will retry with backoff.'
      );
      await sleepWithAbort(delayMs, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }

  const status = readNumericProperty(error, 'status') ?? readNumericProperty(error, 'statusCode');
  if (typeof status === 'number') {
    return isRetryableHttpStatus(status);
  }

  const code = (readStringProperty(error, 'code') || '').toLowerCase();
  if (
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'ehostunreach' ||
    code === 'enotfound' ||
    code === 'eai_again'
  ) {
    return true;
  }

  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('overloaded') ||
    message.includes('temporarily unavailable') ||
    message.includes('service unavailable') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('connection reset') ||
    message.includes('connection aborted') ||
    message.includes('connection error') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('network')
  );
}

function readNumericProperty(error: unknown, key: string): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringProperty(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function computeBackoffDelayMs(policy: AgentRetryPolicyConfig, attempt: number): number {
  const baseDelayMs = Math.max(0, Math.trunc(policy.baseDelayMs));
  const backoffMultiplier = Math.max(1, Math.trunc(policy.backoffMultiplier));
  const maxDelayMs = Math.max(baseDelayMs, Math.trunc(policy.maxDelayMs));
  const jitterMs = Math.max(0, Math.trunc(policy.jitterMs));

  const backoff =
    baseDelayMs > 0
      ? Math.min(maxDelayMs, baseDelayMs * Math.pow(backoffMultiplier, Math.max(0, attempt - 1)))
      : 0;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return backoff + jitter;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(createAbortError());
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }

  return Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

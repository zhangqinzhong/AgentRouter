import type { AgentEventQueueConfig, AgentRuntimeConfig } from '../types';
import type { AgentEvent } from './types';

export type AgentEventSubscriber = (event: AgentEvent) => Promise<void> | void;

export interface AgentEventBus {
  publish(event: AgentEvent): void;
  subscribe(subscriber: AgentEventSubscriber): () => void;
  close(): Promise<void>;
}

interface AgentEventBusOptions {
  onSubscriberError?: (error: unknown, event: AgentEvent) => void;
  onPublishError?: (error: unknown, event: AgentEvent) => void;
  onQueueError?: (error: unknown) => void;
}

export interface InMemoryAgentEventBusOptions extends AgentEventBusOptions {}

export interface CreateAgentEventBusOptions extends AgentEventBusOptions {
  queueConfig?: AgentEventQueueConfig;
  runtimeConfig?: AgentRuntimeConfig;
}

export class InMemoryAgentEventBus implements AgentEventBus {
  private readonly subscribers = new Set<AgentEventSubscriber>();
  private readonly queue: AgentEvent[] = [];
  private readonly inflightDispatches = new Set<Promise<void>>();
  private readonly sessionDispatchChains = new Map<string, Promise<void>>();
  private drainPromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: InMemoryAgentEventBusOptions = {}) {}

  publish(event: AgentEvent): void {
    if (this.closed) {
      return;
    }

    this.queue.push(event);
    this.scheduleDrain();
  }

  subscribe(subscriber: AgentEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.queue.length > 0) {
      this.scheduleDrain();
    }

    while (this.drainPromise) {
      await this.drainPromise;
    }

    if (this.inflightDispatches.size > 0) {
      await Promise.allSettled([...this.inflightDispatches]);
    }

    this.subscribers.clear();
  }

  private scheduleDrain(): void {
    if (this.drainPromise) {
      return;
    }

    this.drainPromise = Promise.resolve()
      .then(async () => {
        await this.drainQueue();
      })
      .finally(() => {
        this.drainPromise = undefined;
        if (!this.closed && this.queue.length > 0) {
          this.scheduleDrain();
        }
      });
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      if (!event) {
        continue;
      }

      this.trackDispatch(this.enqueueSessionDispatch(event));
    }
  }

  private enqueueSessionDispatch(event: AgentEvent): Promise<void> {
    const key = event.sessionId || '__default__';
    const previous = this.sessionDispatchChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.dispatchToSubscribers(event);
      });

    this.sessionDispatchChains.set(key, next);
    return next.finally(() => {
      if (this.sessionDispatchChains.get(key) === next) {
        this.sessionDispatchChains.delete(key);
      }
    });
  }

  private trackDispatch(task: Promise<void>): void {
    this.inflightDispatches.add(task);
    task
      .catch(() => undefined)
      .finally(() => {
        this.inflightDispatches.delete(task);
      });
  }

  private async dispatchToSubscribers(event: AgentEvent): Promise<void> {
    if (this.subscribers.size === 0) {
      return;
    }

    const subscribers = [...this.subscribers];
    const settled = await Promise.allSettled(
      subscribers.map(async (subscriber) => subscriber(event))
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.options.onSubscriberError?.(result.reason, event);
      }
    }
  }
}

export function createAgentEventBus(options: CreateAgentEventBusOptions = {}): AgentEventBus {
  const sharedOptions: AgentEventBusOptions = {
    onSubscriberError: options.onSubscriberError,
    onPublishError: options.onPublishError,
    onQueueError: options.onQueueError
  };
  void options.queueConfig;
  void options.runtimeConfig;
  return new InMemoryAgentEventBus(sharedOptions);
}

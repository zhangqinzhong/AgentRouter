import { publishJsonEventToExternalSink } from '../external-event-sink';
import type { AgentEventQueueConfig, AgentEventWebhookConfig } from '../types';
import type { AgentEvent, AgentEventType } from './types';

export interface AgentEventPublisherLogger {
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
}

export interface AgentQueueEvent {
  eventId: string;
  emittedAt: string;
  eventType: AgentEventType;
  sessionId: string;
  correlationId: string;
  causationId?: string;
  eventTimestamp: string;
  payload: unknown;
}

let queueConfig: AgentEventQueueConfig | undefined;
let webhookConfig: AgentEventWebhookConfig | undefined;
let logger: AgentEventPublisherLogger | undefined;

export async function initializeAgentEventPublisher(
  config: AgentEventQueueConfig | undefined,
  webhookPublisherConfig?: AgentEventWebhookConfig,
  log?: AgentEventPublisherLogger
): Promise<void> {
  logger = log;
  initializeWebhookPublisher(webhookPublisherConfig);
  const normalizedConfig = normalizeConfig(config);
  initializeQueuePublisher(normalizedConfig);
}

export async function publishAgentEventToExternalSink(event: AgentEvent): Promise<boolean> {
  if (!webhookConfig?.enabled || !normalizeWebhookTarget(webhookConfig)) {
    return false;
  }

  return publishJsonEventToExternalSink(toWebhookEvent(event), webhookConfig);
}

export async function publishAgentEventToQueue(event: AgentEvent): Promise<boolean> {
  return publishAgentEventToExternalSink(event);
}

export async function closeAgentEventPublisher(): Promise<void> {
  queueConfig = undefined;
  webhookConfig = undefined;
}

function initializeWebhookPublisher(config: AgentEventWebhookConfig | undefined): void {
  if (!config?.enabled) {
    webhookConfig = config;
    logger?.info(
      {
        enabled: false
      },
      'Agent event webhook publisher is disabled.'
    );
    return;
  }

  const target = normalizeWebhookTarget(config);
  if (!target) {
    webhookConfig = {
      ...config,
      enabled: false
    };
    logger?.warn(
      {
        configuredEnabled: true
      },
      'Agent event webhook publisher is enabled but target is missing. Webhook delivery is disabled.'
    );
    return;
  }

  webhookConfig = {
    ...config,
    endpoint: config.endpoint?.trim(),
    command: config.command?.trim()
  };
  logger?.info(
    {
      target,
      transport: config.transport,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      headerKeys: Object.keys(config.headers)
    },
    'Agent event webhook publisher initialized.'
  );
}

function initializeQueuePublisher(config: AgentEventQueueConfig): void {
  queueConfig = {
    ...config,
    enabled: false
  };
  if (!config.enabled) {
    logger?.info(
      {
        enabled: false
      },
      'Agent event queue publisher is disabled.'
    );
    return;
  }

  logger?.warn(
    {
      queueName: config.queueName,
      jobName: config.jobName
    },
    'Agent event queue publisher is disabled because the gateway does not open database or Redis connections. Use an external protocol adapter for delivery.'
  );
}

function normalizeConfig(config: AgentEventQueueConfig | undefined): AgentEventQueueConfig {
  return (
    config || {
      enabled: false,
      queueName: 'gateway-agent-events',
      jobName: 'agent.event',
      removeOnComplete: 1000,
      removeOnFail: 5000
    }
  );
}

function normalizeWebhookTarget(config: AgentEventWebhookConfig): string | undefined {
  if (config.transport === 'stdio') {
    return config.command?.trim() || undefined;
  }

  return config.endpoint?.trim() || undefined;
}

function toWebhookEvent(event: AgentEvent): AgentQueueEvent {
  return {
    eventId: event.id,
    emittedAt: new Date().toISOString(),
    eventType: event.type,
    sessionId: event.sessionId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    eventTimestamp: event.timestamp,
    payload: event.payload
  };
}

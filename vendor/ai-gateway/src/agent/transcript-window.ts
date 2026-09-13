import type { AgentMessage, ToolCallRequestedPayload, ToolResultPayload, TranscriptItem, TranscriptWindow } from './types';

const MAX_WINDOW_ITEMS = 10;

export function createTranscriptWindow(): TranscriptWindow {
  return {
    items: []
  };
}

export function cloneTranscriptWindow(window: TranscriptWindow): TranscriptWindow {
  return {
    items: window.items.map(cloneItem)
  };
}

export function normalizeTranscriptWindow(
  value: unknown,
  fallbackMessages: AgentMessage[] = []
): TranscriptWindow {
  if (isObject(value) && Array.isArray(value.items)) {
    return {
      items: value.items.map(normalizeItem).filter((item): item is TranscriptItem => Boolean(item)).slice(-MAX_WINDOW_ITEMS)
    };
  }

  return {
    items: fallbackMessages
      .slice(-MAX_WINDOW_ITEMS)
      .map(mapMessageToTranscriptItem)
      .filter((item): item is TranscriptItem => Boolean(item))
  };
}

export function recordUserInput(
  current: TranscriptWindow,
  input: { eventId: string; timestamp: string; text: string }
): TranscriptWindow {
  return pushTranscriptItem(current, {
    id: input.eventId,
    timestamp: input.timestamp,
    type: 'user',
    text: input.text,
    raw: input.text
  });
}

export function recordAssistantReply(
  current: TranscriptWindow,
  input: { eventId: string; timestamp: string; text: string }
): TranscriptWindow {
  return pushTranscriptItem(current, {
    id: input.eventId,
    timestamp: input.timestamp,
    type: 'assistant',
    text: input.text,
    raw: input.text
  });
}

export function recordToolCall(
  current: TranscriptWindow,
  input: { eventId: string; timestamp: string; payload: ToolCallRequestedPayload }
): TranscriptWindow {
  return pushTranscriptItem(current, {
    id: input.eventId,
    timestamp: input.timestamp,
    type: 'tool_call',
    tool: input.payload.toolName,
    args: serializeUnknown(input.payload.arguments),
    raw: serializeUnknown(input.payload)
  });
}

export function recordToolResult(
  current: TranscriptWindow,
  input: { eventId: string; timestamp: string; payload: ToolResultPayload }
): TranscriptWindow {
  const raw = serializeUnknown(input.payload);
  const next = pushTranscriptItem(current, {
    id: input.eventId,
    timestamp: input.timestamp,
    type: 'tool_result',
    tool: input.payload.toolName,
    output: raw,
    raw
  });

  if (input.payload.status !== 'error') {
    return next;
  }

  const failureText = nonEmptyText(input.payload.error);
  if (!failureText) {
    return next;
  }

  return pushTranscriptItem(next, {
    id: `${input.eventId}:failure`,
    timestamp: input.timestamp,
    type: 'failure',
    text: failureText,
    raw: failureText
  });
}

export function recordError(
  current: TranscriptWindow,
  input: { eventId: string; timestamp: string; message: string }
): TranscriptWindow {
  return pushTranscriptItem(current, {
    id: input.eventId,
    timestamp: input.timestamp,
    type: 'failure',
    text: input.message,
    raw: input.message
  });
}

export function pushTranscriptItem(current: TranscriptWindow, item: TranscriptItem): TranscriptWindow {
  const next = cloneTranscriptWindow(current);
  const normalized = normalizeItem(item);
  if (!normalized) {
    return next;
  }

  const previous = next.items[next.items.length - 1];
  if (previous && itemsEqual(previous, normalized)) {
    return next;
  }

  next.items.push(normalized);
  trimWindow(next.items);
  return next;
}

function trimWindow(items: TranscriptItem[]): void {
  while (items.length > MAX_WINDOW_ITEMS) {
    const removableIndex = items.findIndex((item) => item.type !== 'user' && item.type !== 'failure');
    items.splice(removableIndex >= 0 ? removableIndex : 0, 1);
  }
}

function mapMessageToTranscriptItem(message: AgentMessage): TranscriptItem | undefined {
  if (message.role === 'user') {
    return {
      timestamp: message.timestamp,
      type: 'user',
      text: message.content,
      raw: message.content
    };
  }

  if (message.role === 'assistant') {
    return {
      timestamp: message.timestamp,
      type: 'assistant',
      text: message.content,
      raw: message.content
    };
  }

  if (message.role === 'tool') {
    return {
      timestamp: message.timestamp,
      type: 'tool_result',
      tool: message.toolName || 'tool',
      output: message.content,
      raw: message.content
    };
  }

  if (message.role === 'system' && message.content.startsWith('[error]')) {
    return {
      timestamp: message.timestamp,
      type: 'failure',
      text: message.content.replace(/^\[error\]\s*/, ''),
      raw: message.content
    };
  }

  return undefined;
}

function normalizeItem(value: unknown): TranscriptItem | undefined {
  if (!isObject(value) || typeof value.type !== 'string') {
    return undefined;
  }

  if (value.type === 'user' || value.type === 'assistant' || value.type === 'failure') {
    const text = nonEmptyText(value.text);
    if (!text) {
      return undefined;
    }
    return {
      id: normalizeMetadataText(value.id),
      timestamp: normalizeMetadataText(value.timestamp),
      type: value.type,
      text,
      raw: nonEmptyText(value.raw) || text
    };
  }

  if (value.type === 'tool_call') {
    const tool = normalizeMetadataText(value.tool);
    const args = nonEmptyText(value.args);
    if (!tool || !args) {
      return undefined;
    }
    return {
      id: normalizeMetadataText(value.id),
      timestamp: normalizeMetadataText(value.timestamp),
      type: 'tool_call',
      tool,
      args,
      raw: nonEmptyText(value.raw) || args
    };
  }

  if (value.type === 'tool_result') {
    const tool = normalizeMetadataText(value.tool);
    const output = nonEmptyText(value.output);
    if (!tool || !output) {
      return undefined;
    }
    return {
      id: normalizeMetadataText(value.id),
      timestamp: normalizeMetadataText(value.timestamp),
      type: 'tool_result',
      tool,
      output,
      raw: nonEmptyText(value.raw) || output
    };
  }

  return undefined;
}

function itemsEqual(left: TranscriptItem, right: TranscriptItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneItem(item: TranscriptItem): TranscriptItem {
  return JSON.parse(JSON.stringify(item)) as TranscriptItem;
}

function serializeUnknown(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized || String(value);
  } catch {
    return String(value);
  }
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim() ? value : undefined;
}

function normalizeMetadataText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

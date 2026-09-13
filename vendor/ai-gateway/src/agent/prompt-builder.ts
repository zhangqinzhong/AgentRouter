import type { AgentEvent, AgentSessionState, AgentToolDefinition } from './types';

export interface ParsedTriggerToolResult {
  toolCallId?: string;
  toolName: string;
  status: 'ok' | 'error';
  result: unknown;
  error?: string;
}

export function parseTriggerToolResult(triggerEvent: AgentEvent): ParsedTriggerToolResult | undefined {
  if (triggerEvent.type !== 'TOOL_RESULT' || !isObject(triggerEvent.payload)) {
    return undefined;
  }

  const toolName = readString(triggerEvent.payload.toolName);
  const status =
    triggerEvent.payload.status === 'ok' || triggerEvent.payload.status === 'error'
      ? triggerEvent.payload.status
      : undefined;
  if (!toolName || !status) {
    return undefined;
  }

  return {
    toolCallId: readString(triggerEvent.payload.toolCallId),
    toolName,
    status,
    result: triggerEvent.payload.result,
    error: readString(triggerEvent.payload.error)
  };
}

export function buildSystemPrompt(
  session: AgentSessionState,
  _triggerToolResult: ParsedTriggerToolResult | undefined,
  tools: AgentToolDefinition[]
): string {
  const sessionPrompt = session.systemPrompt.trim();
  const externalToolCount = tools.filter((tool) => !tool.name.startsWith('agent.')).length;
  const toolLine =
    externalToolCount > 0
      ? `You may call the provided tools when they materially advance the current task. ${externalToolCount} external tools are available this turn.`
      : 'No external side-effect tools are available this turn. Prefer a direct answer if one is possible.';

  return [
    sessionPrompt,
    'You operate with a minimal context model built from three blocks only: task, guards, and recent trajectory.',
    'Treat <task> as hard state, <guards> as explicit constraints, and <recent_trajectory> as the only high-fidelity local history.',
    'Items inside <recent_trajectory> preserve raw local excerpts; do not rewrite them into imagined summaries.',
    'Do not invent hidden plans, summaries of unseen history, or extra state machines.',
    'If a fact is not in the task, guards, or recent trajectory, assume it is unknown.',
    'Respect guards strictly. Prefer precise tool use over broad exploratory repetition.',
    toolLine
  ].join('\n\n');
}

export function buildModelInputText(
  triggerEvent: AgentEvent,
  session: AgentSessionState,
  _maxMessages: number,
  _triggerToolResult: ParsedTriggerToolResult | undefined,
  _tools: AgentToolDefinition[]
): string {
  const taskBlock = [
    '<task>',
    `goal: ${session.taskState.goal || 'Continue the active task.'}`,
    `active_step: ${session.taskState.activeStep || 'null'}`,
    'constraints:',
    ...formatList(session.taskState.constraints),
    'done:',
    ...formatList(session.taskState.done),
    'todo:',
    ...formatList(session.taskState.todo),
    `status: ${session.taskState.status}`,
    '</task>'
  ];

  const guardsBlock = [
    '<guards>',
    'do_not_repeat:',
    ...formatList(session.guards.doNotRepeat),
    'do_not_forget:',
    ...formatList(session.guards.doNotForget),
    'do_not_violate:',
    ...formatList(session.guards.doNotViolate),
    '</guards>'
  ];

  const trajectoryItems = session.transcriptWindow.items.length > 0
    ? session.transcriptWindow.items.map(formatTranscriptItem)
    : ['[none]'];
  const trajectoryBlock = [
    '<recent_trajectory>',
    ...trajectoryItems,
    `# trigger: ${describeTrigger(triggerEvent)}`,
    '</recent_trajectory>'
  ];

  return [...taskBlock, '', ...guardsBlock, '', ...trajectoryBlock].join('\n');
}

function formatList(values: string[]): string[] {
  if (values.length === 0) {
    return ['- none'];
  }

  return values.map((value) => `- ${value}`);
}

function formatTranscriptItem(item: AgentSessionState['transcriptWindow']['items'][number]): string {
  const raw = readString(item.raw);

  if (item.type === 'user' || item.type === 'assistant' || item.type === 'failure') {
    return raw ? `[${item.type}]\n${raw}` : `[${item.type}] ${item.text}`;
  }

  if (item.type === 'tool_call') {
    return raw ? `[tool_call ${item.tool}]\n${raw}` : `[tool_call ${item.tool}] ${item.args}`;
  }

  return raw ? `[tool_result ${item.tool}]\n${raw}` : `[tool_result ${item.tool}] ${item.output}`;
}

function describeTrigger(event: AgentEvent): string {
  if (event.type === 'USER_INPUT' && isObject(event.payload) && readString(event.payload.text)) {
    return `USER_INPUT ${readString(event.payload.text)}`;
  }

  if (event.type === 'TOOL_RESULT' && isObject(event.payload) && readString(event.payload.toolName)) {
    const status =
      event.payload.status === 'ok' || event.payload.status === 'error'
        ? event.payload.status
        : 'unknown';
    return `TOOL_RESULT ${readString(event.payload.toolName)} ${status}`;
  }

  return event.type;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

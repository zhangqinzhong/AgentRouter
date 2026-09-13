import type {
  AgentReplyPayload,
  ErrorPayload,
  SessionConfigUpdatedPayload,
  TaskState,
  ToolCallRequestedPayload,
  ToolResultPayload,
  UserInputPayload
} from './types';

const MAX_TASK_LIST_ITEMS = 10;

export function createInitialTaskState(taskId: string, objective?: string): TaskState {
  return {
    id: taskId,
    goal: normalizeText(objective) || '',
    activeStep: null,
    constraints: [],
    done: [],
    todo: [],
    status: normalizeText(objective) ? 'running' : 'running'
  };
}

export function cloneTaskState(taskState: TaskState): TaskState {
  return {
    ...taskState,
    constraints: [...taskState.constraints],
    done: [...taskState.done],
    todo: [...taskState.todo]
  };
}

export function normalizeTaskState(value: unknown, taskId: string): TaskState {
  const fallback = createInitialTaskState(taskId);
  if (!isObject(value)) {
    return fallback;
  }

  const goal =
    normalizeText(value.goal)
    || normalizeText(value.goal?.objective)
    || normalizeText(value.spec?.objective)
    || fallback.goal;
  const constraints = dedupeStrings(
    Array.isArray(value.constraints)
      ? value.constraints
      : Array.isArray(value.goal?.constraints)
      ? value.goal.constraints
      : []
  );
  const done = dedupeStrings(Array.isArray(value.done) ? value.done : []);
  const todo = dedupeStrings(Array.isArray(value.todo) ? value.todo : []);
  const legacyStatus =
    value.status === 'running' || value.status === 'blocked' || value.status === 'done'
      ? value.status
      : value.completion?.status === 'blocked'
      ? 'blocked'
      : value.completion?.status === 'done'
      ? 'done'
      : 'running';

  return {
    id: normalizeText(value.id) || normalizeText(value.taskId) || taskId,
    goal,
    activeStep:
      normalizeText(value.activeStep)
      || normalizeText(value.world?.environment?.currentIntent)
      || normalizeText(value.latestObservation?.summary)
      || null,
    constraints: constraints.slice(-MAX_TASK_LIST_ITEMS),
    done: done.slice(-MAX_TASK_LIST_ITEMS),
    todo: todo.slice(-MAX_TASK_LIST_ITEMS),
    status: legacyStatus
  };
}

export function applyUserInputToTaskState(
  current: TaskState,
  payload: UserInputPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  const text = normalizeText(payload.text);
  if (!text) {
    return next;
  }

  if (!next.goal || shouldTreatAsGoalUpdate(text)) {
    next.goal = text;
    next.done = [];
    next.todo = [];
  }

  const explicitStep = extractExplicitStep(text);
  if (explicitStep) {
    next.activeStep = explicitStep;
    next.todo = appendListItem(next.todo, explicitStep);
  }

  for (const constraint of extractConstraints(text)) {
    next.constraints = appendListItem(next.constraints, constraint);
  }

  next.status = 'running';
  return next;
}

export function applySessionConfigToTaskState(
  current: TaskState,
  payload: SessionConfigUpdatedPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  for (const memoryRef of Array.isArray(payload.memoryRefs) ? payload.memoryRefs : []) {
    next.constraints = appendListItem(next.constraints, memoryRef);
  }
  return next;
}

export function applyToolCallToTaskState(
  current: TaskState,
  payload: ToolCallRequestedPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  const step = normalizeText(payload.reason) || `Call ${payload.toolName}`;
  next.activeStep = step;
  next.todo = appendListItem(next.todo, step);
  next.status = 'running';
  return next;
}

export function applyToolResultToTaskState(
  current: TaskState,
  payload: ToolResultPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  const completion =
    payload.status === 'ok'
      ? `${payload.toolName} returned successfully`
      : `${payload.toolName} failed${payload.error ? `: ${payload.error}` : ''}`;

  next.done = appendListItem(next.done, completion);
  next.todo = next.todo.filter((item) => item !== next.activeStep);
  next.activeStep =
    payload.status === 'error'
      ? `Recover from ${payload.toolName} failure`
      : null;
  next.status = payload.status === 'error' ? 'blocked' : 'running';
  return next;
}

export function applyAgentReplyToTaskState(
  current: TaskState,
  _payload: AgentReplyPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  next.done = appendListItem(next.done, 'Agent reply delivered');
  next.activeStep = null;
  next.status = 'done';
  return next;
}

export function applyErrorToTaskState(
  current: TaskState,
  payload: ErrorPayload,
  _eventId: string
): TaskState {
  const next = cloneTaskState(current);
  next.activeStep = null;
  next.status = 'blocked';
  if (payload.message) {
    next.todo = appendListItem(next.todo, `Resolve error: ${payload.message}`);
  }
  return next;
}

function shouldTreatAsGoalUpdate(text: string): boolean {
  if (text.length < 6) {
    return false;
  }

  if (/^(不要|别|注意|记住|先别|先不要|如非必要|只要|仅|必须)/.test(text)) {
    return false;
  }

  return true;
}

function extractExplicitStep(text: string): string | undefined {
  const match = text.match(/(?:下一步|接下来|先|先去|先做|先看|先查|先检查|先确认)[:：]?\s*(.+)$/);
  return normalizeText(match?.[1]);
}

function extractConstraints(text: string): string[] {
  return text
    .split(/[\n。！？!?；;]+/)
    .map((segment) => segment.trim())
    .filter((segment) => /不要|别|必须|只能|勿|如非必要/.test(segment))
    .slice(-6);
}

function appendListItem(list: string[], value: string): string[] {
  return dedupeStrings([...list, value]).slice(-MAX_TASK_LIST_ITEMS);
}

function dedupeStrings(value: unknown[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of value) {
    const normalized = normalizeText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

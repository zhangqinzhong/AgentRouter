import type { Guards, TranscriptWindow } from './types';

const MAX_GUARDS_PER_BUCKET = 12;

export function createInitialGuards(memoryRefs: string[] = []): Guards {
  return {
    doNotRepeat: [],
    doNotForget: dedupe(memoryRefs),
    doNotViolate: []
  };
}

export function cloneGuards(guards: Guards): Guards {
  return {
    doNotRepeat: [...guards.doNotRepeat],
    doNotForget: [...guards.doNotForget],
    doNotViolate: [...guards.doNotViolate]
  };
}

export function normalizeGuards(value: unknown, memoryRefs: string[] = []): Guards {
  if (!isObject(value)) {
    return createInitialGuards(memoryRefs);
  }

  return {
    doNotRepeat: dedupeStrings(value.doNotRepeat).slice(-MAX_GUARDS_PER_BUCKET),
    doNotForget: dedupe([...memoryRefs, ...dedupeStrings(value.doNotForget)]).slice(-MAX_GUARDS_PER_BUCKET),
    doNotViolate: dedupeStrings(value.doNotViolate).slice(-MAX_GUARDS_PER_BUCKET)
  };
}

export function applyUserInputToGuards(current: Guards, text: string): Guards {
  const next = cloneGuards(current);
  const segments = splitSegments(text);

  for (const segment of segments) {
    if (isDoNotRepeatSegment(segment)) {
      next.doNotRepeat = appendGuard(next.doNotRepeat, segment);
      continue;
    }

    if (isDoNotForgetSegment(segment)) {
      next.doNotForget = appendGuard(next.doNotForget, segment);
      continue;
    }

    if (isDoNotViolateSegment(segment)) {
      next.doNotViolate = appendGuard(next.doNotViolate, segment);
    }
  }

  return next;
}

export function applySessionMemoryRefsToGuards(current: Guards, memoryRefs: string[]): Guards {
  const next = cloneGuards(current);
  for (const entry of memoryRefs) {
    next.doNotForget = appendGuard(next.doNotForget, entry);
  }
  return next;
}

export function applyToolFailureToGuards(
  current: Guards,
  input: {
    toolName: string;
    arguments: Record<string, unknown>;
    error?: string;
    transcriptWindow?: TranscriptWindow;
  }
): Guards {
  const next = cloneGuards(current);
  const callSignature = `${input.toolName} ${stableArgs(input.arguments)}`;

  next.doNotForget = appendGuard(
    next.doNotForget,
    input.error ? `${input.toolName} failed: ${input.error}` : `${input.toolName} failed`
  );

  if (hasRepeatedFailure(input.toolName, input.arguments, input.transcriptWindow)) {
    next.doNotRepeat = appendGuard(next.doNotRepeat, `Do not repeat ${callSignature}`);
  }

  return next;
}

export function shouldBlockToolCall(
  guards: Guards,
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  const signature = `${toolName} ${stableArgs(args)}`;

  for (const rule of guards.doNotRepeat) {
    if (rule.includes(signature)) {
      return rule;
    }
  }

  return undefined;
}

function hasRepeatedFailure(
  toolName: string,
  args: Record<string, unknown>,
  transcriptWindow?: TranscriptWindow
): boolean {
  if (!transcriptWindow) {
    return false;
  }

  const signature = `${toolName} ${stableArgs(args)}`;
  let count = 0;
  for (const item of transcriptWindow.items) {
    if (item.type === 'tool_call' && `${item.tool} ${item.args}` === signature) {
      count += 1;
    }
    if (count >= 2) {
      return true;
    }
  }

  return false;
}

function isDoNotRepeatSegment(segment: string): boolean {
  return /不要再|别再|不要重复|别重复|不要重试|别重试|do not repeat|don't repeat/i.test(segment);
}

function isDoNotForgetSegment(segment: string): boolean {
  return /记住|别忘|不要忘|注意|remember|do not forget/i.test(segment);
}

function isDoNotViolateSegment(segment: string): boolean {
  return /不要|别|必须|只能|勿|如非必要|未经确认不要|without confirmation/i.test(segment);
}

function splitSegments(text: string): string[] {
  return text
    .split(/[\n。！？!?；;]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(-8);
}

function appendGuard(list: string[], value: string): string[] {
  return dedupe([...list, value]).slice(-MAX_GUARDS_PER_BUCKET);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function dedupeStrings(value: unknown): string[] {
  return Array.isArray(value) ? dedupe(value.filter((item): item is string => typeof item === 'string')) : [];
}

function stableArgs(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PersistedSessionSnapshot } from './store';
import type { AgentDefinition, AgentRuntimeLogger } from './types';

interface AgentStoreDocument {
  version: 1;
  savedAt: string;
  agents: AgentDefinition[];
}

interface SessionStoreDocument {
  version: 1;
  savedAt: string;
  sessions: PersistedSessionSnapshot[];
}

export interface AgentFileStoreOptions {
  storageDir: string;
  logger?: AgentRuntimeLogger;
}

export class AgentFileStore {
  readonly type = 'filesystem' as const;
  readonly storageDir: string;
  private readonly agentsFilePath: string;
  private readonly sessionsFilePath: string;
  private readonly logger?: AgentRuntimeLogger;

  constructor(options: AgentFileStoreOptions) {
    this.storageDir = resolve(options.storageDir);
    this.logger = options.logger;
    this.agentsFilePath = join(this.storageDir, 'agents.json');
    this.sessionsFilePath = join(this.storageDir, 'sessions.json');
    ensureDirectory(this.storageDir);
  }

  async loadAgents(): Promise<AgentDefinition[]> {
    const payload = readJsonFile(this.agentsFilePath);
    if (!payload) {
      return [];
    }

    if (Array.isArray(payload)) {
      return payload as AgentDefinition[];
    }

    if (isObject(payload) && Array.isArray(payload.agents)) {
      return payload.agents as AgentDefinition[];
    }

    this.logger?.warn?.(
      {
        filePath: this.agentsFilePath
      },
      'Invalid agent store format. Ignore existing content.'
    );
    return [];
  }

  async loadSessions(): Promise<PersistedSessionSnapshot[]> {
    const payload = readJsonFile(this.sessionsFilePath);
    if (!payload) {
      return [];
    }

    if (Array.isArray(payload)) {
      return payload as PersistedSessionSnapshot[];
    }

    if (isObject(payload) && Array.isArray(payload.sessions)) {
      return payload.sessions as PersistedSessionSnapshot[];
    }

    this.logger?.warn?.(
      {
        filePath: this.sessionsFilePath
      },
      'Invalid session store format. Ignore existing content.'
    );
    return [];
  }

  async saveAgents(agents: AgentDefinition[]): Promise<void> {
    const document: AgentStoreDocument = {
      version: 1,
      savedAt: new Date().toISOString(),
      agents
    };
    writeJsonFile(this.agentsFilePath, document);
  }

  async saveSessions(sessions: PersistedSessionSnapshot[]): Promise<void> {
    const document: SessionStoreDocument = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessions
    };
    writeJsonFile(this.sessionsFilePath, document);
  }
}

function ensureDirectory(dirPath: string) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return undefined;
    }

    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, payload: unknown) {
  const parentDir = dirname(filePath);
  ensureDirectory(parentDir);

  const tempPath = `${filePath}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(tempPath, content, 'utf8');
  renameSync(tempPath, filePath);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

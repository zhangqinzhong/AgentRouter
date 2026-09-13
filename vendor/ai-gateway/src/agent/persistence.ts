import type { AgentStorageConfig } from '../types';
import { AgentFileStore } from './file-store';
import type { PersistedSessionSnapshot } from './store';
import type { AgentDefinition, AgentRuntimeLogger } from './types';

export interface AgentPersistenceStore {
  readonly type: AgentStorageConfig['type'];
  loadAgents(): Promise<AgentDefinition[]>;
  loadSessions(): Promise<PersistedSessionSnapshot[]>;
  saveAgents(agents: AgentDefinition[]): Promise<void>;
  saveSessions(sessions: PersistedSessionSnapshot[]): Promise<void>;
  close?(): Promise<void>;
}

export async function createAgentPersistenceStore(
  storage: AgentStorageConfig,
  logger?: AgentRuntimeLogger
): Promise<AgentPersistenceStore> {
  if (storage.type === 'memory') {
    return new AgentMemoryStore();
  }

  if (storage.type === 'filesystem') {
    return new AgentFileStore({
      storageDir: storage.dir,
      logger
    });
  }

  throw new Error(`Unsupported storage type: ${(storage as any).type}`);
}

class AgentMemoryStore implements AgentPersistenceStore {
  readonly type = 'memory' as const;

  async loadAgents(): Promise<AgentDefinition[]> {
    return [];
  }

  async loadSessions(): Promise<PersistedSessionSnapshot[]> {
    return [];
  }

  async saveAgents(_agents: AgentDefinition[]): Promise<void> {
    return;
  }

  async saveSessions(_sessions: PersistedSessionSnapshot[]): Promise<void> {
    return;
  }
}

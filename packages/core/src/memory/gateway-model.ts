import { randomBytes } from "node:crypto";
import { loadAppConfig } from "@agentrouter/core/config/config";
import { loadPersistedApiKeys, updatePersistedApiKeys } from "@agentrouter/core/config/config-repository";
import { availableGatewayModelIds, type ApiKeyConfig } from "@agentrouter/core/contracts/app";
import { gatewayService } from "@agentrouter/core/gateway/service";

export const MEMORY_GATEWAY_API_KEY_ID = "ai-memory";
export const MEMORY_GATEWAY_API_KEY_NAME = "AI Memory";

/** Gateway access used by memory model tasks; injectable so tests never touch the operator's configuration. */
export type MemoryGatewayAccess = {
  models(): Promise<string[]>;
  baseUrl(): Promise<string>;
  /** Returns the dedicated key, creating it when absent. */
  ensureApiKey(): Promise<string>;
  /** Returns the current dedicated key without creating one, so a deleted key stays revoked. */
  currentApiKey(): Promise<string | undefined>;
};

export const agentRouterGatewayAccess: MemoryGatewayAccess = {
  async models() {
    return availableGatewayModelIds(await loadAppConfig());
  },
  async baseUrl() {
    // The memory service runs on this machine; a wildcard HOST is not a dialable address.
    return `http://127.0.0.1:${(await loadAppConfig()).PORT}/v1`;
  },
  async ensureApiKey() {
    let key = "";
    let createdNow = false;
    await updatePersistedApiKeys((current) => {
      const existing = current.find((item) => item.id === MEMORY_GATEWAY_API_KEY_ID);
      if (existing?.key) { key = existing.key; return current; }
      createdNow = true;
      key = `ar-memory-${randomBytes(24).toString("base64url")}`;
      const created: ApiKeyConfig = { id: MEMORY_GATEWAY_API_KEY_ID, name: MEMORY_GATEWAY_API_KEY_NAME, key, createdAt: new Date().toISOString() };
      return [...current.filter((item) => item.id !== MEMORY_GATEWAY_API_KEY_ID), created];
    });
    // The running gateway authenticates against its loaded key set; reload it like saving keys in the UI does.
    if (createdNow) await gatewayService.updateConfig(await loadAppConfig());
    return key;
  },
  async currentApiKey() {
    return (await loadPersistedApiKeys()).find((item) => item.id === MEMORY_GATEWAY_API_KEY_ID)?.key || undefined;
  }
};

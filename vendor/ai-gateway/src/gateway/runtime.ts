import { createBuiltinSourceAdapters } from '../adapters/builtins/source';
import { createBuiltinTargetAdapters } from '../adapters/builtins/target';
import { ProviderPluginRegistry, SourceAdapterRegistry, TargetAdapterRegistry } from '../adapters/registry';
import type { AgentToolProvider } from '../agent/tools';
import { syncProviderPluginsFromConfig } from '../provider/plugins';
import type { GatewayConfig } from '../types';

export interface GatewayRuntime {
  sourceAdapters: SourceAdapterRegistry;
  targetAdapters: TargetAdapterRegistry;
  providerPlugins: ProviderPluginRegistry;
  toolProvider?: AgentToolProvider;
}

export function createGatewayRuntime(
  config?: GatewayConfig,
  toolProvider?: AgentToolProvider
): GatewayRuntime {
  const sourceAdapters = new SourceAdapterRegistry();
  const targetAdapters = new TargetAdapterRegistry();
  const providerPlugins = new ProviderPluginRegistry();

  for (const adapter of createBuiltinSourceAdapters()) {
    sourceAdapters.register(adapter);
  }

  for (const adapter of createBuiltinTargetAdapters()) {
    targetAdapters.register(adapter);
  }

  if (config) {
    syncProviderPluginsFromConfig(providerPlugins, config);
  }

  return {
    sourceAdapters,
    targetAdapters,
    providerPlugins,
    toolProvider
  };
}

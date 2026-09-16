import { queryLocalCollector } from "@agentrouter/core/collector/service";

// TokenTracker's local aggregate contract is shared by every native module.
// Gateway request accounting remains independent in usageStore.
export async function nativeMenuData(path: string, query: Record<string,string>): Promise<unknown> {
  if (path.endsWith("user-status")) return {ok:true};
  return queryLocalCollector(path,query);
}

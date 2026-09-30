import type { GatewayProviderConfig, ProviderAccountMeter, ProviderAccountSnapshot } from '../contracts/app';
import { queryLocalCollector } from '../collector/service';

const brands: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', grokbot: 'Grok Bot', grok: 'Grok Build', copilot: 'GitHub Copilot', zcode: 'ZCode', kimi: 'Kimi', gemini: 'Gemini', kiro: 'Kiro', antigravity: 'Antigravity', opencodeGo: 'OpenCode Go', commandCode: 'CommandCode', qoder: 'Qoder', qoderCn: 'Qoder CN', codingPlan: 'Ark Coding Plan', agentPlan: 'Ark Agent Plan' };
const labels: Record<string, string[]> = {
  grokbot: ['Weekly'], codex: ['Primary quota', 'Secondary quota'], cursor: ['Plan', 'Auto', 'API', 'Grok bot'],
  copilot: ['Premium', 'Chat'], zcode: ['GLM-5.2', 'GLM-5-Turbo'], gemini: ['Pro', 'Flash', 'Lite'],
  kimi: ['Weekly', '5h', 'Total'], kiro: ['Monthly', 'Bonus'],
  opencodeGo: ['5h', 'Weekly', 'Monthly'], commandCode: ['5h', 'Weekly'],
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
function timestamp(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function quotaMeter(id: string, label: string, raw: unknown): ProviderAccountMeter | undefined {
  const w = record(raw); const used = w.used_percent ?? w.utilization;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  return { id, label: typeof w.display_label === 'string' ? w.display_label : label, kind: 'quota', unit: '%', limit: 100, used, remaining: Math.max(0, 100 - used), resetAt: timestamp(w.reset_at ?? w.resets_at), source: 'standard' };
}
export function localQuotaSnapshots(raw: unknown): ProviderAccountSnapshot[] {
  const data = { ...record(raw) };
  const cursor = record(data.cursor);
  if (cursor.quaternary_window && !data.grokbot) data.grokbot = { configured: true, primary_window: cursor.quaternary_window, plan_label: cursor.grok_bot_plan_label, cached_at: cursor.grok_bot_updated_at ?? record(cursor.provenance).captured_at };
  const result: ProviderAccountSnapshot[] = [];
  for (const [key, brand] of Object.entries(brands)) {
    const p = record(data[key]); if (p.configured !== true) continue;
    let names = labels[key] || ['Primary quota', 'Secondary quota', 'Additional quota', 'Additional quota'];
    if (key === 'grok') names = [p.period_type === 'weekly' ? 'Weekly' : p.period_type === 'daily' ? 'Daily' : 'Monthly', 'On-demand'];
    if (key === 'zcode' && p.plan_kind === 'coding-plan') names = ['5h', 'Weekly', 'Tools'];
    const meters = ['primary_window', 'secondary_window', 'tertiary_window', 'quaternary_window', 'spark_primary_window', 'spark_secondary_window', 'credit_window']
      .map((id, i) => quotaMeter(id, names[i] || (id.startsWith('spark') ? 'Spark' : 'Credits'), key === 'cursor' && id === 'quaternary_window' ? undefined : p[id])).filter((m): m is ProviderAccountMeter => !!m);
    for (const [id, label] of [['five_hour','5h'],['seven_day','Weekly'],['seven_day_opus','Opus']] as const) {
      const meter = quotaMeter(id,label,p[id]); if(meter) meters.push(meter);
    }
    for (const [i,w] of (Array.isArray(p.weekly_scoped) ? p.weekly_scoped : []).entries()) {
      const meter = quotaMeter(`weekly_${i}`, String(record(w).label || 'Weekly'), w); if(meter) meters.push(meter);
    }
    const resets = record(p.reset_credits);
    if (typeof resets.available_count === 'number') meters.push({ id:'manual_reset_remaining',label:'Manual resets',kind:'requests',unit:'requests',remaining:resets.available_count,
      details:(Array.isArray(resets.credits)?resets.credits:[]).map((c,i)=>({id:String(i),label:`Reset ${i+1}`,effectiveAt:timestamp(record(c).granted_at),expiresAt:timestamp(record(c).expires_at),status:String(record(c).status || '')})) });
    if (!meters.length && !p.error) continue;
    const remaining = meters.filter(m=>m.unit==='%').map(m=>m.remaining ?? 100);
    result.push({ provider: brand, displayName: p.plan_label ? `${brand}${key === "grokbot" ? " ·" : ""} ${p.plan_label}` : brand, localSource:key,
      credentialId:'local-subscription', source:'standard', meters,
      status:p.error || p.stale ? 'error' : remaining.some(n=>n<=10) ? 'critical' : remaining.some(n=>n<=25) ? 'warning' : 'ok',
      message:typeof p.error==='string'?p.error:p.stale?'Showing saved quota.':undefined,
      updatedAt: timestamp(p.cached_at ?? record(p.provenance).captured_at ?? data.fetched_at) || new Date().toISOString() });
  }
  return result;
}

// Only the local-login sentinel at the official Codex endpoint proves this is
// the same login. Never deduplicate paid keys or other accounts by display name.
export function mergeAccountSnapshots(providers: GatewayProviderConfig[], gateway: ProviderAccountSnapshot[], local: ProviderAccountSnapshot[]) {
  return [...gateway, ...local.filter(account => !(account.localSource === 'codex' && providers.some(provider =>
    (provider.api_key || provider.apiKey) === 'ar-local-agent-login' &&
    /^https:\/\/chatgpt\.com\/backend-api\/codex\/?$/.test(provider.api_base_url || provider.baseUrl || '') &&
    gateway.some(s => s.provider === provider.name && s.meters.length > 0 && !s.credentialId)
  )))];
}
let lastSnapshots: ProviderAccountSnapshot[] = [];
export async function getLocalAccountSnapshots(source?: string, forceRefresh = false): Promise<ProviderAccountSnapshot[]> {
  if (source && !brands[source]) throw new Error('Unknown local account');
  try {
    const data = await queryLocalCollector('/functions/tokentracker-usage-limits', { ...(source ? {provider:source}:{}), ...(forceRefresh ? {refresh:'1'}:{}) });
    const next = localQuotaSnapshots(data).map(row => {
      const previous = lastSnapshots.find(s=>s.localSource===row.localSource);
      return row.status==='error' && !row.meters.length && previous ? {...row, meters:previous.meters,updatedAt:previous.updatedAt} : row;
    });
    lastSnapshots = source ? [...lastSnapshots.filter(s=>s.localSource!==source),...next] : next;
    return next;
  } catch (error) {
    const saved = lastSnapshots.filter(s=>!source || s.localSource===source);
    if (!saved.length) throw error;
    return saved.map(s=>({...s,status:'error',message:'Quota refresh failed. Showing saved data.'}));
  }
}

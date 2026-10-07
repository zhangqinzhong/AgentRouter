import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { MemoryModelStatus, MemoryRequest } from "@agentrouter/core/contracts/memory";
import { useAppText } from "../shared/i18n";
async function call<T>(request: MemoryRequest): Promise<T> { if (!window.agentrouter?.memory) throw new Error("Memory service is unavailable."); return await window.agentrouter.memory(request) as T; }
export function MemoryModelSettingsPanel({ running }: { running: boolean }) {
  const t = useAppText();
  const [value, setValue] = useState<MemoryModelStatus>();
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { void call<MemoryModelStatus>({ action: "modelConfig" }).then(setValue).catch((e) => setError(String(e))); }, []);
  function update(change: Partial<MemoryModelStatus>) { setValue((old) => old && ({ ...old, ...change })); setDirty(true); setNotice(""); }
  async function save() {
    if (!value || !window.confirm(t("Save memory model settings? Enabled model tasks send captured project content to this API and may incur charges. Changes take effect on next start."))) return;
    setBusy(true); setError("");
    try { setValue(await call<MemoryModelStatus>({ action: "saveModelConfig", settings: value, apiKey: clearKey ? "" : key || undefined, confirmed: true })); setKey(""); setClearKey(false); setDirty(false); setNotice(t("Configuration saved. Changes take effect on next start.")); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function test() {
    if (!window.confirm(t("Send a small structured test request to the saved model? This may incur a model charge."))) return;
    setBusy(true); setError(""); setNotice("");
    try { await call({ action: "testModel", confirmed: true }); setNotice(t("Model connection and structured response verified.")); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-border/70 p-4">
    <h2 className="text-sm font-semibold">{t("Memory organization")}</h2>
    <p className="text-xs text-muted-foreground">{t("Capture and session pages work without a model. Model review extracts reusable knowledge; scheduled cleanup and checks run locally.")}</p>
    {value && <>
      {!value.configured && <p className="text-xs text-muted-foreground">{t("No model override saved. Advanced TOML settings remain in effect.")}</p>}
      {running && <p className="text-xs text-muted-foreground">{t("Stop memory before editing model settings.")}</p>}
      <fieldset disabled={running || busy} className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.enabled} onCheckedChange={(enabled) => update({ enabled })} />{t("Use a model to organize memory")}</label>
        <div className="grid gap-3 sm:grid-cols-2">{(["baseUrl", "model"] as const).map((field) => <label key={field} className="text-xs text-muted-foreground">{t(field === "baseUrl" ? "OpenAI-compatible API URL" : "Model name")}<input className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]" value={value[field]} onChange={(e) => update({ [field]: e.target.value })} placeholder={field === "baseUrl" ? "http://127.0.0.1:11434/v1" : ""} /></label>)}</div>
        <label className="block text-xs text-muted-foreground">API Key<input type="password" autoComplete="new-password" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]" value={key} placeholder={t(value.hasApiKey ? "Saved; leave blank to keep for the same API URL" : "Optional for local models")} onChange={(e) => { setKey(e.target.value); setClearKey(false); setDirty(true); }} /></label>
        {value.hasApiKey && <label className="flex items-center gap-2 text-xs"><Checkbox checked={clearKey} onCheckedChange={(checked) => { setClearKey(checked); setDirty(true); }} />{t("Clear saved API key")}</label>}
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.consolidateOnEnd} onCheckedChange={(consolidateOnEnd) => update({ consolidateOnEnd })} />{t("Organize each completed session")}</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.autoReview} onCheckedChange={(autoReview) => update({ autoReview })} />{t("Review completed sessions in the background")}</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.requireApproval} onCheckedChange={(requireApproval) => update({ requireApproval })} />{t("Require approval before applying proposed edits")}</label>
        <Button size="sm" disabled={!dirty || busy} variant="outline" onClick={() => void save()}>{t("Save model settings")}</Button>
      </fieldset>
      <Button size="sm" variant="ghost" disabled={busy || dirty || !value.configured || !value.enabled} onClick={() => void test()}>{t("Test saved model")}</Button>
      <p className="text-xs text-muted-foreground">{t("Review cadence and thresholds follow advanced configuration. Review proposals in Advanced maintenance. These model settings override the corresponding TOML fields.")}</p>
    </>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
  </section>;
}

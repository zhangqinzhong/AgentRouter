"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { resolveKimiDefaultModel } = require("./rollout");
const { mergePerformance } = require("./session-performance");

function readObject(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function kimiSessionLocation(file) {
  const official = path.basename(path.dirname(path.dirname(file))) === "agents";
  const directory = official ? path.dirname(path.dirname(path.dirname(file))) : path.dirname(file);
  const id = path.basename(directory);
  const imported = official ? readObject(path.join(directory, "state.json"))?.custom : null;
  // The official migrator keeps the legacy UUID under ses_<UUID>. Group its
  // message-only mirror with the original wire, retaining any new usage tail.
  const identity = imported?.imported_from_kimi_cli && typeof imported.kimi_cli_session_id === "string"
    ? imported.kimi_cli_session_id : id.replace(/^(?:ses_|session_)(?=[0-9a-f-]{36}$)/i, "");
  // Official layout: <root>/sessions/<id>/agents/main/wire.jsonl.
  // Legacy layout adds a workspace-hash directory under sessions/.
  const root = official ? path.dirname(path.dirname(directory)) : path.dirname(path.dirname(path.dirname(directory)));
  return { directory, root, id, identity, official, main: !official || path.basename(path.dirname(file)) === "main" };
}

function kimiSessionDependencies(files) {
  return [...new Set(files.flatMap((file) => {
    const location = kimiSessionLocation(file);
    const root = location.root;
    return [path.join(location.directory, "state.json"), path.join(root, "config.toml"), path.join(root, "kimi.json")];
  }))];
}

function discoverKimiWireFiles(roots, incomplete) {
  const files = new Set();
  function walk(directory, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error.code !== "ENOENT") incomplete.push({ path: directory, error: error.code || "unreadable" });
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name === "wire.jsonl") files.add(file);
    }
  }
  for (const root of roots) walk(path.join(root, "sessions"));
  return [...files].sort();
}

const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
function kimiUsage(usage, legacy) {
  if (!usage || typeof usage !== "object") return null;
  let input, cached, created, output;
  // Same column semantics as parseKimiIncremental / parseKimiCodeIncremental.
  if (legacy || usage.inputOther != null) {
    input = count(legacy ? usage.input_other : usage.inputOther);
    cached = count(legacy ? usage.input_cache_read : usage.inputCacheRead);
    created = count(legacy ? usage.input_cache_creation : usage.inputCacheCreation);
    output = count(usage.output);
  } else {
    created = count(usage.cache_creation_input_tokens);
    cached = count(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens);
    input = Math.max(0, count(usage.input_tokens) - (usage.cache_read_input_tokens != null ? 0 : cached));
    output = count(usage.output_tokens);
  }
  return { input_tokens: input, cached_input_tokens: cached, cache_creation_input_tokens: created,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + cached + created + output };
}

const modelAlias = (value) => typeof value === "string" && value.trim() ? value.trim().split("/").pop() : null;
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "strreplacefile", "writefile", "apply_patch"]);
const AGENT_TOOLS = new Set(["agent", "agentswarm", "task"]);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Reads both wire protocols into metadata only. A full inventory shares its
// usage-ID set, as sync does, so copied/forked step records count only once.
async function readKimiSessions(files) {
  const groups = new Map();
  for (const file of [...new Set(files)]) {
    const location = kimiSessionLocation(file);
    const group = groups.get(location.identity) || { identity: location.identity, files: [], createdAt: Infinity };
    const state = location.official ? readObject(path.join(location.directory, "state.json")) : {};
    group.createdAt = Math.min(group.createdAt, Number(state.createdAt) || Infinity);
    group.files.push({ file, ...location, state });
    groups.set(location.identity, group);
  }
  const seenUsage = new Set();
  const seenSignals = new Set();
  const rows = [];
  for (const group of [...groups.values()].sort((a, b) => a.createdAt - b.createdAt || a.identity.localeCompare(b.identity))) {
    const tokens = kimiUsage({}, true);
    const modelUsage = new Map();
    const buckets = new Map();
    const times = new Set();
    let turns = 0, edits = 0, retries = 0, agents = 0, errors = 0;
    let lastPrompt = null;
    let cwd = null;
    let resumeId = null;
    const modelsForEdits = new Map();
    // Legacy first preserves migrated user turns; context.append_message in
    // the imported wire is history, never another prompt or usage event.
    group.files.sort((a, b) => Number(a.official) - Number(b.official) || Number(b.main) - Number(a.main) || a.file.localeCompare(b.file));
    for (const location of group.files) {
      const root = location.root;
      let model = resolveKimiDefaultModel({ KIMI_HOME: root });
      if (location.official && location.main) {
        resumeId = location.id;
        if (typeof location.state.workDir === "string") cwd = location.state.workDir;
      }
      if (!location.official && !cwd) {
        const workspaceHash = path.basename(path.dirname(location.directory));
        const workDirs = readObject(path.join(root, "kimi.json"))?.work_dirs;
        const workspace = Array.isArray(workDirs) && workDirs.find((row) => typeof row?.path === "string"
          && crypto.createHash("md5").update(row.path).digest("hex") === workspaceHash);
        if (workspace) cwd = workspace.path;
      }
      let turnOpen = false, hadEdit = false, turnModel = model;
      const closeTurn = () => {
        if (hadEdit) { edits++; modelsForEdits.set(turnModel, (modelsForEdits.get(turnModel) || 0) + 1); }
        hadEdit = false; turnOpen = false;
      };
      const input = fs.createReadStream(location.file);
      for await (const { line, terminated } of physicalJsonlRecords(input)) {
        if (!terminated || !line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== "object") continue;
        const message = entry.message && typeof entry.message === "object" ? entry.message : null;
        const event = entry.type === "context.append_loop_event" ? entry.event : entry;
        const timestampMs = Number(location.official ? entry.time ?? event?.time : entry.timestamp ?? message?.payload?.timestamp) * (location.official ? 1 : 1000);
        const timestamp = Number.isFinite(timestampMs) && timestampMs > 0 && timestampMs <= 8640000000000000
          ? new Date(timestampMs).toISOString() : null;
        if (timestamp) times.add(timestampMs);
        if (["config.update", "profile.bind", "llm.request"].includes(entry.type)) {
          model = modelAlias(entry.modelAlias || entry.model) || model;
          if (location.main && typeof (entry.cwd || entry.environmentDisclosure?.cwd) === "string") cwd = entry.cwd || entry.environmentDisclosure.cwd;
        }
        const isLegacyUsage = message?.type === "StatusUpdate";
        const usage = isLegacyUsage ? message.payload?.token_usage : event?.type === "step.end" ? event.usage : null;
        const usageId = isLegacyUsage ? message.payload?.message_id : event?.uuid;
        if (usage && typeof usageId === "string" && timestamp) {
          const ids = [isLegacyUsage ? `message:${usageId}` : `step:${usageId}`];
          if (!isLegacyUsage && typeof event.messageId === "string") ids.push(`message:${event.messageId}`);
          const delta = kimiUsage(usage, isLegacyUsage);
          if (delta.total_tokens > 0 && !ids.some((id) => seenUsage.has(id))) {
            for (const id of ids) seenUsage.add(id);
            const modelRow = modelUsage.get(model) || { model, ...kimiUsage({}, true), usage_events: 0 };
            const bucketTime = new Date(Math.floor(timestampMs / 60000) * 60000).toISOString();
            const key = `${model}\0${bucketTime}`;
            const bucket = buckets.get(key) || { model, timestamp: bucketTime, ...kimiUsage({}, true), usage_events: 0 };
            for (const field of Object.keys(delta)) { tokens[field] += delta[field]; modelRow[field] += delta[field]; bucket[field] += delta[field]; }
            modelRow.usage_events++; bucket.usage_events++;
            const streamMs = count(event.llmStreamDurationMs);
            const firstMs = Number(event.llmFirstTokenLatencyMs);
            const performance = {
              ...(delta.output_tokens >= 200 && streamMs >= 1000 && streamMs <= 3600000
                ? { estimated_output_tokens: delta.output_tokens, estimated_duration_ms: streamMs, estimated_request_count: 1 } : {}),
              ...(event.llmFirstTokenLatencyMs != null && Number.isFinite(firstMs) && firstMs >= 0
                ? { first_response_total_ms: firstMs, first_response_sample_count: 1 } : {}),
            };
            modelRow.performance = mergePerformance(modelRow.performance, performance);
            modelUsage.set(model, modelRow); buckets.set(key, bucket);
            turnModel = model;
          }
        }
        if (!location.main) continue;
        const signalId = hash(line);
        if (seenSignals.has(signalId)) continue;
        seenSignals.add(signalId);
        const prompt = message?.type === "TurnBegin" ? message.payload?.user_input
          : entry.type === "turn.prompt" && (!entry.origin?.kind || entry.origin.kind === "user") ? entry.input : null;
        if (prompt != null) {
          closeTurn(); turns++; turnOpen = true; turnModel = model;
          // Fingerprints live only for this scan; no text or hash is persisted.
          const fingerprint = hash(JSON.stringify(prompt));
          if (lastPrompt && fingerprint === lastPrompt) retries++;
          lastPrompt = fingerprint;
        }
        const tool = message?.type === "ToolCall" ? message.payload?.function?.name : event?.type === "tool.call" ? event.name : null;
        if (typeof tool === "string") {
          const name = tool.toLowerCase();
          if (turnOpen && EDIT_TOOLS.has(name)) hadEdit = true;
          if (AGENT_TOOLS.has(name)) agents++;
        }
        if (entry.type === "turn.step.retrying" || message?.type === "StepInterrupted") errors++;
        if (message?.type === "TurnEnd" || entry.type === "turn.ended") closeTurn();
      }
      closeTurn();
    }
    const orderedTimes = [...times].sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < orderedTimes.length; i++) {
      const gap = orderedTimes[i] - orderedTimes[i - 1];
      if (gap <= 30 * 60 * 1000) activeMs += gap;
    }
    const models = [...modelUsage.values()].map((row) => ({ ...row, edit_turns: modelsForEdits.get(row.model) || 0 }));
    if (!tokens.total_tokens && !turns) continue;
    rows.push({ identity: group.identity, files: group.files.map((row) => row.file), session_id: resumeId,
      title: null, project_ref: cwd, model: models.length === 1 ? models[0].model : "unknown", model_usage: models,
      usage_buckets: [...buckets.values()], tokens, turns, edit_turns: edits, retry_turns: retries,
      subagent_calls: agents, subagent_types: {}, error_count: errors,
      usage_events: models.reduce((sum, row) => sum + row.usage_events, 0),
      started_at: orderedTimes.length ? new Date(orderedTimes[0]).toISOString() : null,
      ended_at: orderedTimes.length ? new Date(orderedTimes.at(-1)).toISOString() : null, active_ms: activeMs,
      performance: mergePerformance(...models.map((row) => row.performance)),
      provenance: { source: "local-session-log", confidence: "observed", retry_confidence: "inferred", content_retained: false, usage: "kimi-wire-metadata" },
    });
  }
  return rows;
}

module.exports = { discoverKimiWireFiles, kimiSessionDependencies, readKimiSessions };

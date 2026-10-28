# TokenTracker collectors

Local parsers, quota readers, subscription records and pricing are adapted from
TokenTracker (MIT), revision `7f3d9bc4482868364a874a4d882fc143fbb1cb51`.
The original file hashes are in `upstream-files.json`.

`collector.cjs` is AgentRouter's local coordinator. It scans Claude and Codex
session files, including managed profile directories, in a worker. It also reads
OpenClaw, Grok, LM Studio, Gemini, OpenCode, Mimo, ZCode and Kilo CLI local stores
through their original parsers. It keeps
incremental cursors and compacted aggregate buckets under
`~/.agentrouter/collector`. Gateway request statistics remain separate.

`lib/offline-api.js` contains the original local aggregation helpers and native
statistics routes extracted from `local-api.js`, including hourly, daily, monthly,
heatmap and session browser endpoints. Cloud endpoints, CLI initialization, hook
installation and telemetry are not included. Pricing uses TokenTracker's loader
and local cache; provider requests use AgentRouter's network transport. The quota
observer does not rotate Codex refresh tokens. Existing TokenTracker subscription
dates are read as manually maintained data. Session analytics sidecars stay under
`~/.agentrouter/collector`.

`context.cjs` hosts Claude, Codex and Grok breakdowns. Claude and Codex include
managed profile roots; Claude ranges use the selected time zone. Categorizer
cache files stay under AgentRouter with private permissions and a 16-file bound.

Codex compaction accounting is additionally backported from upstream commit
`39b4a915` (token_usage_record, rollout and session parsers), with its regression
tests. AgentRouter retains its model-attribution rules; priority-tier pricing is
not part of this backport. Collector schema 4 rebuilds Codex aggregates and
preserves response-ID deduplication; session sidecar schema 15 invalidates old
cached summaries. Unlike upstream's dated cold-scan inventory, this coordinator
lists all managed/default rollout files on each scan, including older sessions.
Overview usage now reads the same local source scope as the usage page; gateway
metrics remain separate internally for system status and request diagnostics.

Pricing overrides refreshed from upstream v1.4.12 (2026-10-26):
`lib/pricing/curated-overrides.json` only; the seed snapshot and the
LiteLLM fetcher were already identical and stay untouched.

Session layer re-synced to upstream v1.4.12 (2026-10-26):
`session-analytics.js` and `rollout.js` now carry the upstream v27 sidecar,
including OpenCode/Kimi/OMP sources and the incomplete-inventory guard.
Re-applied AgentRouter adaptations: `ar_profile` tagging, profile roots from
`local-sources.profileHomes`, the `~/.agentrouter/collector` queue path, the
`getSessionTranscript` bridge, and the MiMo native-database session source
(`readMimoDbMessages`, mimo only — ZCode now comes from the upstream source).

Session-layer dependencies synced with the v1.4.12 resync (2026-10-26):
`codex-rollout-parser.js` (compaction onUsage, long-context priced delta),
`jsonl-lines.js` (per-record cap + oversized flag), `codex-service-tier.js`
(new), and `offline-api.js` (timezone passthrough). Without these the new
session layer produced buckets the usage queue disagreed with.

October 2026 targeted backports (base import remains unchanged):
- `987f5ec3`: ZCode sessions from `~/.zcode/cli/db/db.sqlite`. The db is rescanned
  per stat instead of cached per row, because one db yields many rows; the WSL
  branch of the upstream resolver is omitted until `wsl-probe` exposes
  `shouldProbeWsl`/`pickWin32Path`.

- `9cffe8e1`: Claude user-message identity follows fork lineage, including legacy count repair.
- `4c27f7b7`, `5b01653a`, `07f0e0e3`: OpenCode fingerprint owner correctness only;
  AgentRouter retains its own JSON cursor coordinator, without upstream cursor shards.
- `8d27a2db`: Grok billing fallback only when the unified billing period is absent.
- `d9b30009`, `8318160f`: Kimi official regional credentials/endpoints and fixed credential filenames.
- `dbcb0bfa`: prefer account-matched Claude Code usage cache. Retains AgentRouter's
  existing reset-boundary guard; does not import the upstream reset-notification state file.
- `fdd7d60b`: stat Codex rollouts whose name-date is within 30 days and re-read any
  that grew past the cursor. Older files still wait for the daily audit. Priority-tier
  Fast pricing stays out.
- `d7c7da40`: GPT-6.1 Sol standard rates, including the observed long-context premium.
- `49584cc9`: Cursor prices for Composer 2.5, Gemini 4 Argon, and Grok 4.6/4.7.
- `f13b084b`: Antigravity turns with sqlite usage metadata bill cached input, text
  output, and reasoning tokens. Turns without that metadata stay on the text estimate.
  Already-counted history is left in place.

Adapted regression fixtures live in `tests/collector/upstream`. Kimi's TOML parser
uses smol-toml 1.6.0 (MIT), bundled into the copied Kimi module at build time with
its license, including in desktop and CLI outputs.

- 2026-10-09: ported TokenTracker `5d4384db` session performance and pricing
  provenance, plus its session detail drawer and formatting helpers in the UI
  vendor directory. AgentRouter keeps its session list, extra client sources,
  managed-profile resume actions and date filters. Sidecar version is 16 here
  (upstream 14) to invalidate AgentRouter's existing version-15 records.

October 20, 2026 targeted backports:
- `750809bf35ceca9346eed6765db2c16485fa8e54`: Codex Zstandard rollouts,
  compressed snapshot cursors, archive/live transcript grouping. Adapted to
  AgentRouter's existing model-attribution state (no service-tier schema change).
- `1a7e14a364990796f082f9ba8d3bcc7fd00ca72d`: Grok shared-pool product
  attribution and duplicate Cursor pool suppression. Product shares are shown
  as consumed shares, never as separate remaining quotas.
- `6b96ca64f917231d27c86dd056ee6fd531cc5526`: OpenCode `-free` pricing.
- Reviewed `656367e6a5eb519e98594023a15c44c611bbe19a` (ZCode prune-window
  migrations): AgentRouter does not use upstream's `commands/sync.js` wipe/
  rebuild migration path. Its native DB parser and persisted aggregate queue
  retain collected history; no destructive upstream migration was imported.

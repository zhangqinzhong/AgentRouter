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

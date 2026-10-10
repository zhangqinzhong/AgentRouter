# October upstream correctness backports

Base: AgentRouter 1.9.10. This change does not update the app version, publish a
release, alter the running gateway, or replace the installed application.

## Claude Code Router

Source: https://github.com/musistudio/claude-code-router/releases/tag/v3.1.3

| Commit | Imported behavior |
| --- | --- |
| `f070c944` | Propagate resets through Codex apply-patch and multi-agent streams; destroy the client response after an upstream stream error. The live-rate transform already used pipeline locally. |
| `23bf3265` | Preserve gateway response headers when raw traces refine request logs. |
| `b6f4d6a9` | Add Codex session_id and prompt cache affinity using bounded, sanitized session identity; preserve supplied values. |
| `ded1a9a4`, `c3bb3636` | Preserve protocol selection for provider aliases and disambiguate bare model IDs by request protocol. |
| `f15f781b` | Bound OpenRouter provider-catalog requests with a timeout. |
| `6a38bf46` | Preserve custom provider base paths ending in /models. |

Namespaces and tests use AgentRouter identifiers. Existing stream and error-body
patches remain enabled. No gateway dependency replacement is included.

## TokenTracker

Source: https://github.com/xiufengsun/TokenTracker/releases/tag/v1.2.2

Imported Claude fork conversation-count repair, OpenCode fingerprint-owner
correctness, Grok unified/legacy billing fallback, Kimi regional credential
isolation, and account-matched Claude Code usage-cache reads. Exact commits and
adaptations are recorded in the collector NOTICE.md.

Kept the local JSON cursor coordinator, Grok Bot attribution, calendar/rolling
range behavior, quota colors, heatmap, and existing UI. Did not import cursor
sharding, cloud sync, desktop pets, session-page redesign, or model-catalog CDN
updates. Upstream shard-only test cases are not applicable to this coordinator;
flat-cursor owner order and serialized repeated sync are tested instead.

## Validation

- Collector: 84 passed, including adapted upstream regressions.
- Core: 1,149 passed, six platform/optional tests skipped, no failures.
- Architecture: seven passed. Gateway dependency stream tests: ten passed.
- Typecheck and production assets build passed; rebuilt main outputs after adding
  standalone TOML bundling. The copied Kimi module executes from an isolated
  temporary directory with no workspace node_modules.
- Stream reset tests use real loopback HTTP sockets, including SSE/JSON resets
  and client-response termination. Tests use temporary data and mocked quota
  endpoints; no live customer credentials or provider billing calls are needed.

## Session details and measured collector cost

Ported TokenTracker `5d4384db` request timing estimates, Claude model breakdown,
pricing provenance (priced/free/unpriced), and a session detail drawer. Kept the
AgentRouter list layout, managed profile resume actions, all client sources, and
rolling date filters. Timing is an estimate derived from local log events, not a
measurement of pure generation throughput. Old session sidecars rebuild once on
schema version 16. Upstream tests use this repository's collector directory and
a model present in its bundled curated pricing table; no new model rate is invented.

Measured on the user's machine against a read-only snapshot of actual cursor state
(8,747,636 bytes, 498 Codex files). Parser output and writes went to a disposable
temporary directory; no live cursor, queue, gateway or provider was modified:

| Operation | milliseconds |
| --- | ---: |
| Read cursor | 3.92 |
| Parse cursor JSON | 15.61 |
| Discover Codex files | 8.72 |
| Incremental parse | 17.42 |
| Serialize cursor | 16.10 |
| Write and rename temporary cursor | 10.49 |
| Repeated incremental parse | 4.20 |

These are single-run warm-filesystem measurements, not a cold-start benchmark
or a measurement of network collectors/full session sidecar rebuilds. They do not
support adding OpenCode-specific sharding to address this machine's Codex latency.

Verification after session integration: collector 102 passed; UI 275 passed;
core 1,149 passed / 6 skipped; typecheck and production assets build passed.
Three actual local Codex logs parsed successfully with timing/model metadata,
including a partially priced multi-model session. Headless installed Chrome
verified opening details from the existing list, closing via Escape/button,
focus restoration, and no page errors (isolated fixture UI, no running-app restart).

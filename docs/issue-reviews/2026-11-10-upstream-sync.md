# 2026-11-10 upstream integration

Baseline: AgentRouter `2c8d0e9ac`, branch `codex/upstream-sync-20261110`.
This change updates source and bundled-runtime pins. It does not publish a release
or restart the installed gateway. Root/workspace versions remain unchanged.

## Scope and provenance

| Upstream | Reviewed revision | Integrated changes |
| --- | --- | --- |
| TokenTracker | v1.5.17, `fba54de8e8fc96301ad3607e911181040b86fdb6` | WorkBuddy incremental-record safety, ZCode provider IDs, DSH history deduplication, Codex observed-model migration, pricing, session sidecar reuse and shared quota cache guards |
| Wake | v0.10.2, `3aabdc1d5ff903b4ef4de4e7fc21cfb39b52484c` | CJK two-character search, Claude AI titles and branch-title inheritance, native MiMo parsing |
| ai-memory | v3.4.5, `ee73c04c542fa41ca629b046deb4ac108518f407` | Complete pinned source archive, five runtime asset SHA-256 pins, supervisor version and integration contract updates |

Commit-level attribution for TokenTracker and Wake is recorded in their NOTICE
and session-core README. ai-memory's 1,375 vendored files were compared byte for
byte with the release archive; there were no missing, extra or changed files.
The credential-shaped sanitizer fixtures are the upstream public FAKE examples,
not local credentials. No user configuration or real-data snapshots are included
in the source change; audit copies and logs are under ignored `.cache/`.

## AgentRouter adaptations

- Codex model buckets retain the encoded source/configuration instance. A busy
  sibling model or another profile cannot supply a missing model identity.
  Flattened historical groups are handled without replaying usage twice.
- Quota fallback is enabled for Cursor, Grok Bot and Grok Build. Account identity,
  product, expiration and fetch generation bound the cache; login failures do not
  masquerade as fresh success. A previous fetch cannot overwrite a newer result
  after an asynchronous identity check. The broader upstream provider refactor
  was not substituted for AgentRouter's Claude Official and single-account logic.
  Full Cursor/Grok polls and product-only polls have separate cache scopes. Files
  stay under AgentRouter's collector directory with mode 0600.
- Session analytics refresh rechecks changed files while preserving parsed and
  repriced sidecars. Sidecar version 29 invalidates incompatible old summaries.
  Optional projections are available internally; this does not claim a new UI
  payload optimization for the native Rust session page.
- MiMo's native parser retains `AgentId::Mimo`, old schemas, source-read-only
  behavior, custom roots, legacy `MIMO_HOME`/`MIMO_DB` discovery and official
  `MIMOCODE_HOME` discovery. Imported history and spawned lanes are distinguished.
- ai-memory 3.4.5 adds automatic unfinished-session recovery to handoffs.
  AgentRouter's MiMo handoff request explicitly sends `recovery=0`, preserving
  completed-turn-only recall. Other existing integration behavior stays covered
  by real-engine tests.

## Reviewed items that do not require a source transplant

- Claude Code Router's latest Docker authentication correction is already in
  AgentRouter. No additional current CCR change was needed.
- CliRelay's token-speed, route-attempt and retry/backoff concerns have existing
  implementations in `token-rate.ts`, `gateway-stream-metrics.ts`, `route-trace.ts`
  and `gateway/upstream/retry-policy.ts`. Existing gateway regression tests pass.
  Its Go-engine first-byte fallback and configuration/control-plane changes are
  not drop-in fixes for this gateway and are not claimed as implemented here.
- TokenTracker's DSH session-browser optimization operates on a session source
  absent from AgentRouter's JavaScript session browser. AgentRouter uses its
  native DSH session adapter; the applicable usage-collector fixes are included.

## Validation

On macOS arm64:

- Core: 1,177 passed, 6 skipped, 0 failed (1,183 total).
- Collector: 255 passed, 0 failed, including WorkBuddy partial UTF-8 records,
  Codex historical migration/idempotence, configuration-instance isolation,
  DSH forks, quota cache races and sidecar recovery.
- Native session core: 461 passed, 3 ignored, 0 failed. The real-data search test
  is one ignored-by-default test and was separately run successfully.
- Architecture: 20 passed. Gateway streaming: 10 passed. TypeScript check passed.
- ai-memory integration starts the old 3.2.5 runtime in a temporary directory,
  writes a page, then opens that database with 3.4.5 and verifies persistence,
  authentication and stop/start. No live memory database or external model call
  is used by that migration test.

### Real usage snapshot

Read the live collector cursors/queue into disposable copies. Compared the latest
row for every source/model/time bucket before and after migration:

- 19 encoded source/configuration-instance partitions.
- 30,755,898,315 total tokens; every partition preserved its total.
- 5,266 rows became 5,273 model rows after migration, without added usage.
- A second migration produced a byte-identical queue.

### Real session snapshot

SQLite backup of the local index: 1,009 sessions and 129,120 messages. A complete
scan uses a disposable `sessions/index.sqlite` with the real profile roots
available read-only, matching production roster discovery. Every existing client
retained its session count; MiMo changed from 9 to 12 by recognizing three lanes.
SQLite integrity check passed.

On a separate unchanged copy, CJK backfill preserved search hit counts:

| Query | Hits before/after | Before | After |
| --- | --- | --- | --- |
| 部署 | 102 / 102 | 100.80 ms | 10.63 ms |
| 配置 | 111 / 111 | 75.83 ms | 10.64 ms |
| 部署 docker | 100 / 100 | 6.75 ms | 3.80 ms |

These are single-run local search measurements, not a whole-page benchmark.
Audit evidence is in `.cache/upstream-audit/20261110/`. Production databases,
the installed application and active gateway sessions were not modified.

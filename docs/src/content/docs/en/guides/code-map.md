---
title: Code map
pageTitle: Code map
eyebrow: Development reference
lead: Module responsibilities, entry points, launch and usage data flows, and boundaries for local-session collection.
---

## Repository layout

```text
packages/electron/  Desktop process, windows, tray, IPC, updates
packages/cli/       Command-line entry
packages/core/      Configuration, profiles, gateway, routing, logs, usage, tools
packages/ui/        React main window, tray, and shared components
vendor/ai-gateway/  Retained gateway source; check runtime/build references
build/             Build, test, package, and artifact verification
scripts/           Supporting generators, including model catalogs
tests/             Cross-package architecture, end-to-end, and system tests
docs/              Astro documentation and Markdown sources
.github/workflows/ Documentation and release workflows
```

Business services belong in core. Electron and CLI provide different runtime entry points; the UI calls services through their exposed interfaces. Shared contracts live in `packages/core/src/contracts/`. Architecture tests enforce package boundaries.

## Entry points

All paths below are relative to the repository root.

| Area | Entry | Responsibility |
| --- | --- | --- |
| Desktop | [main.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/main.ts), [main-app.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/main-app.ts) | Runtime paths, application startup and shutdown |
| Desktop bridge | [preload.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/preload.ts), [ipc.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/electron/src/main/ipc.ts) | Renderer-facing API and IPC handlers |
| CLI | [cli.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/cli/src/cli.ts) | Command parsing, profile selection, and agent launch |
| Web API | [management-server.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/web/management-server.ts) | Browser management endpoints |
| UI | [App.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/App.tsx) | Navigation, configuration drafts, saving, and profile actions |
| Configuration | [config.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/config/config.ts), [config-repository.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/config/config-repository.ts) | Normalization, compatibility, and persistence |
| Contracts | [contracts/app.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/contracts/app.ts) | Shared configuration and service data structures |
| Profiles | [profiles/service.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/service.ts) | Apply and restore agent configuration and managed authentication |
| Launch | [launch-core.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/launch-core.ts), [launch-service.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/launch-service.ts) | Launch plans, execution, and runtime state |
| Terminal | [terminal-launch.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/profiles/terminal-launch.ts) | Terminal selection and foreground activation |
| Gateway | [application/gateway-service.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/application/gateway-service.ts) | Gateway orchestration, configuration, and synchronization |
| Runtime | [supervisor.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/core-runtime/supervisor.ts) | Gateway child process and health checks |
| Routing | [claude-code-router-plugin.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/gateway/claude-code-router-plugin.ts), [routing/config-compiler.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/routing/config-compiler.ts) | AgentRouter policies and rule compilation |
| Request logs | [request-log-store.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/observability/request-log-store.ts), [raw-trace-sync.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/observability/raw-trace-sync.ts) | Request persistence, retention, and raw trace ingestion |
| Usage | [usage/store.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/store.ts), [billing-sync.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/billing-sync.ts) | Usage capture; aggregation by today / 24h / 7d / 30d / custom ranges with provider and model filters, 90-day status series, reset, and billing synchronization |
| Token normalization | [normalization.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/usage/normalization.ts) | Protocol-specific token accounting |
| Overview | [overview.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/overview.tsx) | Fixed flat overview: time range with provider / model filters, stat strip, trend, and account balance; status strip and breakdowns live in overview-status, overview-trend, overview-breakdown, and overview-accounts alongside it |
| Usage | [local-usage.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/local-usage.tsx) | TokenTracker-style usage overview |
| Sessions | [SessionsPage.jsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/vendor/tokentracker/pages/SessionsPage.jsx) | Local sessions; `ar_profile` from profile homes; resume via profile CLI/App |
| Trend | [local-trend.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/local-trend.tsx) | Day/week/month/year/total/custom usage curve |
| Heatmap | [local-heatmap.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/local-heatmap.tsx) | Codex-style contribution heatmap, local identity, tool ranking |
| Collector | [usage-page.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/collector/usage-page.ts), [local-sources.cjs](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/vendor/tokentracker/local-sources.cjs) | Read Claude/Codex/Grok sessions and per-profile `CODEX_HOME` |
| Session analytics | [session-analytics.js](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/core/src/vendor/tokentracker/lib/session-analytics.js) | Scan session files, duration, tools, and profile id from path |
| Log UI | [network-logs.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/network-logs.tsx), [token-rate.ts](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/lib/token-rate.ts) | Log details and timing/rate presentation |
| Agent analysis | [agent-analysis.tsx](https://github.com/zhangqinzhong/AgentRouter/blob/main/packages/ui/src/pages/home/components/agent-analysis.tsx) | Session- and agent-filtered execution analysis: session records, trajectories, and trace details; reuses the network-logs expanded details |

## Profile launch flow

```text
Profile card → save configuration → preload / IPC
  → openProfileFromAr → applyProfileConfig
  → terminal-launch → agentrouter <profile-id> cli
  → CLI profile resolution → buildProfileLaunchPlan
  → permission mode, saved arguments, and environment → agent
```

A launch alias enters the same CLI through a generated script. It binds to the profile ID, not its display name. App launches use separate agent-specific adapters; CLI permission and argument options do not imply equivalent App behavior.

Session resume: files under `~/.agentrouter/profiles/<id>/` are tagged with that profile. The sessions page then shows that profile's CLI/App actions (`resume` / `--resume`), not the upstream `codex resume` command.

## Gateway and usage flow

```text
Agent / API client → local gateway runtime → AgentRouter routing plugin
  → selected provider / model → client response

Raw traces → raw-trace-sync → request records, traces, body files
                          └→ missing usage capture
Billing usage → billing-sync → usage/store

Request data → logs and observability
Usage store → getUsageStats → IPC or Web API → overview charts
```

`gateway/service.ts` is a compatibility export surface. The main orchestration lives in `gateway/application/gateway-service.ts`; runtime configuration and process startup live under `gateway/core-runtime/`. Follow those references before assuming a retained vendor or older gateway file is the active execution path.

## Storage boundaries

Default root: `~/.agentrouter` on macOS/Linux; `%APPDATA%\agentrouter` on Windows. Runtime overrides are resolved by `runtime/app-paths.ts` and `config/constants.ts`.

| Path under the configuration root | Data |
| --- | --- |
| `config.sqlite` | Configuration and credentials |
| `profiles/`, `bin/` | Isolated profile state and generated launchers |
| `terminal-launchers/` | Script-based terminal launch entries |
| `app-data/request-logs.sqlite` | Requests and related traces |
| `app-data/request-log-bodies/` | Request and response bodies |
| `app-data/raw-trace-spool/` | Raw trace synchronization staging |
| `app-data/usage.sqlite` | Overview usage records |
| `app-data/context-archive.sqlite` | Context archive |

Logs and observability share request data. Overview usage has separate storage and reset behavior. Request retention does not make the entire application data directory disposable.

## Local-session collection boundary

The WidgetKit extension in `native/AgentRouterWidget` provides summary, heatmap, model ranking and quota widgets. `WidgetSnapshotWriter.swift` publishes native-menu data as a local snapshot; the extension reads it and opens the main window through `agentrouter://dashboard`.

The macOS menu uses SwiftUI/AppKit in `native/AgentRouterTray`. Electron connects it through `native-tray-controller.ts` and `native-menu-data.ts`.

`packages/core/src/collector/` manages a background worker. The vendored TokenTracker parsers in `packages/core/src/vendor/tokentracker/` collect local Claude/Codex sessions, including AgentRouter profiles, and preserve the original quota and aggregate contracts. Incremental cursors and compacted buckets live in `~/.agentrouter/collector`. Gateway statistics remain independent in `usage.sqlite`; the two totals are not added together.

Collection installs no hooks and enables neither telemetry nor cloud sync. Renewal dates come from manually maintained subscription records. Run `npm run test:collector` to check deduplication, cumulative usage and quota contracts.

One request can appear in both a session log and a gateway record. Adding the two datasets directly would double-count it. Input, cache, output, reasoning, and cumulative counters also need normalization per source before aggregation.

App icon metadata lives in `build/brand.json`; `build/AgentRouter.icon` is the native Icon Composer source. `build/native-app-icon.mjs` compiles `Assets.car` and legacy ICNS resources and exports matching UI and documentation images.

## Validation and documentation

Use `npm run typecheck`, `npm run test:core`, `npm run test:ui`, `npm run test:electron`, and `npm run test:architecture` for their respective layers. Build documentation with `npm run build --prefix docs`.

`build/build.mjs` and `electron-builder.json` control desktop packaging. `build/verify-release-version.mjs` checks release versions. Register documentation navigation in `docs/src/docs-structure.ts`; documentation changes on `main` deploy through the Docs workflow without a desktop release.

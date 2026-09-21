# Changelog

## Unreleased

## 1.6.6 - 2026-09-21

- Fixed the release build after the shared custom date-range picker refactor.

## 1.6.5 - 2026-09-21

- Unified custom date-range selection across Overview, Usage and Trend with the Usage page calendar popover.
- Replaced Overview's native date inputs and Trend's hand-built popup with the shared date-range picker.

## 1.6.4 - 2026-09-21

- Fixed tray compact number units to follow the selected interface language instead of the operating-system locale.
- Removed the render-time TokenTracker locale mutation and synchronized locale changes through language preference and system-language events.

## 1.6.3 - 2026-09-21

- Unified compact number formatting across Overview, Usage, Trend, Heatmap and Sessions so Chinese uses 万/亿/万亿 and English uses K/M/B/T.
- Made full-value tooltips and ordinary counters follow the selected interface locale, and removed the separate TokenTracker unit-system localStorage preference.
- Replaced per-page language inference with a single app-level locale sync for vendored TokenTracker views.

## 1.6.2 - 2026-09-20

- Fixed overview model, client and provider analysis to ignore empty rows and keep aggregate totals aligned with the displayed breakdown.
- Fixed the Chinese overview empty state so model usage no longer falls back to English.

## 1.6.1 - 2026-09-20

- Added Cursor, MiMo and ZCode quick filters to the Sessions page.

## 1.6.0 - 2026-09-20

- Added direct local usage collection for Cursor and expanded TokenTracker-compatible sources, including MiMo and ZCode, with model, client and session attribution.
- Added Cursor branding to the usage overview and fixed native tray provider icons that were missing when Swift Package asset-catalog resources were loaded from the wrong bundle.
- Improved local usage aggregation and overview coverage for provider models, client analysis and session statistics.

## 1.5.0 - 2026-09-19

- Refreshed the management UI across providers, agent profiles, settings, routing, logs and observability with a consistent overview layout.
- Kept provider and agent profile creation/editing in focused dialogs, with a single checkable model list and accurate allowed-model counts.
- Improved request logs and observability pages with full-width layouts, responsive headers and smoother data presentation.
- Fixed stale provider model entries from inflating agent profile allowlists during automatic model refresh.
- Added UI style guidance and coverage for the refreshed flat pages and provider/profile interactions.


## 1.3.0 - 2026-09-17

- Added Sessions, Trend and Heatmap as first-level sidebar pages next to Usage.
- Trend page shows TokenTracker totals above a full-width usage curve with complete day/week/month/year/total/custom axes, including empty buckets.
- Total trend fills empty months so the chart can pan through months without usage.
- Custom ranges can cross years, and long custom charts use monthly ticks instead of overlapping daily labels.
- Heatmap page follows the Codex profile layout: local avatar and name, lifetime/peak/streaks, contribution calendar, hover tooltips, and most-used tools with mapped names and icons.
- Sessions resume actions use the matching AgentRouter profile CLI/App buttons when the session lives under a profile home.
- Overview account balance uses horizontal rows, client analysis no longer labels empty clients as unknown, and the token-mix widget is removed.
- System status shows one DeepSeek-style 180-day uptime row per provider, with card height growing to fit.
- Solid window backgrounds on macOS so the UI stays opaque on newer system versions.
- Updated the code map for the local usage collector, heatmap, trend and session resume flows.

## 1.2.1 - 2026-09-16

- Restored TokenTracker model attribution without inferring historical models from later thread settings.
- Display unattributed models as Other at the end of usage and cost detail lists.
- Prefer an available stable Apple signing certificate for local macOS builds, preserving application identity across updates.

## 1.2.0 - 2026-09-16

- Added a local-session usage page with tool/model filters, cost details and nested context breakdowns.
- Added native macOS tray, desktop pets, Dynamic Island and WidgetKit integration, with unified application icons.
- Collect local Claude, Codex, OpenClaw, Grok, Mimo, ZCode, LM Studio, Gemini, OpenCode and Kilo CLI data independently of gateway logs.
- Recover Codex model attribution from thread settings and unique session/turn evidence, with a guarded rebuild of existing statistics.
- Correct MCP namespace separators so context tools are grouped under their actual servers.
- Surface upstream stream failures instead of silently reporting successful completion.

## 1.1.2 - 2026-09-14

- Moved distribution and automatic update checks to the independent zhangqinzhong/AgentRouter repository.
- Updated documentation and download links for the new repository.

## 1.1.1 - 2026-09-14

- Corrected desktop publisher, copyright display, and repository metadata.
- Included the original MIT license in desktop distributions.
- Fixed documentation deployment for this repository’s GitHub Pages URL.
- Corrected the Docker workflow’s image namespace and release defaults.

## 1.1.0 - 2026-09-13

- Added profile launch aliases, per-profile YOLO mode and saved CLI arguments.
- Added direct terminal launch with Otty, iTerm2 and system terminal selection on macOS.
- Bring Otty to the foreground and keep launch/copy actions directly accessible.
- Support Command-W to close macOS windows while the gateway stays running.
- Restore Claude authentication when disabling a profile without overwriting user hooks and preferences.
- Ported upstream plugin error handling and Claude Design streaming/redirect fixes (by @musistudio).
- Added average-throughput help and refreshed product documentation and demo data.

## 1.0.1 - 2026-09-13

- Ported remaining upstream settings save/reconciliation and provider reference updates (by @musistudio).
- Added unsaved draft protection and the Claude advanced settings editor (by @musistudio).
- Updated the bundled model catalog and Codex base instructions (by @musistudio).
- Preserved AgentRouter branding, log retention and timing metrics.

## 1.0.0 - 2026-09-13

Initial independent AgentRouter release.

- Unified AgentRouter desktop and menu bar branding.
- Added request timing/rate columns and configurable log retention.
- Fixed orphaned request payload files and duplicate trace replay storage.
- Ported upstream credential concurrency, database initialization retry, protocol-aware token limits, and retry handling fixes (by @musistudio).
- Configured releases and update checks for the AgentRouter repository.

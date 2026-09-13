# Changelog

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

---
title: Memory
pageTitle: Memory
eyebrow: Detailed configuration
lead: The embedded ai-memory runtime shares project knowledge, session history, and handoffs across coding clients.
---

The Memory page embeds the [ai-memory](https://github.com/akitaonrails/ai-memory) v2.5.2 runtime and brings the project knowledge base, session capture, handoffs, and client integration into native pages. It does not embed the upstream web UI; upstream source, license, and provenance live in the repository under `vendor/ai-memory` and `vendor/ai-memory.UPSTREAM.md`.

## Enabling and lifecycle

Memory is **opt-in**. On first start the app copies the bundled (checksum-verified) runtime into an immutable runtime directory, initializes the data directory, and starts the service; the runtime ships with the app, so there is no in-product download or separate engine installation.

| Behavior | Details |
| --- | --- |
| Data directory | `<AgentRouter config directory>/ai-memory` (`~/.agentrouter/ai-memory` by default on macOS/Linux). Wiki, SQLite, raw events, configuration, and backups stay independent of worktrees and profiles. |
| Network boundary | The service listens only on `127.0.0.1:49374` and requires a random local credential held by the app (never exposed to the renderer). |
| Port conflict | An existing listener on 49374 is treated as a conflict — AgentRouter never adopts or stops another process. |
| Lifecycle | Closing a window does not stop memory; exiting the app does. `Auto-start` is optional in Settings. |
| Status | The page header shows `Stopped / Starting / Running / Stopping / Error / Unavailable`. |

## Page sections

| Section | Contents |
| --- | --- |
| Knowledge | Browse memory pages per project, safe Markdown reading, create, edit, and pin. |
| Search | Retrieval within a project or across projects. |
| Sessions | Paginated inspection of captured session events. |
| Handoffs | Handoff summaries, state, and next steps, with owner-redaction handling. |
| Clients | Preview, install, inspect, and remove client-wide MCP / Hook wiring. |
| Maintenance | The complete live upstream MCP tool catalog with schema-driven native forms and a structured-argument mode; **non-read-only calls require confirmation**. |
| Settings | Lifecycle (start / auto-start), semantic search, backup, the full upstream TOML, and bounded logs. |

## Client integration

The client table covers twenty client / engine variants, including Claude Code, Codex, OpenCode 1/2, Cursor, Gemini, Grok, Pi, OMP, Command Code, Antigravity, Zero, ZCode, Devin, Kimi, Kiro 2/3, Zed, Muse, and macOS Claude Desktop, with their capability differences retained.

The flow is `Preview → Install → Inspect`; preview before removing:

- Installation reuses the upstream merge logic and records the previous file bytes plus the exact installed postimage under owner-only permissions.
- Removal restores the prior file only if the current postimage still matches; if another tool or user modified it, removal **refuses** rather than overwriting.
- Clients sharing a config file may need to be removed in reverse installation order.
- Removing a client never purges stored memory.

Project-specific adapters (VS Code Copilot, Swival, Kiro v2 custom-agent hooks) require an explicit target and stay available through the bundled CLI instead of guessing a project. A configured entry is not reported as a verified live capture.

## Capture

Capture is strictly opt-in per project: place an `.ai-memory.toml` with explicit `workspace` and `project` names in a project you want remembered. AgentRouter never writes markers automatically and never enables capture for all repositories. Installed integrations buffer events in native hooks and deliver them at session boundaries plus bounded mid-session drains.

## Semantic search

Semantic search starts disabled to avoid an implicit model download or external calls. Enabling it shows a confirmation that explains the data boundary:

- Local provider (default): downloads a model once; data stays on the machine.
- Cloud provider: must be selected explicitly in the advanced TOML configuration, and **memory content is sent to that provider**; saving configuration warns about external calls too, and changes take effect on restart.

Inherited model keys, profile homes, and arbitrary `AI_MEMORY_*` variables are never passed to the service; automatic historical-session backfill stays disabled.

## Data safety and backups

- All stored memory prose is untrusted history: the renderer never executes stored HTML, backend reads use a closed route allowlist, and ordinary memory content is not automatically a correct description of the current branch.
- `Settings → Backup` creates a manual backup; saving the TOML configuration also keeps a private backup.
- **Back up the complete memory data directory before upgrading**: database migrations belong to upstream, and swapping in an older executable is not a database rollback.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Status stays `Stopped` | Click `Start memory` in the page header; make sure port 49374 is not taken by another process. |
| Status `Error` or `Unavailable` | Check the bounded logs under `Settings`; port conflicts and a damaged runtime show up there. |
| Search returns nothing | Confirm the project opted in via `.ai-memory.toml` and has captured sessions; without semantic search only basic retrieval runs. |
| Client installed but nothing is captured | Confirm the target project opted in and the client was restarted; a configured entry is not a verified live capture. |
| Client removal is refused | The config file changed after installation; review the diff and handle it manually — stored memory is unaffected. |

---
title: Data sources
---

Add private Claude Code and Codex data directories in **Settings → Data sources**. Usage collection and the session index share these locations.

- Claude Code: choose the `CLAUDE_CONFIG_DIR` directory containing `projects`, or the projects directory itself.
- Codex: choose `CODEX_HOME`, `sessions` or `archived_sessions`.
- Standard locations and AgentRouter-managed profiles are detected automatically. Duplicate real paths are scanned once.

Disabling stops future scanning. Removing a location keeps client files and previously collected usage. Token counts are available only when recorded locally by the client.

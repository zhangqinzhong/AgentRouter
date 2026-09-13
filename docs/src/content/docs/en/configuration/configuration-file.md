---
title: Config database location
pageTitle: Config database location
eyebrow: Detailed configuration
lead: Locate the SQLite configuration database maintained by the AgentRouter desktop app.
---

## Default locations

- **macOS/Linux**: `~/.agentrouter/config.sqlite`
- **Windows**: `%APPDATA%\agentrouter\config.sqlite`

Docker sets `HOME=/data`, so its configuration database is `/data/.agentrouter/config.sqlite`. Persist the complete `/data` directory so the configuration database and companion files are preserved.

## Applying changes

AgentRouter stores runtime configuration in SQLite. A legacy `config.json` is read only once as a migration source when no SQLite config exists; after migration, editing `config.json` does not affect the current configuration.

Use the desktop UI to change configuration, or export a backup from **Settings**. Do not edit `config.sqlite` directly while AgentRouter is running; SQLite also maintains companion `config.sqlite-wal` and `config.sqlite-shm` files in the same directory.

## Related data

| Content | Default macOS/Linux location |
| --- | --- |
| Request logs and observability | `~/.agentrouter/app-data/request-logs.sqlite` |
| Request and response payloads | `~/.agentrouter/app-data/request-log-bodies/` |
| Overview usage statistics | `~/.agentrouter/app-data/usage.sqlite` |
| Agent profiles, sessions, and caches | `~/.agentrouter/profiles/` |

On Windows, application data defaults to `%APPDATA%\agentrouter`. Legacy directories and protocol names may remain for compatibility; an old name alone does not make a session or configuration file disposable. Log retention does not expire agent sessions, plugin caches, or Overview usage statistics.

The Docker entrypoint still uses `/data/.claude-code-router` for compatibility bootstrap; the application's current data directory is `/data/.agentrouter`. Mount or back up all of `/data`, rather than only one subdirectory.

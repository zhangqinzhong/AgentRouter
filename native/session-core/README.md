# AgentRouter session core

AgentRouter-owned MIT fork of the parsing, indexing and platform services originally
implemented by iAmCorey/Wake 0.9.2, commit 28098309788710ce3c8e83418a87e193b965551a.
Original copyright is retained in LICENSE. This is maintained in this repository:
no Wake package, application, git dependency, build directory or database is required.

The default index is ~/.agentrouter/sessions/index.sqlite. AR_SESSION_INDEX overrides
it for deployments/tests. AR_SESSION_HOME selects a fixture home for adapters. No
migration from Wake or vibex runs. Managed AgentRouter profile roots join the same
adapter roster as local directories. The index contains session/search metadata;
usage billing and the existing ai-memory knowledge database remain separate domains.

## CLI and MCP

The read-only query commands share the same index and parser with the UI:

- agentrouter-session-cli sessions --project "$PWD"
- agentrouter-session-cli search "useEffect("
- agentrouter-session-cli show KEY
- agentrouter-session-cli projects
- agentrouter-session-cli memories
- agentrouter-session-cli context
- agentrouter-session-cli setup
- agentrouter-session-cli index
- agentrouter-session-cli refresh

Index/refresh update only AgentRouter's index. Queries do not modify agent data.
agentrouter-session-mcp serves the same query tools over stdio:
ar_session_search, ar_session_list, ar_session_read, ar_session_projects, and
ar_session_memories. New references use agentrouter://session/<key>#<seq> and
agentrouter://memory/<key>. Historical wake_* tool names stay out of the full-text
index, and historical wake:// references still open. The session page is search
and reading. SSH, cleanup, activity, and the memory-file browser stay out of that
page; the native implementations remain. The bundled integration plugin supplies
MCP and an optional SessionStart hook; installing it is explicit, not a side
effect of opening the session view. AR_SESSION_ON_REQUEST=1 suppresses automatic
history context. AR_SESSION_BIN_DIR selects the runtime.

## Verification

cargo test --manifest-path native/session-core/Cargo.toml
node --test tests/collector/session-workspace.test.cjs

Deletion is split into reviewed server-owned batches and execution, revalidates
file ownership and timestamps, and uses the OS Trash. Remote synchronization is
only run against an explicitly configured host and only reads whitelisted sources.

## November 2026 upstream backports

Reviewed Wake 0.10.2 (`3aabdc1d5ff903b4ef4de4e7fc21cfb39b52484c`), and adapted:

- `aba10d5`: two-character CJK full-text search, incremental backfill and safe
  fallback while the auxiliary index is unavailable.
- `6bd9757`: Claude-generated titles, including inherited titles on branches.
- `8c8cfcf`: MiMo native sessions, subagent lanes, imported-history folding and
  system-session filtering. AgentRouter retains `AgentId::Mimo`, legacy database
  schemas and the `MIMO_HOME`/`MIMO_DB` roots alongside official MiMo discovery.

The parsing format is `ar-17`, triggering one derived-index reparse; CJK indexing
has its own version and transactionally follows message updates and deletions.
No upstream application or database dependency is introduced.

The opt-in `upstream_real_data` test accepts only an explicitly supplied disposable
snapshot path containing `upstream-audit`; it is ignored in ordinary test runs.

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
agentrouter-session-mcp serves the same query tools over stdio. The bundled
integration plugin supplies MCP and an optional SessionStart hook; installing it
is explicit, not a side effect of opening the session view. AR_SESSION_ON_REQUEST=1
suppresses automatic history context. AR_SESSION_BIN_DIR selects the runtime.

## Verification

cargo test --manifest-path native/session-core/Cargo.toml
node --test tests/collector/session-workspace.test.cjs

Deletion is split into reviewed server-owned batches and execution, revalidates
file ownership and timestamps, and uses the OS Trash. Remote synchronization is
only run against an explicitly configured host and only reads whitelisted sources.

# ai-memory provenance

- Upstream: https://github.com/akitaonrails/ai-memory
- Release: v2.5.2
- Commit: `7580b74d0fb9d14a6d949dc92f5ea8bb7feb3c83`
- License: MIT, retained verbatim in `ai-memory/LICENSE`.
- Import: complete GitHub source archive at the pinned v2.5.2 commit, without the upstream Git database.

The upstream source is unmodified. AgentRouter owns the TypeScript supervisor,
native React interface, transport adapters, and client integration receipts.
These live outside this directory. Runtime resources are bundled at build time,
not downloaded by the installed application. Official binaries are pinned by
SHA-256 in `build/ai-memory-runtime.mjs`; `--source` builds this source with the
Rust toolchain required by the upstream manifest.

Updating requires updating the source, commit, release asset digests, runtime
contract fixtures, and real-engine acceptance tests together. Database migration
rollback is not equivalent to changing a binary: back up the complete memory data
directory before a version upgrade.

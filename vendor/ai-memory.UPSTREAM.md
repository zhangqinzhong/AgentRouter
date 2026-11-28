# ai-memory provenance

- Upstream: https://github.com/akitaonrails/ai-memory
- Release: v3.6.4
- Commit: `e1abfd7158883647f90047d56979d4780d82106e`
- License: MIT, retained verbatim in `ai-memory/LICENSE`.
- Import: complete GitHub source archive at the pinned v3.6.4 commit, without the upstream Git database.

The source matches the pinned release archive. Upstream sanitizer fixtures use
explicit FAKE test credentials; no local credentials are included.

AgentRouter owns the TypeScript supervisor,
native React interface, transport adapters, and client integration receipts.
These live outside this directory. Runtime resources are bundled at build time,
not downloaded by the installed application. Official binaries are pinned by
SHA-256 in `build/ai-memory-runtime.mjs`; `--source` builds this source with the
Rust toolchain required by the upstream manifest.

Updating requires updating the source, commit, release asset digests, runtime
contract fixtures, and real-engine acceptance tests together. Database migration
rollback is not equivalent to changing a binary: back up the complete memory data
directory before a version upgrade.

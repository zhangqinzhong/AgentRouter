# ai-memory provenance

- Upstream: https://github.com/akitaonrails/ai-memory
- Release: v3.2.5
- Commit: `3829f6187d8e9b7e6f32a9b2ac8831a64c5eff6f`
- License: MIT, retained verbatim in `ai-memory/LICENSE`.
- Import: complete GitHub source archive at the pinned v3.2.5 commit, without the upstream Git database.

Local source-only patch: the shared sanitizer fixture uses AWS’s documented
`AKIAIOSFODNN7EXAMPLE` test key instead of a random full-shaped credential,
preventing another synthetic-secret alert while retaining redaction coverage.
The shipped runtime binary remains the pinned upstream release.

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

# 2026-11-17 upstream integration

Baseline: AgentRouter `1f1c37738` (main), branch `codex/upstream-sync-20261117`.
This change updates source and bundled-runtime pins. It does not publish a release
or restart the installed gateway. Root/workspace versions remain unchanged.

## Scope and provenance

| Upstream | Reviewed revision | Integrated changes |
| --- | --- | --- |
| Claude Code Router | v3.1.4 and v3.1.5 (`v3.1.3..v3.1.5`) | Client proxy header/cookie isolation, usage outcomes counted once, request-log stream-flag backfill bound, gateway-child `API_TIMEOUT_MS`, hidden Windows console windows, Codex catalog capabilities, Z.ai/MiniMax quota presets, OpenAI `/v1/models` reasoning metadata, truncated-stream and SSE-boundary terminal errors, vendor thinking parameters, model-author completion limits, default-home Claude Code profiles, stdio MCP framing, Anthropic `tool_result` images, routing prefilters, Docker management hardening (origins, secret redaction, loopback publish, non-root services), priority credential routing, Codex OAuth model scopes, stale profile model selections, per-provider deferred tool loading, discovery context windows, unavailable-model removal, global profile recovery and failed-provider error detail |
| TokenTracker | v1.5.24, `ea17c5f6` | Claude Fable 5.2 and fast mode, GPT-6.2 Astra/Sol/Astra Law Standard rates, Gemini 4 Carbon/Hydrogen and Muse Wonder Cursor variants, Cursor Grok Bot subscription rows, bounded contained-key pricing lookup |
| ai-memory | v3.5.0, `bc7faa7d847dd387e634ba8420d115b9dd4ecebe` | Complete pinned source archive, five runtime asset SHA-256 pins, supervisor version and provenance |
| CliRelay | v0.6.3 | Readable `reasoning.content` removed before official OpenAI/ChatGPT Responses calls |
| Electron | 42.11.18 | Desktop runtime raised to the patched floor required by CCR #1957 |

## AgentRouter adaptations

- CCR commits were cherry-picked with `-x` and renamed to AgentRouter's package,
  header, environment and IPC names. Every conflict was resolved by hand against
  AgentRouter's code; AgentRouter-only behavior (memory RPC, local usage IPC,
  provider icon paths, stream metrics, Xiaomi model migration) is kept.
- An earlier port wrote the gateway child's timeout and undici module under
  `CCR_*` names while the preload reads `AR_*`; both now use `AR_*`, so
  `API_TIMEOUT_MS` reaches the gateway child.
- Usage totals: the provider series still interpolated the select builder
  function into SQL (a syntax error on that page), and error counts/success
  rate now count only the latest attempt of each request, as upstream does.
- Request logs keep AgentRouter's own body cleanup, orphan sweep and retention
  implementation; upstream's equivalent rewrite of `request-log-store.ts` and its
  orphan-sweep tests are not substituted.
- Profile recovery treats only `global` scope as a takeover; AgentRouter's
  `agentrouter` (and legacy `ccr`) and `custom` scopes cannot be "restored".
  The error text points to AgentRouter's Agent profiles page.
- The deferred tool loading switch and the unavailable-model list use the
  renderer's semantic tokens and shared controls.
- Log bodies: the worker transport bound from CCR is applied, but a stored body
  is treated as a preview only when it was truncated, so complete large JSON
  bodies still open in full.
- TokenTracker pricing is merged into AgentRouter's older pricing module by
  entry and guard, not by replacing files. AgentRouter does not model OpenAI
  speed tiers, so GPT-6.2's Ultrafast promotion and session-time repricing are
  not included; Standard rates are.
- CliRelay's Claude cache-breakpoint limit was reviewed and does not apply: the
  bundled gateway and AgentRouter never add `cache_control` breakpoints or an
  identity block, so client requests reach Anthropic unchanged.

## Reviewed items that are not integrated

- CCR Codex desktop identity isolation (TLS loopback workspace API, legacy
  `auth.json` quarantine, shared-account network switching). It depends on the
  plain-HTTP net responder that AgentRouter never adopted, and would rename a
  user's Codex login file. AgentRouter already prefers the CLI bundled with the
  desktop app and keeps non-global profiles off the personal ChatGPT login.
- CCR build patches for `@the-next-ai/ai-gateway` (stream terminal error, native
  safeguards) and their release action: AgentRouter consumes the published
  gateway package and does not build it from patched sources.
- CCR configuration conflict detection (`AppConfigConflictError`) and lazy route
  token estimation: their prerequisites are not in AgentRouter, so the tests that
  depend on them were not ported.
- TokenTracker Trae, Qoder and Antigravity collector changes, dashboard/billing
  and auto-update fixes: those sources and surfaces are not part of AgentRouter.

## Upgrade note for ai-memory

3.5.0 adds database migrations V107–V112 (WorkBuddy agent kind, session origin,
per-project retrieval defaults, retrieval history, page sources). They run the
first time the upgraded app starts memory. Back up `~/.agentrouter/ai-memory`
before installing a build that contains this change; the live database was not
touched during this work.

## Validation

On macOS arm64:

- Core: 1,280 run, 1,278 passed, 10 skipped. Two failures are not caused by this
  change: `UsageStore all range covers history older than 30 days` also fails on
  `main`, and `raw trace replay rotates through a bounded number of bundles per
  pass` is timing-sensitive under full-suite load and passes when run alone.
- ai-memory: the 3.2.5 runtime writes a page in a temporary directory, then the
  bundled 3.5.0 runtime opens it and verifies pages, authentication and
  stop/start.
- UI: 311 passed. Electron: 47 passed. CLI: 6 passed. Collector: 259 passed.
  Architecture: 23 passed. Gateway streaming: 10 passed. UI guard: 15 passed.
- `npm run check:ui` and `tsc --noEmit` passed.

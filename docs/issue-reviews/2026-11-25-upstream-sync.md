# 2026-11-25 upstream integration

Baseline: AgentRouter `1f7fe64ba` (1.14.0-rc.1), integrated on `main`.

## Scope and provenance

| Upstream | Reviewed revision | Integrated changes |
| --- | --- | --- |
| Claude Code Router | v3.1.6 (`v3.1.5..v3.1.6`) | Signed Node resolution for the current ChatGPT.app layout (`e1f912cf`); native image generation in Codex profiles (`018941b1`) |
| TokenTracker | v1.5.25–v1.5.27, `432156a1` | qwen4-max, Claude Mythos 5.2 and Gemini 4 Neon rates; Batch/Flex and unpinned Mythos aliases stay unpriced; provider-qualified LiteLLM exact lookups; free Grok Build rows at zero; Antigravity 2.34 limits |
| ai-memory | v3.6.2, `45a97cf8` | Complete pinned source archive, five runtime asset SHA-256 pins, supervisor version and provenance |
| CliRelay | v0.6.4–v0.6.5 | Reviewed, not integrated (see below) |

## AgentRouter adaptations

- The current ChatGPT.app puts the Codex CLI under `Resources/codex-cli/` while
  `cua_node` stays in `Resources/`. The middleware looked next to the CLI only,
  so on this layout it launched the CLI without the signed Node supervisor.
- Native image generation uses AgentRouter names: marker value
  `ar-native-image-generation`, `AR_CODEX_NATIVE_IMAGE_GENERATION`, and the
  `ar-codex-grok-image-compatibility` provider hook. The marker header is
  removed before any upstream call. Upstream's Codex identity-isolation
  variables in the same launcher block are not carried, since that feature was
  not adopted.
- The model selector's default option, accessible label and unavailable state
  are applied to AgentRouter's shared popover and `Button`, with semantic text
  tokens.
- Upstream's wire test lives in a file AgentRouter does not carry; it is ported
  as `codex-native-image-wire.test.mjs` and runs against the bundled gateway.
- TokenTracker pricing is merged by hunk. The refetch of the LiteLLM table on
  every unpriced lookup is left out: AgentRouter always sees custom model ids
  without public prices, which would refetch about once a minute. The existing
  daily refresh stays.

## Reviewed items that are not integrated

- CCR provider usage inside Codex desktop (`de0aaa8c`): it depends on the
  plain-HTTP net responder that AgentRouter does not use.
- TokenTracker source-recorded cost provenance (v1.5.27): it serves the cloud
  upload and dashboard; DeepAI Code source: not installed here.
- CliRelay v0.6.4–v0.6.5: cluster monitoring, DNS failover, access freezes and
  Codex incremental WebSocket uploads are server features of CliRelay; its
  translator performance fixes apply to its own translators, not to the bundled
  gateway.

## Upgrade note for ai-memory

3.6.2 adds migrations V113–V115 (trust class, Arabic/CJK reindex, workspace
grants). A copy of a live 3.5.0 store migrated with page, observation and
session counts unchanged and `quick_check` ok. Back up `~/.agentrouter/ai-memory`
before installing.

## 2026-11-27 follow-up (1.14.0-rc.3)

- TokenTracker v1.5.28–v1.5.34: GPT-6.2 Healthcare, `qwen4-max-preview` and
  `grok-4.7-latest` rates (#1179) are integrated. The Claude cli/sdk-cli dedup
  (#1167) was checked against the local Claude stores: none of 61,152 messages
  carries two request ids, so it is not ported. The Codex session-cache and
  legacy-bucket fixes (#1175, #1130) repair code paths AgentRouter does not
  have; Cloudflare backends, T3 Code quotas and platform app fixes do not apply.
- ai-memory v3.6.4 (`e1abfd71`): no new migrations; duplicate consolidation
  after empty resumes and consolidation pause on provider billing exhaustion.
- CCR and CliRelay: no releases since the previous review.
- The memory runtime is not connected to the Claude desktop Code tab, at the
  user's request.

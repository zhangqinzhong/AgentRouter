# 2026-11-25 upstream integration

Baseline: AgentRouter `1f7fe64ba` (1.14.0-rc.1), integrated on `main`.

## Scope and provenance

| Upstream | Reviewed revision | Integrated changes |
| --- | --- | --- |
| Claude Code Router | v3.1.6 (`v3.1.5..v3.1.6`) | Signed Node resolution for the current ChatGPT.app layout (`e1f912cf`); native image generation in Codex profiles (`018941b1`) |
| TokenTracker | v1.5.25–v1.5.27, `432156a1` | qwen4-max, Claude Mythos 5.2 and Gemini 4 Neon rates; Batch/Flex and unpinned Mythos aliases stay unpriced; provider-qualified LiteLLM exact lookups; free Grok Build rows at zero; Antigravity 2.34 limits |
| ai-memory | v3.5.1–v3.6.2 | Reviewed, not integrated (see below) |
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
- ai-memory 3.5.1–3.6.2: Windows ACL, Arabic search, workspace grants, handoff
  delivery and hook fixes. Local use shows the memory runtime is not connected
  to the Claude desktop sessions that are now the primary client, and recorded
  retrievals are near zero, so its V113–V115 migrations are not taken in this
  release.
- CliRelay v0.6.4–v0.6.5: cluster monitoring, DNS failover, access freezes and
  Codex incremental WebSocket uploads are server features of CliRelay; its
  translator performance fixes apply to its own translators, not to the bundled
  gateway.

# AgentRouter

[中文](README_zh.md) · [Download](https://github.com/zhangqinzhong/AgentRouter/releases/latest) · [Documentation](docs/README.md#english-guides)

**Your coding agents, providers, and launch profiles in one desktop app.**

Keep personal and company configurations separate, launch the right agent in your preferred terminal, and inspect the requests passing through your local gateway.

## Install

Download an installer from [Releases](https://github.com/zhangqinzhong/AgentRouter/releases/latest):

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `mac-Apple-Silicon-arm64.dmg` |
| macOS Intel | `mac-Intel-x64.dmg` |
| Windows | `.exe` |
| Linux | `.AppImage` |

AgentRouter checks this repository for updates. macOS packages are ad-hoc signed and not notarized by Apple.

## Set up your first profile

1. Add a **Provider** with its endpoint, credentials, protocol, and models.
2. Open **Agent Profiles**, choose an agent, and select a model.
3. Choose the profile scope. Use an isolated AgentRouter profile for a separate company or personal setup; use global scope to manage the agent's normal configuration.
4. For a CLI profile, set a launch alias and terminal. On macOS, choose Otty, iTerm2, or the system terminal; Otty is the default and must be installed separately.
5. Save, then click the terminal button on the profile card. The adjacent copy button copies the launch command.

The gateway listens on `http://127.0.0.1:3466` by default. Its running status appears in the sidebar.

### Short commands, saved options

For a profile named `CodexCompany`, set the alias to `ccwork`:

```sh
ccwork
# The original command also works:
agentrouter CodexCompany
```

Aliases stay attached to the same profile when its display name changes. Disabling or deleting a profile removes its alias command.

Claude Code and Codex profiles offer **Default** and **YOLO** permission modes. YOLO skips permission prompts; for Codex it also disables sandbox restrictions. These options apply to the profile's CLI launches, including aliases.

Add other CLI options under **Advanced settings → Additional launch arguments**, one argument per line. Paths containing spaces remain a single argument without shell quotes.

## What you can manage

| Area | Features |
| --- | --- |
| Agent profiles | Separate configurations, model selection, environment variables, launch aliases, CLI options, and terminal selection |
| Providers | Compatible API endpoints, model discovery, connectivity checks, and multiple credentials |
| Global routing | Conditional model selection, request rewrites, retries, and fallback models |
| Logs and observability | Requests and responses, routing decisions, first-token latency, output rate, average throughput, and tool traces |
| Usage overview | Request counts, tokens, cache usage, trends, and estimated costs |
| Tools | Fusion, MCP, ToolHub, and gateway extensions |

Profiles support Claude Code, Codex, OpenCode, Grok CLI, Kimi CLI, Kilo Code, Pi, ZCode, WorkBuddy, and Claude Design. Available CLI and app launch options depend on the agent. Agent software and provider access are configured separately.

If a profile should always use one model, select it in the profile. Configure global routing when requests need conditional handling or fallbacks.

## Local data

Configuration and runtime data live under `~/.agentrouter` on macOS and Linux, or `%APPDATA%\agentrouter` on Windows.

**Settings → Logs & Observability → Log retention days** controls request history retention. The default is one day, measured as a rolling 24-hour period. Logs and observability share request data; expired records, related traces, and unreferenced body files are cleaned together. Overview usage statistics are separate and have their own reset action.

On macOS, **⌘W** closes the window while the gateway continues running. Quit AgentRouter to exit the application.

## Run from source

Requires Node.js 22 or newer.

```sh
git clone https://github.com/zhangqinzhong/AgentRouter.git
cd AgentRouter
npm ci
npm run build:assets
node packages/cli/dist/main/cli.js ui
```

The browser management UI opens at `http://127.0.0.1:3458`. The CLI package is not currently published to npm; see the [CLI guide](packages/cli/README.md) for installation from source.

## Guides

- [Code map](docs/src/content/docs/en/guides/code-map.md)

- [Agent profiles and launch options](docs/src/content/docs/en/configuration/profiles.md)
- [Providers](docs/src/content/docs/en/guides/provider.md)
- [Logs, retention, and rate calculations](docs/src/content/docs/en/configuration/observability.md)
- [Docker deployment](docs/src/content/docs/en/guides/docker.md)
- [Release notes](https://github.com/zhangqinzhong/AgentRouter/releases) · [Changelog](CHANGELOG.md)

## License and acknowledgments

[MIT](LICENSE). AgentRouter is based on [Claude Code Router](https://github.com/musistudio/claude-code-router). The upstream copyright and license notices are retained.

### Local session usage

The Usage page reads local agent history, including managed Claude and Codex profiles and local OpenClaw, Grok, Mimo, ZCode and LM Studio stores. It provides date filters, model cost details and nested Claude/Codex/Grok context breakdowns. Context attribution and costs are estimates. Local-session statistics remain separate from gateway request logs.

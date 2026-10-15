# Installing ai-memory for your user (instructions for AI agents)

You are an AI coding agent and your user asked you to install ai-memory. On
Linux or macOS it takes two commands, and neither needs root.

1. Install the release binary. The script checks the download against the
   release's published SHA-256 checksum, puts the binary under
   `~/.local/lib/ai-memory` and links `~/.local/bin/ai-memory` to it:

   ```bash
   curl -fsSL https://github.com/akitaonrails/ai-memory/releases/latest/download/install.sh | sh
   ```

   If `~/.local/bin` is not on `PATH`, call `~/.local/bin/ai-memory` directly
   in the next step, and tell your user to add the directory to `PATH`.

2. Set it up for yourself, naming your own harness:

   ```bash
   ai-memory setup --yes --agent <self>
   ```

   `<self>` is one of `claude-code`, `codex`, `opencode`, `opencode2`,
   `gemini-cli`, `cursor`, `kimi-code`, `kiro-cli`, `grok`, `copilot-cli`,
   `antigravity-cli`, `command-code`, `devin`, `droid`, `muse`, `omp`, `pi`,
   `openclaw`
   (`ai-memory setup --help` lists every value). Repeat `--agent` to wire
   several harnesses. Without `--agent`, `setup` wires every harness it finds
   under the home directory.

`setup` creates the data directory with a root bearer token in an owner-only
file, starts a per-user service (systemd `--user` on Linux, a LaunchAgent on
macOS), registers the MCP server and installs the lifecycle hooks and Agent
Skills for each harness, then checks that the server answers. The token is
never printed and never written into a harness config. Running `setup` again
changes nothing.

Afterwards:

- Tell your user to restart the harness so it loads the new MCP entry and
  hooks.
- If `setup` exits non-zero, show your user the `problem:` lines it printed.
  Do not work around them by editing harness configs by hand.
- If the server already runs another way (Docker, a packaged system unit), add
  `--no-service`.
- On Windows, follow [`docs/windows.md`](docs/windows.md) instead; `setup` has
  no service step there.

Full reference: [`docs/install.md`](docs/install.md#one-step-native-install-installsh--ai-memory-setup).

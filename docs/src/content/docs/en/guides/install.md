---
title: Install and start AgentRouter
pageTitle: Install and start AgentRouter
eyebrow: Quick start
lead: Choose among the desktop app, npm CLI, and Docker distributions, complete installation and first startup, and verify the management UI and model gateway addresses. The CLI requires Node.js 22 or newer.
---

## Choose a distribution

| Distribution | Best for | Entry | Default management address | Default gateway address |
| --- | --- | --- | --- | --- |
| Desktop app | Daily local use, tray, multi-instance Agent Apps, desktop integrations | App UI, `agentrouter` | In-app window | `http://127.0.0.1:3466` |
| npm CLI | Terminal, SSH, no Electron, external process supervisors | `agentrouter` | `http://127.0.0.1:3458` | `http://127.0.0.1:3466` |
| Docker | Persistent servers and container operations | Nginx | Shared public endpoint | `http://127.0.0.1:3458` with the default mapping |

In desktop/CLI deployments, management and the model gateway use different ports. CLI management uses `3458` by default, while the model gateway uses `3466`. Docker intentionally combines both through one Nginx endpoint.

## Install the desktop app

1. Open [AgentRouter Releases](https://github.com/zhangqinzhong/AgentRouter/releases/latest).
2. Choose the Apple Silicon (arm64) or Intel (x64) DMG/ZIP for macOS, EXE for Windows, or AppImage for Linux.
3. Install and open **AgentRouter**.
4. Add a provider/model, create a client key under **API Keys**, then click **Start** under **Server**.

When Server shows Running, the model gateway defaults to `http://127.0.0.1:3466`. Enable automatic startup under Server if the gateway should start whenever the app opens.

## Desktop updates

The app includes this repository's Releases update feed. Use the in-app update check; no environment variable is required. Version 1.1.2 provides macOS, Windows, and Linux installers.

macOS packages use ad-hoc signing and are not Apple-notarized. Automatic installation on macOS has not been verified; manual replacement from Releases is available. Switching from the old 3.0.22 development builds to AgentRouter 1.x requires a manual installation.

## Install the npm CLI

Node.js 22 or newer is required:

The CLI package is not currently published to npm. Install from source:

```sh
git clone --branch v1.1.2 --depth 1 https://github.com/zhangqinzhong/AgentRouter.git
cd AgentRouter
npm ci
npm run build:assets
npm pack --workspace @zhangqinzhong/agentrouter --ignore-scripts
npm install -g ./zhangqinzhong-agentrouter-1.1.2.tgz
agentrouter --help
agentrouter ui
```

`agentrouter ui` starts a background service and opens the browser. Use `agentrouter ui --no-open` on a headless host or `agentrouter serve --no-open` under a process supervisor. See the [CLI installation and reference](../cli/) for all commands and profile launches.

## Use Docker

From a source checkout:

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:3458>. Docker publishes one Nginx endpoint shared by management and the gateway. Add a provider/model, create an AgentRouter client key, and start the gateway under Server. See [Docker deployment](../docker/) for ports, authentication, persistence, backups, and remote access.

## Verify the installation

After configuring a provider, model, and AgentRouter client key:

1. Confirm Server shows Running.
2. Request `/health` on the deployment's gateway address and expect a `200` running response.
3. Send one minimal model request to a compatible endpoint using the AgentRouter client key.
4. Confirm requested/resolved model, provider, status, and latency under Logs.

A reachable management UI does not prove that the model gateway is usable. Docker `/health` returning `502` is expected before a provider/model has been configured.

## Data locations

| Distribution | Configuration location |
| --- | --- |
| Desktop / CLI on macOS or Linux | `~/.agentrouter` |
| Desktop / CLI on Windows | `%APPDATA%\agentrouter` |
| Docker | `/data/.agentrouter`; persist `/data` |

Current configuration is stored in `config.sqlite`. Legacy `config.json` is only a migration source when SQLite does not exist, or an initial Docker bootstrap. Do not edit live SQLite files.

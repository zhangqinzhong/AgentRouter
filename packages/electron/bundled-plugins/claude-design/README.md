# Claude Design Plugin

This directory is installable through AgentRouter Desktop's local extension picker.

1. Open **Extensions**.
2. Click **Install**.
3. Click **Choose folder**.
4. Select this `plugins/claude-design` directory.
5. Install and keep the extension enabled.

Claude Design and Claude Ship are separate plugins. Install `plugins/claude-ship` when you also need the Ship app.

No third-party frontend host is configured by default. A custom frontend URL or assets origin can be set explicitly in the plugin configuration or AR_CLAUDE_DESIGN_FRONTEND_URL / AR_CLAUDE_DESIGN_ASSETS_ORIGIN.

Browser-saved Claude Design HTML and Claude app `ion-dist` assets are no longer auto-detected. The plugin uses the Cloudflare Pages frontend by default; for local development fixtures, set `frontendUrl`/`frontendAssetsOrigin` and `assetDir` explicitly. `assetDir` can point at any of these extracted roots:

- `/path/to/claude-design-assets/public`
- `/path/to/claude-design-assets/public/design`
- `/path/to/claude-design-assets/public/design/assets`

When `assetDir` contains a usable `design/index.html` or `index.html`, the plugin serves that saved HTML as the Design shell and does not mix in cached or remote-discovered entry bundles.

When the packaged app owns the `agentrouter://` protocol handler, the window can also be opened with:

```sh
open 'agentrouter://plugin/claude-design/open'
```

The local test is considered healthy when Claude Design opens, can create a project, can list projects, and can send an agent message.

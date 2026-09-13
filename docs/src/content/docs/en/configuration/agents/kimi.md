---
title: Kimi CLI setup and configuration
pageTitle: Kimi CLI
eyebrow: Detailed configuration
lead: "Connect Kimi CLI to AgentRouter. Kimi CLI is CLI-only and always scoped to AR-launched sessions."
---

## Who this is for

Kimi CLI is Moonshot's coding agent. In AgentRouter it is **CLI only** and always uses **Only opened from AgentRouter**.

Use this page to route Kimi CLI to any AgentRouter provider or Fusion model, expose several switchable models, or run separate Kimi CLI sessions.

> New to AgentRouter? Add a provider and model first. See [Add a provider](/en/guides/provider/) and the [Agent Config overview](/en/configuration/profiles/).

## Prerequisites

1. AgentRouter Desktop is running with at least one provider + model configured.
2. Kimi CLI is installed (available as `kimi` on `PATH`).
3. You are on **Agent Config** and click **Add profile**.

## Create the profile

1. On **Agent Config**, click **Add profile** and choose **Kimi CLI**.
2. Enter a **Config name** (for example `Kimi - Work`).
3. Choose a **Kimi model** (the default) and one or more **Available models**.
4. Leave advanced environment settings empty unless you have a specific local setup need.
5. **Save**, then copy and run the command from the profile card.

## Configuration reference

Kimi CLI is fixed to **Only opened from AgentRouter** and **CLI only**, so those two fields are not editable. The fields you configure are:

| Field | How to set it | Effect |
| --- | --- | --- |
| Agent | Choose **Kimi CLI** | Creates a Kimi CLI launch entry in AgentRouter. |
| Config name | Free text, e.g. `Kimi - Work` | Identifies the profile. Desktop commands use `agentrouter "<name>"`; CLI commands use `agentrouter "<name>"`. |
| Enabled | Toggle on/off | Disabled profiles are not applied and not offered as launch entries. |
| Kimi model | A provider model or Fusion model | The default model. At least one model is required. |
| Available models | One or more provider/Fusion models | Models available from Kimi's `/model` menu. The default model is always included. |
| Environment variables | Key/value rows | Optional advanced overrides; leave empty for normal use. |

## Open and use

Desktop command copied from the profile card:

```text
agentrouter "Kimi - Work"
```

For CLI, run:

```text
agentrouter "Kimi - Work"
```

Inside Kimi CLI, use `/model` to switch among the default and available models. Every selection stays routed through AgentRouter's providers, routing, and Fusion.

## Multi-instance

Create separate Kimi CLI profiles when you want different default models or model sets.

## Verify

1. Run the desktop `agentrouter` command copied from the profile card, or the CLI `agentrouter` command.
2. Send one message in Kimi CLI and confirm it replies.
3. Open **Request logs** in AgentRouter and confirm the request passed through the gateway.
4. Run `/model` and confirm the default plus available models appear.

## Common issues

- **`/model` is empty or missing models:** add at least one **Available model** (the default counts); confirm a provider + model is configured in AgentRouter.
- **Profile cannot be saved:** Kimi CLI requires both a default model and at least one available model.
- **`kimi` not found:** make sure Kimi CLI is installed and available from the same shell environment used to start AgentRouter Desktop.

---
title: Pi setup and configuration
pageTitle: Pi
eyebrow: Detailed configuration
lead: "Connect Pi to AgentRouter. Pi is CLI-only and always scoped to AR-launched sessions."
---

## Who this is for

Pi is a coding agent that selects its provider and model from the command line. In AgentRouter it is **CLI only** and always uses **Only opened from AgentRouter**.

Use this page to route Pi to any AgentRouter provider or Fusion model, or to run separate Pi sessions.

> New to AgentRouter? Add a provider and model first. See [Add a provider](/en/guides/provider/) and the [Agent Config overview](/en/configuration/profiles/).

## Prerequisites

1. AgentRouter Desktop is running with at least one provider + model configured.
2. Pi is installed (available as `pi` on `PATH`).
3. You are on **Agent Config** and click **Add profile**.

## Create the profile

1. On **Agent Config**, click **Add profile** and choose **Pi**.
2. Enter a **Config name** (for example `Pi - Work`).
3. Select a **Model**.
4. Leave advanced environment settings empty unless you have a specific local setup need.
5. **Save**, then copy and run the command from the profile card.

## Configuration reference

Pi is fixed to **Only opened from AgentRouter** and **CLI only**, so those two fields are not editable. The fields you configure are:

| Field | How to set it | Effect |
| --- | --- | --- |
| Agent | Choose **Pi** | Creates a Pi launch entry in AgentRouter. |
| Config name | Free text, e.g. `Pi - Work` | Identifies the profile. Desktop commands use `agentrouter "<name>"`; CLI commands use `agentrouter "<name>"`. |
| Enabled | Toggle on/off | Disabled profiles are not applied and not offered as launch entries. |
| Model | A provider model or Fusion model | The model Pi uses for every turn. |
| Environment variables | Key/value rows | Optional advanced overrides; leave empty for normal use. |

## Open and use

Desktop command copied from the profile card:

```text
agentrouter "Pi - Work"
```

For CLI, run:

```text
agentrouter "Pi - Work"
```

## Multi-instance

Create separate Pi profiles when you want separate launch entries with different models.

## Verify

1. Run the desktop `agentrouter` command copied from the profile card, or the CLI `agentrouter` command.
2. Send one message in Pi and confirm it replies.
3. Open **Request logs** in AgentRouter and confirm the request passed through the gateway.

## Common issues

- **Pi uses a different model than expected:** confirm the **Model** field.
- **`pi` not found:** make sure Pi is installed and available from the same shell environment used to start AgentRouter Desktop.
- **`/model` or model list is empty:** Pi does not use a `/model` list — set the exact **Model** you want on the profile.

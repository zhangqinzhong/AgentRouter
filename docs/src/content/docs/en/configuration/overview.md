---
title: Overview dashboard
pageTitle: Overview dashboard
eyebrow: Detailed configuration
lead: The AgentRouter home overview — system status, requests, tokens, cost, usage trend, model / client / provider breakdowns, and account balance.
---

The overview is a single fixed-layout page. From top to bottom it shows the time range and filters, a stat strip, the system status strip, the usage trend, breakdown sections, and account balance. Layout editing and widget management are no longer available; dashboard layouts configured before 1.4.0 are ignored and do not need manual cleanup.

## When to use it

| Scenario | What to inspect |
| --- | --- |
| Check gateway health | System status, success rate, errors |
| Estimate recent spend | Requests, total tokens, estimated cost |
| Compare upstream usage | Provider analysis, model breakdown, client analysis |
| Watch account quota | Balance, subscription quota, remaining quota, account status |

## Time range and filters

The `Usage over time` control at the top drives the stat strip, trend, and breakdown sections. After you switch ranges, requests, tokens, cost, and distributions are recomputed for the selected window.

| Option | Window |
| --- | --- |
| `Today` | Current local date from 00:00 to now, bucketed hourly. |
| `24h` | Last 24 hours, bucketed hourly. |
| `7d` | Last 7 days, bucketed daily. |
| `30d` | Last 30 days, bucketed daily. |
| `Custom` | Any start and end date, both inclusive. Click it, pick the two dates in the panel, then `Apply`. |

Two sections ignore the time range:

| Section | Behavior |
| --- | --- |
| System status strip | Always shows the last 90 days; see below. |
| Account balance | Shows the latest snapshot returned by provider account connectors. |

Below the range tabs are two filters: `Provider` lists only enabled gateway providers, and `Model` options follow the selected provider. The filters apply to the stat strip, trend, and breakdowns at the same time.

## Stat strip

The stat strip shows four numbers for the selected range and filters: requests, total tokens, estimated cost, and request success rate. The error count appears under the success rate; when there are requests, a one-line summary of requests and success rate follows the strip.

## System status strip

The system status strip always covers the last 90 days regardless of the selected range. Every provider with usage gets one row of daily ticks colored by outcome: OK, warning, error, or no requests. Hover or focus a tick to see its date, requests, and errors for that day.

The strip starts at the most recent day. Rows scroll in sync, the side buttons page through earlier history, and month boundaries are spaced out. The headline summarizes requests, success rate, and errors across the 90-day window. Without provider data, a single `API Service` row is shown.

## Usage trend

The trend chart follows the selected range: `Today` / `24h` use hourly points, while `7d` / `30d` / `Custom` use daily points. Hover a point to inspect that day's tokens, requests, cost, and per-model detail.

## Breakdowns

Breakdowns come in three sections: `Models`, `Client Analysis`, and `Provider Analysis`. Each section sorts by tokens, shows at most six rows, and folds the rest into `Other`; the section header shows the token and cost totals for that dimension.

Each row has an icon on the left (providers use their configured icon; models and clients are matched by brand), the name, request count, and share bar in the middle, and the token count with share on the right. Hovering a row opens a detail card with:

| Content | Description |
| --- | --- |
| Tokens and share | Row total and its share of the selected window. |
| Requests and cost | Request count and estimated cost for the row. |
| Input / output / cache split | Token counts and shares for the three parts; the cache share indicates cache hit behavior. |

The usage store groups rows by provider and model, so the same display name can arrive multiple times when a model is routed through different providers; the page merges them into one row before ranking.

## Account balance

The account balance section reads the account / usage connectors in provider configuration. To show a balance or remaining quota, enable and test `Fetch usage` in the provider settings first. Each account is one row with quota meters and status; the section can be refreshed as a whole, and an unconfigured state links to provider settings.

If the section is empty, check:

1. Whether the provider has an account / usage connector configured.
2. Whether the `Fetch usage` test succeeds.
3. Whether the API key or account endpoint is still valid.

## Reset statistics

The `Reset statistics` button in the toolbar clears the usage events behind the overview after a confirmation dialog. Resetting affects only overview statistics; request logs, providers, account connectors, and configuration are kept. Cleared data cannot be recovered.

## Data sources and troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Requests, tokens, or cost are 0 | No requests went through AgentRouter in the selected range or filters, or usage capture has not recorded them yet. | Switch to `24h` / `7d`, clear the provider / model filters, and confirm client traffic actually goes through AgentRouter. |
| Cost shows `$0.00` | The model has no pricing data, or usage is very small. | Check that the model catalog and provider model names match prices; values under 0.01 USD are shown with extra decimals. |
| Success rate or errors look unexpected | Only requests captured by AgentRouter are counted. | Compare with records on the Logs page. |
| Breakdowns are empty | Usage records are missing model, provider, or client information. | Confirm requests go through AgentRouter and upstream responses include token usage. |
| Account balance is empty | No account connector exists, or `Fetch usage` failed. | Test the account / usage field mapping in provider configuration. |

---
title: Logs and observability
pageTitle: Logs and observability
eyebrow: Detailed configuration
lead: Inspect model requests and agent execution traces, and configure log retention and payload sampling.
---

## How to enable

Open **Settings → Logs & Observability**:

1. Enable **Request logs** to record AgentRouter request details.
2. Enable **Agent observability** to populate the Observability page with agent execution traces.

## View the Observability page

Enable **Agent observability** when you need to inspect an agent's execution trace and performance. The Observability page shows which step called which tool, what result the tool returned, how long each step took, and where an agent may have stalled or failed.

It helps diagnose agents getting stuck, unexpected tool results, slow steps, or context flow that does not match expectations. Request logs provide the request body, response body, and error details for individual model requests.

## Request logs

Request logs record model request details passing through AgentRouter, including request time, request ID, client, path, requested model, resolved provider and model, credential, status code, success state, duration, tokens, cost estimate, request headers, request body, response headers, response body, and errors.

The Logs page supports filtering by status, provider, model, credential, request ID, model name, request body, or response body. A single record shows the main request and response fields, including `request model`, `resolved provider`, `resolved model`, status code, response body, errors, duration, tokens, and cost estimate.

Logs and Observability share the same request data. Set **Settings → Logs & Observability → Log retention days** to 1, 3, 7, 14, 30, 90, or 365 days; the default is 1 day. Retention uses elapsed 24-hour periods rather than a midnight reset. While the log writer is running, expiration is checked every minute and expired requests, related traces, and unreferenced payload files are removed.

## Body capture and sampling

Request body / response body logging is governed by three low-level config options (the defaults fit most cases):

| Option | Default | Description |
| --- | --- | --- |
| `requestLogBodyCapture` | `all` | Whether to record request and response bodies: `all` records all, `errors` records bodies only for failed requests, `none` records no bodies. |
| `requestLogMaxBodyBytes` | `52428800` (50 MiB) | In-memory body capture and preview budget for a single request or response body. File-backed raw trace bodies can exceed this limit; the full body is stored in sidecar storage and loaded on demand from the Logs page. |
| `requestLogSuccessSampleRate` | `1` | Sampling rate for successful requests, between `0` and `1`. `1` records all, `0.1` records roughly one in ten. |


## Timing and rates

| Metric | Calculation |
| --- | --- |
| First Token | Time from gateway request processing start to the first content delta. Unavailable for non-streaming requests. |
| Output rate | For streaming requests, `(output tokens − 1) / (total duration − time to first token)`, in seconds. Buffered delivery and short responses can inflate this estimate; it does not measure internal model generation speed. |
| Average throughput | `output tokens / total request duration in seconds`, including waiting time, for both streaming and non-streaming requests. |
| Duration | Total duration recorded for the request. |

Usage comes from the provider response. Output tokens may include reasoning tokens. Missing or invalid measurements display `-`.

## Disk usage

Retention covers request logs and the observability views derived from them. It does not expire agent conversation histories, plugins, browser caches, or Overview usage statistics. Payload storage grows with request volume and context size; a one-day retention period is not a fixed disk quota. SQLite may retain freed pages for reuse after deletion.

The configuration field is `observability.retentionDays`, from 1 to 365. The writer checks the saved setting once per minute; extending retention cannot restore deleted records.

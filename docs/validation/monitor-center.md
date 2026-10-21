# Monitor center acceptance

## Reference and scope

Compared CliRelay's full MonitorPage, toolbar, traffic, latency, failure, ranking, flow and heatmap components and its Go monitor range/detail/overview aggregation. This is an independent AgentRouter implementation using existing authenticated RPC, SQLite usage events, request-log metadata, React and Recharts. No CliRelay source or runtime dependency is imported.

Monitor center measures gateway requests. Local session usage remains in Overview/Usage; it cannot provide gateway status, TTFT or response reliability for requests that bypass the gateway.

## Features

- Exact rolling 1h, 6h, 24h, 7d, 14d and 30d; Today uses the selected IANA zone's midnight. Today comparison uses yesterday's matching wall-clock interval, including DST.
- Refresh off/15/30/60/300 seconds and manual refresh. Hidden tabs pause polling, overlapping refresh is suppressed, obsolete responses are ignored. Filters and timezone persist in URL; refresh preference persists locally.
- Model/channel/client multi-select, removable chips, clear all, ranking/flow drill-down. All sections share one query; recent live traffic always shows 60 minutes with those filters.
- Health score, live traffic, six headline metrics, four traffic modes, zoom slider, series toggles.
- Successful-request latency and streaming TTFT histograms/P50/P90/P95/P99; failure grouping and retained request detail.
- Sortable model performance/channel health/client ranking, flow Sankey and timezone-aware weekday/hour heatmap.
- Missing measured samples are unavailable, not zero. Price coverage and retained-log coverage remain explicit. Retried logs join to one final usage event, never additional requests.

## Verification

Core tests: 1,164 total, 1,158 passed, 6 skipped, 0 failed, including rolling/DST bounds, previous comparisons, exclusive end boundaries, percentile/histogram edges, duplicate final-log joining, missing logs, filters, and conservation across sections. The initial full run exposed a timing-dependent existing Fusion vision test's async publication ordering; the subsequent full run passed without altering that test.

UI tests: 295 passed. These include URL round-trip, missing-data health, and rendering all lower analysis sections. TypeScript and production web build checked.

Live authenticated RPC compared with independent read-only SQLite queries (captured 2026-10-21 06:36 UTC):

| Range | Requests | Failures | Tokens | P95 ms | RPC seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1h | 201 | 0 | 28,793,640 | 38,662 | 0.08 |
| 6h | 585 | 0 | 81,602,658 | 42,438 | 0.07 |
| 24h | 961 | 30 | 120,082,423 | 50,126 | 0.09 |
| 7d | 3,924 | 151 | 467,937,085 | 64,866 | 0.10 |
| 14d | 7,077 | 341 | 823,463,010 | 65,773 | 0.10 |
| 30d | 9,557 | 698 | 1,214,405,249 | 68,746 | 0.13 |

Shanghai Today: 585 requests from 16:00 UTC; Los Angeles Today: 947 from 07:00 UTC. Codex-only 24h: 694 requests. For each query, trend/rankings/flow/heatmap request totals equal the headline; token totals agree wherever exposed. P95 matches independently sorted successful duration samples.

Preview is a separate localhost web service with `--no-gateway`; the installed app and active gateway were not restarted. Historical request-log retention limits TTFT/streaming detail availability. These timings describe this local database, not a larger-scale benchmark.

Chrome interaction checks: timezone/Today boundary, client drill-down and clear, traffic tabs and legend, TTFT histogram, failure detail and Escape dismissal, automatic/manual refresh, and brush zoom preservation across refresh. Browser console had no errors. Final preview serves the real local database on localhost:13458 with authentication.

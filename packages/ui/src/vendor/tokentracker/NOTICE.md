# TokenTracker usage view

UsageOverview, provider icons, date selection, animated counters, formatting and
model aggregation are adapted from TokenTracker under LICENSE-TokenTracker.
Imported source hashes are recorded in upstream-files.json.

AgentRouter hosts the expanded view as a navigation page. The outer card and
expand-to-modal layer are removed, tool selection keeps model details visible,
and data comes through AgentRouter's local collector API. Claude, Codex and Grok context analysis uses the original nested drill-down panel.
Cloud-sharing controls are not connected here. Theme and locale follow the host;
costs are displayed in USD. No TokenTracker login or cloud sync is initialized.

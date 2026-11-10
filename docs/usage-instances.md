# Usage instances

The Usage page filters local usage by client and configuration instance. Claude
Code and Claude desktop can share the Claude log format while using separate
configuration roots. A custom directory can be named in Settings → Data sources;
managed roots use the Agent profile name. Names are local settings.

The existing rolling periods remain unchanged: Week means the previous seven
days, not the current calendar week. Use a custom date range for calendar weeks.
Token totals, estimated costs and model details use the same selected scope.

## Attribution and migration

- Instance identity is a hash of client plus canonical configuration root. Codex
  sessions and archived sessions under the same root share one instance.
- Internal queue source keys retain instance identity until snapshot deduplication
  finishes. Public aggregates expose the original client source and an optional
  instance ID; existing consumers continue to receive combined client totals.
- Parsing still shares event identities across roots. Adding aliases, overlapping
  directories or copies must not multiply the same recorded usage.
- A one-time rebuild replays available Claude/Codex logs through the existing
  parsers. Previously collected history with no readable original stays in the
  explicit Unattributed scope. It is not assigned to a client instance by guess.
- Queue replacement precedes the cursor schema marker. A retry after interruption
  replaces the same snapshots rather than adding another copy.
- Collector queues, cursors, instance manifests and names are local data and must
  be included in a backup before installing this migration.

Changing a label does not rescan logs. Disabling/removing a collection root stops
future collection and retains historical usage and its instance selector.

## Validation

Collector regressions cover separate roots, aliases, copied sessions, incremental
updates, Codex cumulative/cache counts, migration retry and unavailable history.
Browser regressions cover client/instance/period changes, label editing without
collection, and the overview model selector retaining locally observed models.

Before/after UI captures are written to `output/usage-instances/` and
`output/overview-model-filter/` in light, dark and narrow layouts. Run the layout
tests with `AR_CAPTURE_BEFORE=1` before committing to capture the previous revision.

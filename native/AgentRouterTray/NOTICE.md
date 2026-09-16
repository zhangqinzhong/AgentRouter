# TokenTracker native menu

The native views, view model, companion animation state machine, menu and
popover controllers, chart interactions, quota settings and supporting models
are adapted from TokenTracker by xiufengsun under the MIT license in
LICENSE-TokenTracker. Vortex retains its own package license.

Source: https://github.com/xiufengsun/TokenTracker

AgentRouter replaces the data transport and application actions. A dedicated worker reuses TokenTracker's local session parsers, aggregate
queries and provider quota readers. It does not start a separate local web
server, install hooks, send telemetry or enable cloud sync.
The native menu uses a fixed layout. Backend values without corresponding quota semantics
are omitted. Quota windows retain the provider-reported durations.

`upstream-files.json` records the imported source hashes.
`node build/check-native-parity.mjs` checks view and interaction parity,
allowing resource-bundle relocation and branding changes.

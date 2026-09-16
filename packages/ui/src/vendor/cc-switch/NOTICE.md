# cc-switch routing controls

Adapted from cc-switch (MIT, Jason Young); source hashes are in upstream-files.json.

RoutingActivationBrand retains the original timing and particle definitions. The label is AgentRouter and has no external link. ProxyToggle receives gateway state through props instead of the Tauri takeover hook; its signal icon also opens endpoint details. Switch is copied unchanged. Window activity uses browser focus events in Electron instead of Tauri events.

routing.css is generated with the original Tailwind 3 theme, scoped under cc-routing-scope. preflight.css contains the corresponding transform and shadow defaults. These avoid differences from the host Tailwind 4 theme; neither requires the cc-switch checkout at runtime.

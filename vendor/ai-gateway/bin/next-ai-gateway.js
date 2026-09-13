#!/usr/bin/env node

// The AgentRouter build bundles ../src/index.ts through this shim so the emitted
// runtime keeps the `next-ai-gateway.js` entry name the supervisor resolves.
// For standalone use run `npm run build -w @the-next-ai/ai-gateway` and start
// `dist/index.js` directly.
require("../src/index.ts");

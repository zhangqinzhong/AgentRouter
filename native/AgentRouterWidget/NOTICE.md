# AgentRouter WidgetKit extension

The summary, heatmap, model ranking and quota widgets are adapted from
TokenTracker under the MIT license in LICENSE-TokenTracker. Original source
hashes are recorded in upstream-files.json.

The extension reads the same WidgetSnapshot model written by the native menu
helper. It has sandbox permission only, with no network-client entitlement.
The host updates its snapshot during refreshes; the extension requests a
15-minute timeline refresh and keeps the last snapshot when the host is closed.

Local builds retain TokenTracker's sandbox-container fallback for installations
without a provisioned App Group. The container identifier is
com.agentrouter.desktop.widget. No session bodies or authentication credentials
are written into the snapshot. The host helper uses its five-minute background
refresh cycle when it cannot enumerate the containing app's widgets.

build/native-widget.mjs generates the Xcode project and builds both Apple Silicon
and Intel slices. electron-builder embeds the extension under Contents/PlugIns;
build/sign-mac.cjs signs it with the containing app's identity and its own sandbox
entitlements. Installing the app and adding a widget are needed to verify system
registration and rendering.

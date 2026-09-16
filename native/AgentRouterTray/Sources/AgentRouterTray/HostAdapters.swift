import AppKit
import SwiftUI

func emit(_ event: String, _ value: String = "") {
 guard let data = try? JSONSerialization.data(withJSONObject: ["event":event,"value":value]) else { return }
 FileHandle.standardOutput.write(data + Data([10]))
}
@MainActor final class ServerManager: ObservableObject {
 enum Status { case idle, starting, running, failed(String) }
 @Published var status: Status = .running
 var isServerRunning: Bool { if case .running = status { return true }; return false }
 func ensureServerRunning() async { status = .running }
 func retry() async { status = .running; emit("refresh") }
 func stopServer() {}
}
@MainActor final class LaunchAtLoginManager: ObservableObject {
 @Published var isEnabled = false
 var isSupported: Bool { true }
 func toggle() { emit("launchAtLogin", isEnabled ? "false" : "true") }
 func refresh() {}
}
@MainActor final class NativeBridge {
 static let shared = NativeBridge()
 func pushSettings() { emit("showStats", UserDefaults.standard.bool(forKey:"MenuBarShowStats") ? "true" : "false") }
 func pushPetSettings() { emit("preferences") }
}
@MainActor final class DashboardPresentationCoordinator {
 static let shared = DashboardPresentationCoordinator()
 func showDashboard() { emit("open") }
}
@MainActor final class DashboardWindowController {
 static let shared = DashboardWindowController()
 func showSettings() { emit("settings") }
}
@MainActor final class UpdateChecker: NSObject {
 static let shared = UpdateChecker()
 var statusText: String? { nil }
 var isBusy: Bool { false }
 func currentVersion() -> String { ProcessInfo.processInfo.environment["AR_APP_VERSION"] ?? "" }
 func check(silent: Bool) { if !silent { emit("update") } }
}
extension Notification.Name { static let updateCheckerStatusDidChange = Notification.Name("AgentRouterUpdateStatusChanged") }
func agentRouterTemplateImage() -> NSImage? {
 let directory = URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent()
 let image = NSImage(size:NSSize(width:20,height:20))
 for suffix in ["","@2x","@3x"] {
  let url=directory.appendingPathComponent("tray-layeredTemplate\(suffix).png")
  if let data=try? Data(contentsOf:url),let rep=NSBitmapImageRep(data:data) { rep.size=NSSize(width:20,height:20);image.addRepresentation(rep) }
 }
 image.isTemplate=true
 return image.representations.isEmpty ? nil : image
}
extension NativeTransport {
    func readyResources() -> String { Bundle.module.bundlePath }
}

@MainActor final class NativeMenuPreferences: ObservableObject {
 static let shared = NativeMenuPreferences()
 @Published var petEnabled = true
}

import AppKit
import Foundation

struct Request: Decodable {
    let version: Int
    let bundlePath: String
    let arguments: [String]
    let environment: [String: String]
}
func finish(_ value: [String: Any], _ code: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
    exit(code)
}
let request: Request
do {
    request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
    guard request.version == 1, request.bundlePath.hasPrefix("/"), request.bundlePath.hasSuffix(".app"),
          Bundle(url: URL(fileURLWithPath: request.bundlePath))?.executableURL != nil else {
        throw NSError(domain: "AgentRouter.AppLauncher", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "A valid absolute application bundle path is required."])
    }
} catch {
    finish(["version": 1, "error": error.localizedDescription], 1)
}
let url = URL(fileURLWithPath: request.bundlePath).resolvingSymlinksInPath()
let existing = Set(NSWorkspace.shared.runningApplications.map { $0.processIdentifier })
let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
configuration.activates = true
configuration.arguments = request.arguments
configuration.environment = request.environment
NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    if let error = error { finish(["version": 1, "error": error.localizedDescription], 1) }
    guard let app = app, app.processIdentifier > 0, !app.isTerminated,
          app.bundleURL?.resolvingSymlinksInPath() == url,
          !existing.contains(app.processIdentifier) else {
        finish(["version": 1, "error": "LaunchServices did not return a new application instance."], 1)
    }
    finish(["version": 1, "pid": Int(app.processIdentifier), "bundlePath": url.path], 0)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    finish(["version": 1, "error": "LaunchServices launch timed out; check the profile before retrying."], 1)
}
RunLoop.main.run()

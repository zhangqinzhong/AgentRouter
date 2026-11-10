import Foundation
import Testing
@testable import AIMemoryMenuCore

struct LaunchdControllerTests {
    @Test func substitutesPlaceholders() {
        let template = """
        <string>__AI_MEMORY_BIN__</string>
        <string>__HOME__/Library/Logs/ai-memory/stderr.log</string>
        """
        let rendered = LaunchdController.renderTemplate(
            template,
            binary: URL(fileURLWithPath: "/Applications/AI Memory.app/Contents/Resources/runtime/ai-memory"),
            home: URL(fileURLWithPath: "/Users/ada"),
            dataDir: nil
        )
        #expect(rendered.contains("/Applications/AI Memory.app/Contents/Resources/runtime/ai-memory"))
        #expect(rendered.contains("/Users/ada/Library/Logs/ai-memory/stderr.log"))
        #expect(!rendered.contains("__AI_MEMORY_BIN__"))
        #expect(!rendered.contains("EnvironmentVariables"))
    }

    @Test func injectsDataDirEnvironment() {
        let template = """
        <dict>
          <key>Label</key>
          <string>com.github.akitaonrails.ai-memory</string>
        </dict>
        """
        let rendered = LaunchdController.renderTemplate(
            template,
            binary: URL(fileURLWithPath: "/bin/ai-memory"),
            home: URL(fileURLWithPath: "/Users/ada"),
            dataDir: URL(fileURLWithPath: "/Users/ada/.ai-memory")
        )
        #expect(rendered.contains("<key>AI_MEMORY_DATA_DIR</key>"))
        #expect(rendered.contains("<string>/Users/ada/.ai-memory</string>"))
        #expect(rendered.contains("<key>EnvironmentVariables</key>"))
    }

    @Test func rendersCheckedInLaunchdTemplate() throws {
        let templateURL = repoRoot()
            .appending(path: "packaging/launchd/com.github.akitaonrails.ai-memory.plist")
        let template = try String(contentsOf: templateURL, encoding: .utf8)
        let binary = URL(fileURLWithPath: "/Applications/AI Memory.app/Contents/Resources/runtime/ai-memory")
        let home = URL(fileURLWithPath: "/Users/ada")
        let rendered = LaunchdController.renderTemplate(template, binary: binary, home: home, dataDir: nil)
        #expect(LaunchdController.programArgumentsBinary(inPlist: rendered) == binary.path)
        #expect(rendered.contains("/Users/ada/Library/Logs/ai-memory/stderr.log"))
        #expect(rendered.contains("serve"))
        #expect(rendered.contains("--enable-web"))
        #expect(!rendered.contains("__HOME__"))
    }

    @Test func xmlEscapesDataDir() {
        let template = "<dict></dict>"
        let rendered = LaunchdController.renderTemplate(
            template,
            binary: URL(fileURLWithPath: "/bin/ai-memory"),
            home: URL(fileURLWithPath: "/Users/ada"),
            dataDir: URL(fileURLWithPath: "/tmp/a&b<c>")
        )
        #expect(rendered.contains("/tmp/a&amp;b&lt;c&gt;"))
    }

    @Test func pathsRoundTripThroughTheInstalledPlist() throws {
        let templateURL = repoRoot()
            .appending(path: "packaging/launchd/com.github.akitaonrails.ai-memory.plist")
        let template = try String(contentsOf: templateURL, encoding: .utf8)
        let root = FileManager.default.temporaryDirectory
            .appending(path: "ai-memory-plist-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appending(path: "Ada & Bob <home>")
        let binary = root.appending(path: "R&D/AI Memory.app/Contents/Resources/runtime/ai-memory")
        let dataDir = home.appending(path: "Memory & Notes")
        let controller = LaunchdController(home: home)

        try controller.writePlist(template: template, binary: binary, dataDir: dataDir)

        let data = try Data(contentsOf: controller.plistDestination)
        let plist = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )
        #expect(plist["ProgramArguments"] as? [String] == [binary.path, "serve", "--transport", "http", "--enable-web"])
        #expect(plist["StandardOutPath"] as? String == home.appending(path: "Library/Logs/ai-memory/stdout.log").path)
        #expect(plist["StandardErrorPath"] as? String == home.appending(path: "Library/Logs/ai-memory/stderr.log").path)
        #expect(plist["EnvironmentVariables"] as? [String: String] == ["AI_MEMORY_DATA_DIR": dataDir.path])
        #expect(LaunchdController.programArgumentsBinary(inPlist: String(decoding: data, as: UTF8.self)) == binary.path)
    }

    @Test func readsDecodedProgramArgumentsFromPlist() {
        let plist = """
        <plist version="1.0"><dict><key>ProgramArguments</key><array>
        <string>/Applications/R&amp;D/AI Memory.app/ai-memory</string><string>serve</string>
        </array></dict></plist>
        """
        #expect(LaunchdController.programArgumentsBinary(inPlist: plist) == "/Applications/R&D/AI Memory.app/ai-memory")
        #expect(LaunchdController.programArgumentsBinary(inPlist: "not a plist") == nil)
        #expect(LaunchdController.programArgumentsBinary(inPlist: "<plist version=\"1.0\"><dict/></plist>") == nil)
    }
}

private func repoRoot(file: String = #filePath) -> URL {
    URL(fileURLWithPath: file)
        .deletingLastPathComponent() // Tests/AIMemoryMenuTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // companions/ai-memory-macos
        .deletingLastPathComponent() // companions
        .deletingLastPathComponent() // repo
}

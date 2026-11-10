import Foundation

public struct ProcessResult: Equatable, Sendable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }

    public var combinedOutput: String {
        let out = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let err = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if err.isEmpty {
            return out
        }
        if out.isEmpty {
            return err
        }
        return out + "\n" + err
    }
}

public protocol CommandRunning: Sendable {
    func run(binary: URL, arguments: [String], extraEnv: [String: String]) throws -> ProcessResult
}

public struct ProcessRunner: CommandRunning {
    public var timeout: TimeInterval

    public init(timeout: TimeInterval = 30) {
        self.timeout = timeout
    }

    public func run(binary: URL, arguments: [String], extraEnv: [String: String]) throws -> ProcessResult {
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        var env = ProcessInfo.processInfo.environment
        for (key, value) in extraEnv {
            env[key] = value
        }
        process.environment = env

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()

        // A child can fill either pipe before exiting, so both must be drained
        // while the timeout loop waits for it.
        let outReader = ProcessOutput(stdout.fileHandleForReading)
        let errReader = ProcessOutput(stderr.fileHandleForReading)
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            throw CliError.timeout
        }

        return ProcessResult(
            exitCode: process.terminationStatus,
            stdout: String(data: outReader.read(), encoding: .utf8) ?? "",
            stderr: String(data: errReader.read(), encoding: .utf8) ?? ""
        )
    }
}

private final class ProcessOutput: @unchecked Sendable {
    private let completed = DispatchGroup()
    private let lock = NSLock()
    private var data = Data()

    init(_ handle: FileHandle) {
        completed.enter()
        DispatchQueue.global().async {
            let output = handle.readDataToEndOfFile()
            self.lock.withLock { self.data = output }
            self.completed.leave()
        }
    }

    func read() -> Data {
        completed.wait()
        return lock.withLock { data }
    }
}

public enum CliError: Error, Equatable, Sendable {
    case timeout
    case missingRuntime
    case failed(Int32, String)
}

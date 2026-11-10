import Foundation
import Testing
@testable import AIMemoryMenuCore

struct ProcessRunnerTests {
    @Test func drainsBothPipesWhileTheChildRuns() throws {
        let result = try ProcessRunner(timeout: 5).run(
            binary: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2"],
            extraEnv: [:]
        )
        #expect(result.exitCode == 0)
        #expect(result.stdout.utf8.count == 1048576)
        #expect(result.stderr.utf8.count == 1048576)
    }

    @Test func preservesTextEnvironmentAndExitStatus() throws {
        let result = try ProcessRunner().run(
            binary: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "printf '%s' \"$AI_MEMORY_RUNNER_TEST\"; printf 'diagnostic\\n' >&2; exit 7"],
            extraEnv: ["AI_MEMORY_RUNNER_TEST": "memória 支付\n"]
        )
        #expect(result == ProcessResult(exitCode: 7, stdout: "memória 支付\n", stderr: "diagnostic\n"))
    }

    @Test func stillTimesOutForAChildThatDoesNotExit() {
        #expect(throws: CliError.timeout) {
            try ProcessRunner(timeout: 0.1).run(
                binary: URL(fileURLWithPath: "/bin/sleep"),
                arguments: ["5"],
                extraEnv: [:]
            )
        }
    }
}

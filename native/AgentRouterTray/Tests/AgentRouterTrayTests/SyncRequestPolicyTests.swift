import XCTest
@testable import AgentRouterTray

final class SyncRequestPolicyTests: XCTestCase {
    func testStartsManualSyncWhenIdle() {
        XCTAssertEqual(
            SyncRequestPolicy.manualRequestDisposition(
                syncInFlight: false,
                isSyncing: false
            ),
            .start
        )
    }

    func testQueuesManualSyncBehindSilentPopoverSync() {
        XCTAssertEqual(
            SyncRequestPolicy.manualRequestDisposition(
                syncInFlight: true,
                isSyncing: false
            ),
            .queueAfterSilentSync
        )
    }

    func testCoalescesManualSyncWithVisibleSync() {
        XCTAssertEqual(
            SyncRequestPolicy.manualRequestDisposition(
                syncInFlight: true,
                isSyncing: true
            ),
            .coalesceWithVisibleSync
        )
    }
}

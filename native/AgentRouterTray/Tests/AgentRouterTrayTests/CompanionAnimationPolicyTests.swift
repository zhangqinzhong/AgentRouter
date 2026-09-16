import XCTest
@testable import AgentRouterTray

final class CompanionAnimationPolicyTests: XCTestCase {
    func testPopoverAnimationTracksPopoverVisibility() {
        XCTAssertFalse(
            CompanionAnimationPolicy.isVisible(
                surface: .popover,
                isPopoverVisible: false,
                isFloatingPetVisible: true
            )
        )
        XCTAssertTrue(
            CompanionAnimationPolicy.isVisible(
                surface: .popover,
                isPopoverVisible: true,
                isFloatingPetVisible: false
            )
        )
    }

    func testFloatingAnimationTracksFloatingWindowVisibility() {
        XCTAssertFalse(
            CompanionAnimationPolicy.isVisible(
                surface: .floatingPet,
                isPopoverVisible: true,
                isFloatingPetVisible: false
            )
        )
        XCTAssertTrue(
            CompanionAnimationPolicy.isVisible(
                surface: .floatingPet,
                isPopoverVisible: false,
                isFloatingPetVisible: true
            )
        )
    }

    func testTimelinePausesWhenSurfaceIsHidden() {
        XCTAssertTrue(
            CompanionAnimationPolicy.shouldPauseTimeline(
                surface: .popover,
                isPopoverVisible: false,
                isFloatingPetVisible: true,
                isStaticFrame: false
            )
        )
    }

    func testTimelineRunsForVisibleAnimatedFrame() {
        XCTAssertFalse(
            CompanionAnimationPolicy.shouldPauseTimeline(
                surface: .popover,
                isPopoverVisible: true,
                isFloatingPetVisible: false,
                isStaticFrame: false
            )
        )
    }

    func testStaticFrameStaysPausedWhileVisible() {
        XCTAssertTrue(
            CompanionAnimationPolicy.shouldPauseTimeline(
                surface: .floatingPet,
                isPopoverVisible: false,
                isFloatingPetVisible: true,
                isStaticFrame: true
            )
        )
    }
}

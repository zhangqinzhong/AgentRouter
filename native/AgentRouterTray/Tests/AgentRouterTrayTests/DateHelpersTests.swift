import XCTest
@testable import AgentRouterTray

final class DateHelpersTests: XCTestCase {

    func testDayRangeEndsAtProvidedCaptureDate() {
        let range = DateHelpers.dayRange(daysBack: 6, endingAt: makeCaptureDate())

        XCTAssertEqual("\(range.from)...\(range.to)", "2026-08-04...2026-08-10")
    }

    func testPeriodRangeUsesProvidedCaptureDate() {
        let range = DateHelpers.rangeForPeriod(.day, referenceDate: makeCaptureDate())

        XCTAssertEqual("\(range.from)...\(range.to)", "2026-08-10...2026-08-10")
    }

    private func makeCaptureDate() -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(
            from: DateComponents(
                year: 2026,
                month: 8,
                day: 10,
                hour: 23,
                minute: 59,
                second: 59
            )
        )!
    }
}

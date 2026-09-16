@testable import AgentRouterTray
import XCTest

final class WidgetSnapshotTests: XCTestCase {

    func testYesterdayDeltaIsUnavailableWhenDailyTrendSkipsYesterday() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2026, month: 8, day: 10),
            today: PeriodTotals(tokens: 200),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 7),
                    totalTokens: 100,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2026, month: 8, day: 10),
                    totalTokens: 200,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 0)
        XCTAssertNil(snapshot.todayDeltaPercent)
    }

    func testYesterdayUsesTheSnapshotGenerationDate() {
        let snapshot = WidgetSnapshot(
            generatedAt: date(year: 2024, month: 2, day: 10),
            today: PeriodTotals(tokens: 150),
            dailyTrend: [
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 9),
                    totalTokens: 75,
                    costUsd: 0
                ),
                DailyPoint(
                    day: date(year: 2024, month: 2, day: 10),
                    totalTokens: 150,
                    costUsd: 0
                ),
            ]
        )

        XCTAssertEqual(snapshot.yesterdayTokens, 75)
        XCTAssertEqual(snapshot.todayDeltaPercent, 100)
    }

    private func date(year: Int, month: Int, day: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }
}

extension WidgetSnapshotTests {
    func testSnapshotRoundTripAndNewestFallback() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let shared = directory.appendingPathComponent("shared.json")
        let fallback = directory.appendingPathComponent("fallback.json")
        let old = WidgetSnapshot(generatedAt: Date(timeIntervalSince1970: 100), today: PeriodTotals(tokens: 10))
        let new = WidgetSnapshot(generatedAt: Date(timeIntervalSince1970: 200), today: PeriodTotals(tokens: 20))
        XCTAssertTrue(WidgetSnapshotStore.write(old, to: [shared]))
        XCTAssertTrue(WidgetSnapshotStore.write(new, to: [fallback]))
        XCTAssertEqual(WidgetSnapshotStore.read(from: [shared, fallback]), new)
        try Data("invalid".utf8).write(to: shared)
        XCTAssertEqual(WidgetSnapshotStore.read(from: [shared, fallback]), new)
    }
}

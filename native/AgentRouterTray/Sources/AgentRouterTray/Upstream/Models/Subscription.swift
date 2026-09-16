import Foundation

// MARK: - SubscriptionRecord

struct SubscriptionRecord: Codable, Equatable, Identifiable {
    let id: String
    let service: String
    let plan: String?
    let provider: String?
    let autoRenew: Bool
    let cycle: String
    let nextBillingAt: String
    let startedAt: String?
    let createdAt: String?
    let updatedAt: String?
}

struct SubscriptionListResponse: Codable {
    let subscriptions: [SubscriptionRecord]?
}

// MARK: - Subscription Cycle View

struct SubscriptionCycleView {
    let startMs: Double
    let endMs: Double
    let progress: Double
    let cycleDays: Int
    let expired: Bool
}

enum SubscriptionCycle {
    private static let dayMs: Double = 86400000

    static func addMonthsUtc(ms: Double, months: Int) -> Double {
        let date = Date(timeIntervalSince1970: ms / 1000.0)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        guard let year = comps.year, let month = comps.month else { return ms }
        let day = comps.day ?? 1
        let hour = comps.hour ?? 0
        let minute = comps.minute ?? 0
        var targetComps = DateComponents()
        targetComps.year = year
        targetComps.month = month + months
        targetComps.day = 1
        targetComps.hour = hour
        targetComps.minute = minute
        targetComps.second = 0
        targetComps.timeZone = TimeZone(secondsFromGMT: 0)
        guard let target = cal.date(from: targetComps) else { return ms }
        let daysInTarget = daysInMonth(year: targetComps.year!, month: targetComps.month!)
        let clampedDay = min(day, daysInTarget)
        var finalComps = targetComps
        finalComps.day = clampedDay
        guard let final = cal.date(from: finalComps) else { return target.timeIntervalSince1970 * 1000.0 }
        return final.timeIntervalSince1970 * 1000.0
    }

    private static func daysInMonth(year: Int, month: Int) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        comps.timeZone = TimeZone(secondsFromGMT: 0)
        guard let date = cal.date(from: comps),
              let range = cal.range(of: .day, in: .month, for: date) else { return 30 }
        return range.count
    }

    static func cycleStartMs(endMs: Double, cycle: String) -> Double {
        if cycle == "weekly" { return endMs - 7 * dayMs }
        if cycle == "yearly" { return addMonthsUtc(ms: endMs, months: -12) }
        let end = Date(timeIntervalSince1970: endMs / 1000.0)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: end)
        guard let year = comps.year, let month = comps.month, let hour = comps.hour, let minute = comps.minute else { return endMs - 30 * dayMs }
        let day = comps.day ?? 1
        let prevMonth = month - 1
        var prevYear = year
        var pm = prevMonth
        if pm < 1 { pm += 12; prevYear -= 1 }
        let daysInPrevMonth = daysInMonth(year: prevYear, month: pm)
        let clampedDay = min(day, daysInPrevMonth)
        var startComps = DateComponents()
        startComps.year = year
        startComps.month = month - 1
        startComps.day = 1
        startComps.hour = hour
        startComps.minute = minute
        startComps.timeZone = TimeZone(secondsFromGMT: 0)
        guard let startBase = cal.date(from: startComps) else { return endMs - 30 * dayMs }
        var finalComps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: startBase)
        finalComps.day = clampedDay
        finalComps.timeZone = TimeZone(secondsFromGMT: 0)
        guard let final = cal.date(from: finalComps) else { return startBase.timeIntervalSince1970 * 1000.0 }
        return final.timeIntervalSince1970 * 1000.0
    }

    static func cycleEndFromStart(startMs: Double, cycle: String) -> Double {
        if cycle == "weekly" { return startMs + 7 * dayMs }
        if cycle == "yearly" { return addMonthsUtc(ms: startMs, months: 12) }
        return addMonthsUtc(ms: startMs, months: 1)
    }

    private static func billingAnchorMs(subscription: SubscriptionRecord, cycle: String, recordedEndMs: Double) -> Double {
        if let started = subscription.startedAt, let startedMs = parseDateMs(started) {
            return startedMs
        }
        return cycleStartMs(endMs: recordedEndMs, cycle: cycle)
    }

    static func cycleView(subscription: SubscriptionRecord, nowMs: Double) -> SubscriptionCycleView? {
        guard let recordedEndMs = parseDateMs(subscription.nextBillingAt) else { return nil }
        let cycle = ["weekly", "monthly", "yearly"].contains(subscription.cycle) ? subscription.cycle : "monthly"
        let anchorMs = billingAnchorMs(subscription: subscription, cycle: cycle, recordedEndMs: recordedEndMs)
        guard anchorMs.isFinite else { return nil }

        var startMs: Double
        var endMs: Double
        var expired = false
        if subscription.autoRenew {
            let w = currentCycleWindow(anchorMs: anchorMs, cycle: cycle, nowMs: nowMs)
            startMs = w.startMs
            endMs = w.endMs
        } else if subscription.startedAt != nil {
            startMs = anchorMs
            endMs = cycleEndFromStart(startMs: anchorMs, cycle: cycle)
            expired = endMs <= nowMs
        } else {
            startMs = anchorMs
            endMs = recordedEndMs
            expired = endMs <= nowMs
        }
        let span = max(1, endMs - startMs)
        let progress = expired ? 1.0 : max(0, min(1, (nowMs - startMs) / span))
        let cycleDays = max(1, Int((span / dayMs).rounded()))
        return SubscriptionCycleView(startMs: startMs, endMs: endMs, progress: progress, cycleDays: cycleDays, expired: expired)
    }

    private static func currentCycleWindow(anchorMs: Double, cycle: String, nowMs: Double) -> (startMs: Double, endMs: Double) {
        if cycle == "weekly" {
            let span = 7 * dayMs
            let index = nowMs <= anchorMs ? 0 : Int(floor((nowMs - anchorMs) / span))
            return (anchorMs + Double(index) * span, anchorMs + Double(index + 1) * span)
        }
        let step = cycle == "yearly" ? 12 : 1
        let avgStepMs = Double(step) * 30.436875 * dayMs
        var index = nowMs <= anchorMs ? 0 : Int(floor((nowMs - anchorMs) / avgStepMs))
        while index > 0 && addMonthsUtc(ms: anchorMs, months: index * step) > nowMs {
            index -= 1
        }
        var guardCount = 0
        while addMonthsUtc(ms: anchorMs, months: (index + 1) * step) <= nowMs && guardCount < 12000 {
            index += 1
            guardCount += 1
        }
        return (addMonthsUtc(ms: anchorMs, months: index * step), addMonthsUtc(ms: anchorMs, months: (index + 1) * step))
    }

    static func parseDateMs(_ iso: String) -> Double? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmt.date(from: iso) { return d.timeIntervalSince1970 * 1000.0 }
        fmt.formatOptions = [.withInternetDateTime]
        if let d = fmt.date(from: iso) { return d.timeIntervalSince1970 * 1000.0 }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(secondsFromGMT: 0)
        df.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX"
        if let d = df.date(from: iso) { return d.timeIntervalSince1970 * 1000.0 }
        df.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        if let d = df.date(from: iso) { return d.timeIntervalSince1970 * 1000.0 }
        return nil
    }

    static func remainingLabel(endMs: Double, nowMs: Double) -> String {
        let diff = endMs - nowMs
        if diff <= 0 { return Strings.subscriptionExpired }
        let totalMinutes = Int(ceil(diff / 60000.0))
        if totalMinutes < 60 { return "\(totalMinutes)m" }
        let totalHours = totalMinutes / 60
        if totalHours < 24 { return "\(totalHours)h" }
        return "\(totalHours / 24)d"
    }
}

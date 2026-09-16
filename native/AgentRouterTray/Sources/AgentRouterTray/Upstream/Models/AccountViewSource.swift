import Foundation

/// Where one popover dataset actually came from, as reported by the local
/// server through `X-TokenTracker-Account-View` (+ `X-TokenTracker-Account-Fallback`).
///
/// The distinction that matters: the local server answers `?account=1` with
/// this-machine data both when that is genuinely the user's scope (signed out,
/// cloud sync off) and when a cloud read merely failed (timeout, offline,
/// token refresh error). Both used to arrive as an indistinguishable HTTP 200,
/// so a single slow cloud read silently shrank the popover's Activity heatmap
/// from every device to this Mac until the next manual sync.
enum AccountViewSource: Equatable {
    /// Cross-device account aggregate.
    case account
    /// This-machine data, and that is the correct scope right now.
    case localAuthoritative(reason: String)
    /// This-machine data only because the cloud read failed. Whatever account
    /// snapshot we already hold is still the better answer.
    case localTransient(reason: String)

    var isAccount: Bool { self == .account }

    var isTransientFallback: Bool {
        if case .localTransient = self { return true }
        return false
    }

    /// Diagnostic label — safe to log (no tokens, no usage figures).
    var reason: String {
        switch self {
        case .account: return "account"
        case .localAuthoritative(let reason): return reason
        case .localTransient(let reason): return reason
        }
    }

    /// Parse the pair of response headers. Returns nil when the server did not
    /// tag the response at all, which means it never ran the account path.
    static func parse(accountView: String?, fallback: String?) -> AccountViewSource? {
        switch accountView {
        case "1":
            return .account
        case "0":
            let reason = (fallback ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // Any `transient-*` reason is a temporary cloud failure. Matching on
            // the prefix lets the server add reasons without a client change.
            if reason.hasPrefix("transient") { return .localTransient(reason: reason) }
            // An older embedded/global server sends no fallback header. Treating
            // the absence as authoritative keeps the pre-fix behaviour.
            return .localAuthoritative(reason: reason.isEmpty ? "unspecified" : reason)
        default:
            return nil
        }
    }

    /// Publication authority for the menu-bar summary slots.
    var summaryViewSource: UsageSummaryViewSource {
        self == .account ? .accountUpload : .localQueue
    }
}

/// A decoded payload plus the authority it was served with.
struct AccountFetchResult<Value> {
    let value: Value
    let source: AccountViewSource
    let completedAt: Date
}

/// Per-dataset guard against silently downgrading an account (cross-device)
/// view to this-machine data because one cloud read failed.
struct AccountViewStateStore {
    enum Dataset: Hashable, CaseIterable {
        case todaySummary
        case periodSummary
        case rollingSummary
        case totalSummary
        case daily
        case hourly
        case monthly
        case heatmap
        case modelBreakdown
    }

    /// Identifies the query a dataset's authority was recorded for.
    ///
    /// Authority is only meaningful for the exact scope it was observed on.
    /// `.periodSummary` / `.modelBreakdown` / `.monthly` follow the selected
    /// period, and the day-scoped views follow the calendar day. Without this,
    /// a retained account snapshot from the previous period outranks a fresh
    /// response for the new one, and the panel keeps last period's numbers
    /// under this period's label.
    ///
    /// Windows that merely slide (rolling 30d, all-time, the year heatmap) use
    /// a constant scope on purpose: there the one-day shift is a rounding
    /// difference, and rekeying them at midnight would hand a transient cloud
    /// failure a fresh chance to downgrade an account view to this machine.
    enum Scope {
        static let rolling30 = "rolling30"
        static let total = "total"
        static let daily30 = "daily30"
        static let heatmap = "heatmap"
        static func day(_ day: String) -> String { "day:\(day)" }
        static func range(_ from: String, _ to: String) -> String { "range:\(from)..\(to)" }
    }

    private struct Record {
        let source: AccountViewSource
        let scope: String
    }

    private var recordByDataset: [Dataset: Record] = [:]
    private(set) var degradedDatasets: Set<Dataset> = []

    /// True while at least one dataset is running on (or holding onto data
    /// because of) a transient cloud failure.
    var isDegraded: Bool { !degradedDatasets.isEmpty }

    /// True when this dataset is currently *showing* this-machine data only
    /// because the cloud is unreachable — i.e. cold start with no account
    /// snapshot to fall back on.
    func showsTransientLocalData(_ dataset: Dataset) -> Bool {
        recordByDataset[dataset]?.source.isTransientFallback ?? false
    }

    /// Decide whether an incoming payload should replace what is on screen.
    /// - Parameter scope: identifies the query this response answers. A record
    ///   held for a different scope describes data the view no longer asks for.
    /// - Parameter hasExistingValue: whether the view model already holds a
    ///   rendered payload for this dataset.
    /// - Returns: true to publish the new payload, false to keep the old one.
    mutating func shouldAdopt(
        _ source: AccountViewSource,
        for dataset: Dataset,
        scope: String,
        hasExistingValue: Bool
    ) -> Bool {
        // Drop authority recorded for a scope the view has since left, so the
        // retained-snapshot rule below can never answer for the wrong period.
        if let record = recordByDataset[dataset], record.scope != scope {
            recordByDataset.removeValue(forKey: dataset)
            degradedDatasets.remove(dataset)
        }
        guard source.isTransientFallback else {
            degradedDatasets.remove(dataset)
            recordByDataset[dataset] = Record(source: source, scope: scope)
            return true
        }
        degradedDatasets.insert(dataset)
        if hasExistingValue, recordByDataset[dataset]?.source.isAccount == true {
            // Keep the account snapshot and its authority; this failure is
            // temporary and a retry is scheduled.
            return false
        }
        // Nothing better to show (cold start, a scope we have no account
        // snapshot for, or we were already local): this-machine data beats an
        // empty panel, but stays marked degraded.
        recordByDataset[dataset] = Record(source: source, scope: scope)
        return true
    }

    /// Forget a dataset the view intentionally emptied (e.g. hourly data while
    /// a non-day period is selected). Without this its degraded flag would
    /// linger forever, because nothing ever fetches it again to clear it.
    mutating func clear(_ dataset: Dataset) {
        recordByDataset.removeValue(forKey: dataset)
        degradedDatasets.remove(dataset)
    }
}

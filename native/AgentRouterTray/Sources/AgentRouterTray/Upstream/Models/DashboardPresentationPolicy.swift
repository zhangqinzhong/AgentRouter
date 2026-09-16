import Foundation

/// Pure state machine for the app's two presentations:
/// a background menu-bar agent and a foreground Dashboard window.
///
/// Keeping this free of AppKit makes the Dock/close ordering testable without
/// launching an application. `DashboardPresentationCoordinator` applies the
/// returned commands to `NSApp` on the main actor.
enum DashboardPresentationState: Equatable {
    case menuBar
    case dashboard
    case dashboardClosing
    case terminating
}

enum DashboardPresentationCommand: Equatable {
    case useRegularActivationPolicy
    case useAccessoryActivationPolicy
    case showDashboardWindow
}

struct DashboardPresentationPolicy {
    private(set) var state: DashboardPresentationState = .menuBar
    private var reopenAfterClose = false

    /// Presenting the Dashboard turns the menu-bar agent into a foreground app.
    /// Reassert the policy on every request so a prior modal alert cannot leave
    /// an already-created Dashboard window without a Dock tile.
    mutating func presentDashboard() -> [DashboardPresentationCommand] {
        switch state {
        case .menuBar:
            state = .dashboard
            return [.useRegularActivationPolicy, .showDashboardWindow]
        case .dashboard:
            return [.useRegularActivationPolicy, .showDashboardWindow]
        case .dashboardClosing:
            // AppKit has already accepted the close. Defer recreation until its
            // closing turn completes instead of trying to resurrect that window.
            reopenAfterClose = true
            return [.useRegularActivationPolicy]
        case .terminating:
            return []
        }
    }

    /// This is intentionally called from `windowShouldClose`, before AppKit
    /// starts the traffic-light close animation. Changing to `.accessory` from
    /// `windowWillClose` is too late on recent macOS releases and can leave the
    /// Dock tile visible until focus changes.
    mutating func prepareToCloseDashboard() -> [DashboardPresentationCommand] {
        guard state == .dashboard else { return [] }
        state = .dashboardClosing
        return [.useAccessoryActivationPolicy]
    }

    /// Run after the Dashboard's close has completed. Deliberately do not hide
    /// `NSApp`: that is a global operation which also hides the independent
    /// Dynamic Island and desktop-pet panels. `.accessory` already removed the
    /// Dock tile before the window close began.
    mutating func completeDashboardClose() -> [DashboardPresentationCommand] {
        guard state == .dashboardClosing else { return [] }
        if reopenAfterClose {
            reopenAfterClose = false
            state = .dashboard
            return [.useRegularActivationPolicy, .showDashboardWindow]
        }
        state = .menuBar
        return []
    }

    mutating func beginTermination() {
        state = .terminating
        reopenAfterClose = false
    }
}

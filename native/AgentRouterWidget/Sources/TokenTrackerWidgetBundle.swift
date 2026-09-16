import SwiftUI
import WidgetKit

@main
struct AgentRouterWidgetBundle: WidgetBundle {
    var body: some Widget {
        SummaryWidget()
        HeatmapWidget()
        TopModelsWidget()
        UsageLimitsWidget()
    }
}

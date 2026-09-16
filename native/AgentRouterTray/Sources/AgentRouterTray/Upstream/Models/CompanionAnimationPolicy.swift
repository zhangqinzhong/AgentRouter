enum CompanionAnimationPolicy {
    enum Surface {
        case popover
        case floatingPet
    }

    static func isVisible(
        surface: Surface,
        isPopoverVisible: Bool,
        isFloatingPetVisible: Bool
    ) -> Bool {
        switch surface {
        case .popover:
            return isPopoverVisible
        case .floatingPet:
            return isFloatingPetVisible
        }
    }

    static func shouldPauseTimeline(
        surface: Surface,
        isPopoverVisible: Bool,
        isFloatingPetVisible: Bool,
        isStaticFrame: Bool
    ) -> Bool {
        !isVisible(
            surface: surface,
            isPopoverVisible: isPopoverVisible,
            isFloatingPetVisible: isFloatingPetVisible
        ) || isStaticFrame
    }
}

import AppKit
import SwiftUI

/// Renders Codex-compatible 8×9 (V1) and 8×11 (V2) companion atlases.
/// Frames are copied into cell-sized bitmaps once and cached; the transparent desktop
/// window only swaps the resulting NSImage, avoiding full-atlas decodes per frame.
struct PetAtlasSpriteView: View {
    let character: PetCharacter
    let state: ClawdCompanionView.ClawdState
    let isVisible: Bool
    let lookDirectionIndex: Int?
    let isDragging: Bool
    let dragDirection: PetWindowState.DragDirection

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct AnimationSpec {
        let row: Int
        let durations: [Int]
    }

    private var spec: AnimationSpec {
        if isDragging {
            return AnimationSpec(
                row: dragDirection == .left ? 2 : 1,
                durations: [120, 120, 120, 120, 120, 120, 120, 220]
            )
        }
        switch state {
        case .error, .disconnected, .workingOverheated:
            return AnimationSpec(row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240])
        case .happy, .waking, .miniHappy:
            return AnimationSpec(row: 4, durations: [140, 140, 140, 140, 280])
        case .workingTyping, .workingUltrathink, .workingJuggling:
            return AnimationSpec(row: 7, durations: [120, 120, 120, 120, 120, 220])
        case .workingThinking, .workingWizard:
            return AnimationSpec(row: 8, durations: [150, 150, 150, 150, 150, 280])
        case .sleeping, .idleDoze, .miniSleep, .yawning:
            return AnimationSpec(row: 6, durations: [150, 150, 150, 150, 150, 260])
        case .miniPeek:
            return AnimationSpec(row: 3, durations: [140, 140, 140, 280])
        case .idleLiving, .idleLook, .miniIdle, .miniAlert:
            return AnimationSpec(row: 0, durations: [280, 110, 110, 140, 140, 320])
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12.0, paused: !isVisible || reduceMotion)) { timeline in
            if let image = PetAtlasFrameCache.shared.frame(
                character: character,
                row: lookFrame?.row ?? spec.row,
                column: lookFrame?.column ?? (reduceMotion ? 0 : frameIndex(at: timeline.date))
            ) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.none)
                    .antialiased(false)
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
    }

    private var lookFrame: (row: Int, column: Int)? {
        guard character.spriteVersionNumber == 2, spec.row == 0, let lookDirectionIndex else { return nil }
        let normalized = ((lookDirectionIndex % 16) + 16) % 16
        return (9 + normalized / 8, normalized % 8)
    }

    private func frameIndex(at date: Date) -> Int {
        let total = spec.durations.reduce(0, +)
        guard total > 0 else { return 0 }
        let elapsed = Int(date.timeIntervalSinceReferenceDate * 1_000) % total
        var boundary = 0
        for (index, duration) in spec.durations.enumerated() {
            boundary += duration
            if elapsed < boundary { return index }
        }
        return 0
    }
}

private final class PetAtlasFrameCache {
    static let shared = PetAtlasFrameCache()

    private let lock = NSLock()
    private var cacheKey: String?
    private var atlas: CGImage?
    private var frames: [String: NSImage] = [:]
    private let cellWidth = 192
    private let cellHeight = 208

    func frame(character: PetCharacter, row: Int, column: Int) -> NSImage? {
        let cacheKey = character.atlasCacheKey
        let frameKey = "\(row)-\(column)"
        lock.lock()
        defer { lock.unlock() }

        if self.cacheKey != cacheKey {
            self.cacheKey = cacheKey
            atlas = nil
            frames.removeAll(keepingCapacity: true)
        }
        if let cached = frames[frameKey] { return cached }
        guard let atlas = atlas(for: character) else { return nil }
        let rect = CGRect(
            x: column * cellWidth,
            y: row * cellHeight,
            width: cellWidth,
            height: cellHeight
        )
        guard let cropped = atlas.cropping(to: rect),
              let context = CGContext(
                data: nil,
                width: cellWidth,
                height: cellHeight,
                bitsPerComponent: 8,
                bytesPerRow: cellWidth * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.interpolationQuality = .none
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: cellWidth, height: cellHeight))
        guard let copied = context.makeImage() else { return nil }
        let image = NSImage(cgImage: copied, size: NSSize(width: cellWidth, height: cellHeight))
        frames[frameKey] = image
        return image
    }

    private func atlas(for character: PetCharacter) -> CGImage? {
        if let atlas { return atlas }
        guard let url = character.atlasURL,
              let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        atlas = cgImage
        return cgImage
    }
}

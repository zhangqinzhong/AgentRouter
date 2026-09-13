import type { MorphAsset, MorphLayer } from "./types"
import {
  collapsedLucidePath,
  joinLucidePaths,
  lucideCircle,
  lucideLine,
  lucidePath,
  lucidePolygon,
  lucideRoundedRect,
} from "./lucideGeometry"

type EndpointLayer = Omit<MorphLayer, "loading" | "loadingOpacity">

function strokeLayer(
  id: string,
  name: string,
  from: string,
  to: string,
  fromOpacity = 1,
  toOpacity = 1,
): EndpointLayer {
  return {
    id,
    name,
    from,
    to,
    fromOpacity,
    toOpacity,
    mode: "stroke",
  }
}

const hiddenCenter = collapsedLucidePath()
const hiddenPair = joinLucidePaths(hiddenCenter, hiddenCenter)

const checkPath = lucidePath("M20 6 9 17l-5-5")
const xDescending = lucidePath("m6 6 12 12")
const xAscending = lucidePath("M18 6 6 18")

const eyeOutline = lucidePath(
  "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
)
const eyeOffUpper = lucidePath(
  "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
)
const eyeOffPupil = lucidePath("M14.084 14.158a3 3 0 0 1-4.242-4.242")
const eyeOffLower = lucidePath(
  "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
)

const bellClapper = lucidePath("M10.268 21a2 2 0 0 0 3.464 0")
const bellBody = lucidePath(
  "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
)
const bellOffBody = lucidePath(
  "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742",
)
const bellOffUpper = lucidePath(
  "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05",
)

const volumeSpeaker = lucidePath(
  "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
)

const micCapsule = lucidePath(
  "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
)
const micStand = lucidePath("M19 10v2a7 7 0 0 1-14 0v-2")

const heart = lucidePath(
  "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
)
const heartOffLower = lucidePath(
  "M16.5 16.5 12 21l-7-7c-1.5-1.45-3-3.2-3-5.5a5.5 5.5 0 0 1 2.14-4.35",
)
const heartOffUpper = lucidePath(
  "M8.76 3.1c1.15.22 2.13.78 3.24 1.9 1.5-1.5 2.74-2 4.5-2A5.5 5.5 0 0 1 22 8.5c0 2.12-1.3 3.78-2.67 5.17",
)

const star = lucidePath(
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
)
const starOffLower = lucidePath(
  "M8.34 8.34 2 9.27l5 4.87L5.82 21 12 17.77 18.18 21l-.59-3.43",
)
const starOffUpper = lucidePath(
  "M18.42 12.76 22 9.27l-6.91-1L12 2l-1.44 2.91",
)

const bookmark = lucidePath(
  "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z",
)
const bookmarkCheck = lucidePath(
  "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z",
)

const sendOutline = lucidePath(
  "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
)

const sunCore = lucideCircle(12, 12, 4)
const moon = lucidePath("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")

const folder = lucidePath(
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
)
const folderOpen = lucidePath(
  "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
)

const fileOutline = lucidePath(
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
)
const fileFold = lucidePath("M14 2v4a2 2 0 0 0 2 2h4")

const endpointPresets: Record<string, EndpointLayer[]> = {
  "menu-x": [
    strokeLayer("menu-top", "Top rail", lucideLine(4, 6, 20, 6), xDescending),
    strokeLayer(
      "menu-middle",
      "Middle rail",
      lucideLine(4, 12, 20, 12),
      hiddenCenter,
      1,
      0,
    ),
    strokeLayer(
      "menu-bottom",
      "Bottom rail",
      lucideLine(4, 18, 20, 18),
      xAscending,
    ),
  ],
  "play-pause": [
    strokeLayer(
      "play-left",
      "Play outline to left bar",
      lucidePolygon("6 3 20 12 6 21 6 3"),
      lucideRoundedRect(6, 4, 4, 16, 1),
    ),
    strokeLayer(
      "play-right",
      "Right pause bar",
      collapsedLucidePath(14, 4),
      lucideRoundedRect(14, 4, 4, 16, 1),
      0,
      1,
    ),
  ],
  "plus-check": [
    strokeLayer("plus-horizontal", "Plus to check", lucidePath("M5 12h14"), checkPath),
    strokeLayer(
      "plus-vertical",
      "Retracting arm",
      lucidePath("M12 5v14"),
      collapsedLucidePath(9, 17),
      1,
      0,
    ),
  ],
  "arrow-down-up": [
    strokeLayer(
      "arrow-shaft",
      "Shaft",
      lucidePath("M12 5v14"),
      lucidePath("M12 19V5"),
    ),
    strokeLayer(
      "arrow-left",
      "Arrow head",
      lucidePath("m19 12-7 7-7-7"),
      lucidePath("m5 12 7-7 7 7"),
    ),
    strokeLayer("arrow-right", "Loading sweep", hiddenCenter, hiddenCenter, 0, 0),
  ],
  "search-x": [
    strokeLayer("search-ring", "Lens to slash", lucideCircle(11, 11, 8), xDescending),
    strokeLayer(
      "search-handle",
      "Handle to second slash",
      lucidePath("m21 21-4.3-4.3"),
      xAscending,
    ),
  ],
  "eye-eye-off": [
    strokeLayer("eye-outline", "Eye upper outline", eyeOutline, eyeOffUpper),
    strokeLayer("eye-pupil", "Pupil", lucideCircle(12, 12, 3), eyeOffPupil),
    strokeLayer(
      "eye-lower-outline",
      "Eye lower outline",
      collapsedLucidePath(17.479, 17.499),
      eyeOffLower,
      0,
      1,
    ),
    strokeLayer(
      "eye-slash",
      "Slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "bell-bell-off": [
    strokeLayer("bell-body", "Bell body", bellBody, bellOffBody),
    strokeLayer("bell-clapper", "Clapper", bellClapper, bellClapper),
    strokeLayer(
      "bell-upper",
      "Bell upper outline",
      collapsedLucidePath(8.668, 3.01),
      bellOffUpper,
      0,
      1,
    ),
    strokeLayer(
      "bell-slash",
      "Slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "volume-volume-x": [
    strokeLayer("volume-speaker", "Speaker", volumeSpeaker, volumeSpeaker),
    strokeLayer(
      "volume-wave-upper",
      "Inner wave to slash",
      lucidePath("M16 9a5 5 0 0 1 0 6"),
      lucideLine(22, 9, 16, 15),
    ),
    strokeLayer(
      "volume-wave-lower",
      "Outer wave to slash",
      lucidePath("M19.364 18.364a9 9 0 0 0 0-12.728"),
      lucideLine(16, 9, 22, 15),
    ),
  ],
  "mic-mic-off": [
    strokeLayer(
      "mic-capsule",
      "Capsule upper",
      micCapsule,
      lucidePath("M15 9.34V5a3 3 0 0 0-5.68-1.33"),
    ),
    strokeLayer(
      "mic-capsule-lower",
      "Capsule lower",
      collapsedLucidePath(9, 9),
      lucidePath("M9 9v3a3 3 0 0 0 5.12 2.12"),
      0,
      1,
    ),
    strokeLayer(
      "mic-stand",
      "Stand lower",
      micStand,
      lucidePath("M5 10v2a7 7 0 0 0 12 5"),
    ),
    strokeLayer(
      "mic-stand-upper",
      "Stand upper",
      collapsedLucidePath(18.89, 13.23),
      lucidePath("M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"),
      0,
      1,
    ),
    strokeLayer(
      "mic-base",
      "Base",
      lucideLine(12, 19, 12, 22),
      lucideLine(12, 19, 12, 22),
    ),
    strokeLayer(
      "mic-slash",
      "Slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "lock-lock-open": [
    strokeLayer(
      "lock-body",
      "Lock body",
      lucideRoundedRect(3, 11, 18, 11, 2),
      lucideRoundedRect(3, 11, 18, 11, 2),
    ),
    strokeLayer(
      "lock-shackle",
      "Shackle",
      lucidePath("M7 11V7a5 5 0 0 1 10 0v4"),
      lucidePath("M7 11V7a5 5 0 0 1 9.9-1"),
    ),
  ],
  "heart-heart-off": [
    strokeLayer("heart-body", "Heart lower", heart, heartOffLower),
    strokeLayer(
      "heart-upper",
      "Heart upper",
      collapsedLucidePath(8.76, 3.1),
      heartOffUpper,
      0,
      1,
    ),
    strokeLayer(
      "heart-slash",
      "Slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "star-star-off": [
    strokeLayer("star-body", "Star lower", star, starOffLower),
    strokeLayer(
      "star-upper",
      "Star upper",
      collapsedLucidePath(18.42, 12.76),
      starOffUpper,
      0,
      1,
    ),
    strokeLayer(
      "star-slash",
      "Slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "bookmark-bookmark-check": [
    strokeLayer("bookmark-ribbon", "Bookmark", bookmark, bookmarkCheck),
    strokeLayer(
      "bookmark-check-short",
      "Check",
      collapsedLucidePath(9, 10),
      lucidePath("m9 10 2 2 4-4"),
      0,
      1,
    ),
    strokeLayer(
      "bookmark-check-long",
      "Loading sweep",
      hiddenCenter,
      hiddenCenter,
      0,
      0,
    ),
  ],
  "calendar-calendar-check": [
    strokeLayer(
      "calendar-frame",
      "Calendar frame",
      lucideRoundedRect(3, 4, 18, 18, 2),
      lucideRoundedRect(3, 4, 18, 18, 2),
    ),
    strokeLayer(
      "calendar-top-rule",
      "Top rule",
      lucidePath("M3 10h18"),
      lucidePath("M3 10h18"),
    ),
    strokeLayer(
      "calendar-rings",
      "Binding rings",
      joinLucidePaths(lucidePath("M8 2v4"), lucidePath("M16 2v4")),
      joinLucidePaths(lucidePath("M8 2v4"), lucidePath("M16 2v4")),
    ),
    strokeLayer(
      "calendar-check-short",
      "Check",
      collapsedLucidePath(9, 16),
      lucidePath("m9 16 2 2 4-4"),
      0,
      1,
    ),
    strokeLayer(
      "calendar-check-long",
      "Loading sweep",
      hiddenCenter,
      hiddenCenter,
      0,
      0,
    ),
  ],
  "send-check": [
    strokeLayer(
      "send-short-check",
      "Plane diagonal to check",
      lucidePath("m21.854 2.147-10.94 10.939"),
      checkPath,
    ),
    strokeLayer(
      "send-long-check",
      "Plane outline",
      sendOutline,
      collapsedLucidePath(9, 17),
      1,
      0,
    ),
  ],
  "filter-list-filter": [
    strokeLayer(
      "filter-top",
      "Filter to top bar",
      lucidePolygon("22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"),
      lucidePath("M3 6h18"),
    ),
    strokeLayer(
      "filter-middle",
      "Middle bar",
      collapsedLucidePath(7, 12),
      lucidePath("M7 12h10"),
      0,
      1,
    ),
    strokeLayer(
      "filter-bottom",
      "Bottom bar",
      collapsedLucidePath(10, 18),
      lucidePath("M10 18h4"),
      0,
      1,
    ),
  ],
  "chevron-down-up": [
    strokeLayer(
      "chevron-left",
      "Chevron",
      lucidePath("m6 9 6 6 6-6"),
      lucidePath("m18 15-6-6-6 6"),
    ),
    strokeLayer("chevron-right", "Loading sweep", hiddenCenter, hiddenCenter, 0, 0),
  ],
  "sun-moon": [
    strokeLayer("sun-core", "Sun core to moon", sunCore, moon),
    strokeLayer(
      "sun-ray-vertical",
      "Vertical rays",
      joinLucidePaths(lucidePath("M12 2v2"), lucidePath("M12 20v2")),
      hiddenPair,
      1,
      0,
    ),
    strokeLayer(
      "sun-ray-horizontal",
      "Horizontal rays",
      joinLucidePaths(lucidePath("M2 12h2"), lucidePath("M20 12h2")),
      hiddenPair,
      1,
      0,
    ),
    strokeLayer(
      "sun-ray-diagonal-a",
      "Diagonal rays A",
      joinLucidePaths(
        lucidePath("m4.93 4.93 1.41 1.41"),
        lucidePath("m17.66 17.66 1.41 1.41"),
      ),
      hiddenPair,
      1,
      0,
    ),
    strokeLayer(
      "sun-ray-diagonal-b",
      "Diagonal rays B",
      joinLucidePaths(
        lucidePath("m6.34 17.66-1.41 1.41"),
        lucidePath("m19.07 4.93-1.41 1.41"),
      ),
      hiddenPair,
      1,
      0,
    ),
  ],
  "folder-folder-open": [
    strokeLayer("folder-tab", "Loading sweep", hiddenCenter, hiddenCenter, 0, 0),
    strokeLayer("folder-body", "Folder", folder, folderOpen),
  ],
  "file-file-check": [
    strokeLayer("file-outline", "File outline", fileOutline, fileOutline),
    strokeLayer("file-fold", "File fold", fileFold, fileFold),
    strokeLayer(
      "file-check-short",
      "Check",
      collapsedLucidePath(9, 15),
      lucidePath("m9 15 2 2 4-4"),
      0,
      1,
    ),
    strokeLayer(
      "file-check-long",
      "Loading sweep",
      hiddenCenter,
      hiddenCenter,
      0,
      0,
    ),
  ],
  "collapse-sidebar-to-expand-inspector": [
    strokeLayer(
      "workspace-frame",
      "Workspace frame",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucideRoundedRect(3, 3, 18, 18, 2),
    ),
    strokeLayer(
      "workspace-divider",
      "Panel divider",
      lucideLine(9, 3, 9, 21),
      lucideLine(15, 3, 15, 21),
    ),
    strokeLayer(
      "workspace-arrow",
      "Panel direction",
      lucidePath("m16 15-3-3 3-3"),
      lucidePath("m8 9 3 3-3 3"),
    ),
  ],
  "maximize-minimize": [
    strokeLayer(
      "fullscreen-corner-a",
      "First corner",
      lucidePath("M15 3h6v6"),
      lucidePath("M4 14h6v6"),
    ),
    strokeLayer(
      "fullscreen-corner-b",
      "Second corner",
      lucidePath("M9 21H3v-6"),
      lucidePath("M20 10h-6V4"),
    ),
    strokeLayer(
      "fullscreen-diagonal-a",
      "First diagonal",
      lucideLine(21, 3, 14, 10),
      lucideLine(14, 10, 21, 3),
    ),
    strokeLayer(
      "fullscreen-diagonal-b",
      "Second diagonal",
      lucideLine(3, 21, 10, 14),
      lucideLine(3, 21, 10, 14),
    ),
  ],
  "layout-grid-list": [
    strokeLayer(
      "view-item-a",
      "Top marker",
      lucideRoundedRect(3, 3, 7, 7, 1),
      lucidePath("M3 6h.01"),
    ),
    strokeLayer(
      "view-item-b",
      "Top row",
      lucideRoundedRect(14, 3, 7, 7, 1),
      lucideLine(8, 6, 21, 6),
    ),
    strokeLayer(
      "view-item-c",
      "Middle marker",
      lucideRoundedRect(3, 14, 7, 7, 1),
      lucidePath("M3 12h.01"),
    ),
    strokeLayer(
      "view-item-d",
      "Middle row",
      lucideRoundedRect(14, 14, 7, 7, 1),
      lucideLine(8, 12, 21, 12),
    ),
    strokeLayer(
      "view-item-e",
      "Bottom marker",
      collapsedLucidePath(3, 18),
      lucidePath("M3 18h.01"),
      0,
      1,
    ),
    strokeLayer(
      "view-item-f",
      "Bottom row",
      collapsedLucidePath(8, 18),
      lucideLine(8, 18, 21, 18),
      0,
      1,
    ),
  ],
  "columns-rows": [
    strokeLayer(
      "layout-frame",
      "Layout frame",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucideRoundedRect(3, 3, 18, 18, 2),
    ),
    strokeLayer(
      "layout-divider",
      "Layout divider",
      lucideLine(12, 3, 12, 21),
      lucideLine(3, 12, 21, 12),
    ),
  ],
  "undo-redo": [
    strokeLayer(
      "history-arrow",
      "History arrow",
      lucidePath("M9 14 4 9l5-5"),
      lucidePath("m15 14 5-5-5-5"),
    ),
    strokeLayer(
      "history-curve",
      "History curve",
      lucidePath("M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"),
      lucidePath("M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"),
    ),
  ],
  "rotate-ccw-cw": [
    strokeLayer(
      "rotate-orbit",
      "Rotation orbit",
      lucidePath("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"),
      lucidePath("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"),
    ),
    strokeLayer(
      "rotate-corner",
      "Rotation arrow",
      lucidePath("M3 3v5h5"),
      lucidePath("M21 3v5h-5"),
    ),
  ],
  "zoom-in-out": [
    strokeLayer("zoom-ring", "Lens", lucideCircle(11, 11, 8), lucideCircle(11, 11, 8)),
    strokeLayer(
      "zoom-handle",
      "Lens handle",
      lucideLine(21, 21, 16.65, 16.65),
      lucideLine(21, 21, 16.65, 16.65),
    ),
    strokeLayer(
      "zoom-horizontal",
      "Horizontal control",
      lucideLine(8, 11, 14, 11),
      lucideLine(8, 11, 14, 11),
    ),
    strokeLayer(
      "zoom-vertical",
      "Vertical control",
      lucideLine(11, 8, 11, 14),
      collapsedLucidePath(11, 11),
      1,
      0,
    ),
  ],
  "pin-pin-off": [
    strokeLayer("pin-stem", "Pin stem", lucideLine(12, 17, 12, 22), lucideLine(12, 17, 12, 22)),
    strokeLayer(
      "pin-body",
      "Pin body",
      lucidePath("M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"),
      lucidePath("M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"),
    ),
    strokeLayer(
      "pin-upper",
      "Pin upper",
      collapsedLucidePath(15, 9.34),
      lucidePath("M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"),
      0,
      1,
    ),
    strokeLayer(
      "pin-slash",
      "Unpin slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "link-unlink": [
    strokeLayer(
      "link-upper",
      "Upper link",
      lucidePath("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"),
      lucidePath("m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"),
    ),
    strokeLayer(
      "link-lower",
      "Lower link",
      lucidePath("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
      lucidePath("m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"),
    ),
    strokeLayer("unlink-mark-a", "Upper mark", collapsedLucidePath(8, 2), lucideLine(8, 2, 8, 5), 0, 1),
    strokeLayer("unlink-mark-b", "Left mark", collapsedLucidePath(2, 8), lucideLine(2, 8, 5, 8), 0, 1),
    strokeLayer("unlink-mark-c", "Lower mark", collapsedLucidePath(16, 19), lucideLine(16, 19, 16, 22), 0, 1),
    strokeLayer("unlink-mark-d", "Right mark", collapsedLucidePath(19, 16), lucideLine(19, 16, 22, 16), 0, 1),
  ],
  "cloud-download-upload": [
    strokeLayer(
      "cloud-body",
      "Cloud",
      lucidePath("M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"),
      lucidePath("M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"),
    ),
    strokeLayer(
      "cloud-arrow-primary",
      "Transfer arrow",
      lucidePath("M12 13v8l-4-4"),
      lucidePath("m8 17 4-4 4 4"),
    ),
    strokeLayer(
      "cloud-arrow-secondary",
      "Transfer shaft",
      lucidePath("m12 21 4-4"),
      lucidePath("M12 13v8"),
    ),
  ],
  "mail-mail-open": [
    strokeLayer(
      "mail-frame",
      "Envelope frame",
      lucideRoundedRect(2, 4, 20, 16, 2),
      lucidePath("M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"),
    ),
    strokeLayer(
      "mail-flap",
      "Envelope flap",
      lucidePath("m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"),
      lucidePath("m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"),
    ),
  ],
  "user-plus-check": [
    strokeLayer(
      "user-body",
      "User body",
      lucidePath("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"),
      lucidePath("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"),
    ),
    strokeLayer("user-head", "User head", lucideCircle(9, 7, 4), lucideCircle(9, 7, 4)),
    strokeLayer(
      "user-action-horizontal",
      "User action",
      lucideLine(22, 11, 16, 11),
      lucidePath("M16 11l2 2 4-4"),
    ),
    strokeLayer(
      "user-action-vertical",
      "Retracting action",
      lucideLine(19, 8, 19, 14),
      collapsedLucidePath(18, 13),
      1,
      0,
    ),
  ],
  "toggle-left-right": [
    strokeLayer(
      "toggle-track",
      "Toggle track",
      lucideRoundedRect(2, 6, 20, 12, 6),
      lucideRoundedRect(2, 6, 20, 12, 6),
    ),
    strokeLayer("toggle-thumb", "Toggle thumb", lucideCircle(8, 12, 2), lucideCircle(16, 12, 2)),
  ],
  "align-left-right": [
    strokeLayer("align-middle", "Middle rule", lucideLine(15, 12, 3, 12), lucideLine(21, 12, 9, 12)),
    strokeLayer("align-bottom", "Bottom rule", lucideLine(17, 18, 3, 18), lucideLine(21, 18, 7, 18)),
    strokeLayer("align-top", "Top rule", lucideLine(21, 6, 3, 6), lucideLine(21, 6, 3, 6)),
  ],
  "image-image-off": [
    strokeLayer(
      "image-frame-lower",
      "Image lower frame",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucidePath("M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"),
    ),
    strokeLayer(
      "image-sun",
      "Image point",
      lucideCircle(9, 9, 2),
      lucidePath("M10.41 10.41a2 2 0 1 1-2.83-2.83"),
    ),
    strokeLayer(
      "image-mountain",
      "Image mountain",
      lucidePath("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"),
      lucideLine(13.5, 13.5, 6, 21),
    ),
    strokeLayer("image-ridge", "Image ridge", collapsedLucidePath(18, 12), lucideLine(18, 12, 21, 15), 0, 1),
    strokeLayer(
      "image-frame-upper",
      "Image upper frame",
      collapsedLucidePath(21, 15),
      lucidePath("M21 15V5a2 2 0 0 0-2-2H9"),
      0,
      1,
    ),
    strokeLayer("image-slash", "Image slash", collapsedLucidePath(2, 2), lucideLine(2, 2, 22, 22), 0, 1),
  ],
  "wifi-wifi-off": [
    strokeLayer("wifi-dot", "Wi-Fi point", lucidePath("M12 20h.01"), lucidePath("M12 20h.01")),
    strokeLayer(
      "wifi-inner",
      "Inner signal",
      lucidePath("M8.5 16.429a5 5 0 0 1 7 0"),
      lucidePath("M8.5 16.429a5 5 0 0 1 7 0"),
    ),
    strokeLayer(
      "wifi-middle-left",
      "Middle signal",
      lucidePath("M5 12.859a10 10 0 0 1 14 0"),
      lucidePath("M5 12.859a10 10 0 0 1 5.17-2.69"),
    ),
    strokeLayer(
      "wifi-outer-left",
      "Outer signal",
      lucidePath("M2 8.82a15 15 0 0 1 20 0"),
      lucidePath("M2 8.82a15 15 0 0 1 4.177-2.643"),
    ),
    strokeLayer(
      "wifi-middle-right",
      "Middle signal end",
      collapsedLucidePath(19, 12.859),
      lucidePath("M19 12.859a10 10 0 0 0-2.007-1.523"),
      0,
      1,
    ),
    strokeLayer(
      "wifi-outer-right",
      "Outer signal end",
      collapsedLucidePath(22, 8.82),
      lucidePath("M22 8.82a15 15 0 0 0-11.288-3.764"),
      0,
      1,
    ),
    strokeLayer("wifi-slash", "Wi-Fi slash", collapsedLucidePath(2, 2), lucideLine(2, 2, 22, 22), 0, 1),
  ],
  "circle-play-stop": [
    strokeLayer("media-circle", "Media circle", lucideCircle(12, 12, 10), lucideCircle(12, 12, 10)),
    strokeLayer(
      "media-control",
      "Media control",
      lucidePolygon("10 8 16 12 10 16 10 8"),
      lucideRoundedRect(9, 9, 6, 6, 1),
    ),
  ],
  "archive-restore": [
    strokeLayer(
      "archive-lid",
      "Archive lid",
      lucideRoundedRect(2, 3, 20, 5, 1),
      lucideRoundedRect(2, 3, 20, 5, 1),
    ),
    strokeLayer(
      "archive-body-left",
      "Archive body",
      lucidePath("M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"),
      lucidePath("M4 8v11a2 2 0 0 0 2 2h2"),
    ),
    strokeLayer(
      "archive-body-right",
      "Archive body end",
      collapsedLucidePath(20, 8),
      lucidePath("M20 8v11a2 2 0 0 1-2 2h-2"),
      0,
      1,
    ),
    strokeLayer(
      "archive-action",
      "Archive action",
      lucideLine(10, 12, 14, 12),
      lucidePath("m9 15 3-3 3 3"),
    ),
    strokeLayer(
      "archive-shaft",
      "Restore shaft",
      collapsedLucidePath(12, 12),
      lucideLine(12, 12, 12, 21),
      0,
      1,
    ),
  ],
  "log-in-out": [
    strokeLayer(
      "session-door",
      "Session door",
      lucidePath("M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"),
      lucidePath("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"),
    ),
    strokeLayer(
      "session-arrow",
      "Session arrow",
      lucidePath("M10 17l5-5-5-5"),
      lucidePath("M16 17l5-5-5-5"),
    ),
    strokeLayer(
      "session-shaft",
      "Session shaft",
      lucideLine(15, 12, 3, 12),
      lucideLine(21, 12, 9, 12),
    ),
  ],
  "copy-clipboard-check": [
    strokeLayer(
      "copy-front",
      "Copy surface",
      lucideRoundedRect(8, 8, 14, 14, 2),
      lucidePath("M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"),
    ),
    strokeLayer(
      "copy-back",
      "Copy backing",
      lucidePath("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"),
      lucideRoundedRect(8, 2, 8, 4, 1),
    ),
    strokeLayer(
      "copy-check",
      "Copied check",
      collapsedLucidePath(9, 14),
      lucidePath("m9 14 2 2 4-4"),
      0,
      1,
    ),
  ],
  "message-message-off": [
    strokeLayer(
      "message-lower",
      "Message bubble",
      lucidePath("M7.9 20A9 9 0 1 0 4 16.1L2 22Z"),
      lucidePath("M5.6 5.6C3 8.3 2.2 12.5 4 16l-2 6 6-2c3.4 1.8 7.6 1.1 10.3-1.7"),
    ),
    strokeLayer(
      "message-upper",
      "Message bubble end",
      collapsedLucidePath(20.5, 14.9),
      lucidePath("M20.5 14.9A9 9 0 0 0 9.1 3.5"),
      0,
      1,
    ),
    strokeLayer(
      "message-slash",
      "Message slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "battery-low-full": [
    strokeLayer(
      "battery-shell",
      "Battery shell",
      lucideRoundedRect(2, 7, 16, 10, 2),
      lucideRoundedRect(2, 7, 16, 10, 2),
    ),
    strokeLayer(
      "battery-terminal",
      "Battery terminal",
      lucideLine(22, 11, 22, 13),
      lucideLine(22, 11, 22, 13),
    ),
    strokeLayer(
      "battery-cell-low",
      "Low charge cell",
      lucideLine(6, 11, 6, 13),
      lucideLine(6, 11, 6, 13),
    ),
    strokeLayer(
      "battery-cell-middle",
      "Middle charge cell",
      collapsedLucidePath(10, 12),
      lucideLine(10, 11, 10, 13),
      0,
      1,
    ),
    strokeLayer(
      "battery-cell-full",
      "Full charge cell",
      collapsedLucidePath(14, 12),
      lucideLine(14, 11, 14, 13),
      0,
      1,
    ),
  ],
  "signal-low-high": [
    strokeLayer(
      "signal-origin",
      "Signal origin",
      lucidePath("M2 20h.01"),
      lucidePath("M2 20h.01"),
    ),
    strokeLayer(
      "signal-low-bar",
      "Low signal bar",
      lucidePath("M7 20v-4"),
      lucidePath("M7 20v-4"),
    ),
    strokeLayer(
      "signal-middle-bar",
      "Middle signal bar",
      collapsedLucidePath(12, 20),
      lucidePath("M12 20v-8"),
      0,
      1,
    ),
    strokeLayer(
      "signal-high-bar",
      "High signal bar",
      collapsedLucidePath(17, 20),
      lucidePath("M17 20V8"),
      0,
      1,
    ),
  ],
  "volume-low-high": [
    strokeLayer("volume-level-speaker", "Speaker", volumeSpeaker, volumeSpeaker),
    strokeLayer(
      "volume-level-inner",
      "Inner sound wave",
      lucidePath("M16 9a5 5 0 0 1 0 6"),
      lucidePath("M16 9a5 5 0 0 1 0 6"),
    ),
    strokeLayer(
      "volume-level-outer",
      "Outer sound wave",
      collapsedLucidePath(19.364, 18.364),
      lucidePath("M19.364 18.364a9 9 0 0 0 0-12.728"),
      0,
      1,
    ),
  ],
  "shield-shield-check": [
    strokeLayer(
      "shield-outline",
      "Shield outline",
      lucidePath(
        "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      ),
      lucidePath(
        "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      ),
    ),
    strokeLayer(
      "shield-check",
      "Verification check",
      collapsedLucidePath(9, 12),
      lucidePath("m9 12 2 2 4-4"),
      0,
      1,
    ),
  ],
  "camera-camera-off": [
    strokeLayer(
      "camera-frame-lower",
      "Camera body",
      lucidePath(
        "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
      ),
      lucidePath("M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16"),
    ),
    strokeLayer(
      "camera-frame-upper",
      "Camera body end",
      collapsedLucidePath(9.5, 4),
      lucidePath("M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"),
      0,
      1,
    ),
    strokeLayer(
      "camera-lens",
      "Camera lens",
      lucideCircle(12, 13, 3),
      lucidePath("M14.121 15.121A3 3 0 1 1 9.88 10.88"),
    ),
    strokeLayer(
      "camera-slash",
      "Camera off slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "video-video-off": [
    strokeLayer(
      "video-lens",
      "Video lens",
      lucidePath(
        "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
      ),
      lucidePath(
        "M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196",
      ),
    ),
    strokeLayer(
      "video-body",
      "Video body",
      lucideRoundedRect(2, 6, 14, 12, 2),
      lucidePath("M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"),
    ),
    strokeLayer(
      "video-slash",
      "Video off slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "bluetooth-bluetooth-off": [
    strokeLayer(
      "bluetooth-lower",
      "Bluetooth symbol",
      lucidePath("m7 7 10 10-5 5V2l5 5L7 17"),
      lucidePath("m17 17-5 5V12l-5 5"),
    ),
    strokeLayer(
      "bluetooth-upper",
      "Bluetooth upper symbol",
      collapsedLucidePath(14.5, 9.5),
      lucidePath("M14.5 9.5 17 7l-5-5v4.5"),
      0,
      1,
    ),
    strokeLayer(
      "bluetooth-slash",
      "Bluetooth off slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "navigation-navigation-off": [
    strokeLayer(
      "navigation-lower",
      "Navigation pointer",
      lucidePolygon("3 11 22 2 13 21 11 13 3 11"),
      lucidePath("M8.43 8.43 3 11l8 2 2 8 2.57-5.43"),
    ),
    strokeLayer(
      "navigation-upper",
      "Navigation pointer end",
      collapsedLucidePath(17.39, 11.73),
      lucidePath("M17.39 11.73 22 2l-9.73 4.61"),
      0,
      1,
    ),
    strokeLayer(
      "navigation-slash",
      "Navigation off slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "map-pin-map-pin-check": [
    strokeLayer(
      "location-pin",
      "Location pin",
      lucidePath(
        "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
      ),
      lucidePath(
        "M19.43 12.935c.357-.967.57-1.955.57-2.935a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32.197 32.197 0 0 0 .813-.728",
      ),
    ),
    strokeLayer(
      "location-dot",
      "Location dot",
      lucideCircle(12, 10, 3),
      lucideCircle(12, 10, 3),
    ),
    strokeLayer(
      "location-check",
      "Location confirmation",
      collapsedLucidePath(16, 18),
      lucidePath("m16 18 2 2 4-4"),
      0,
      1,
    ),
  ],
  "package-package-open": [
    strokeLayer(
      "package-spine",
      "Package spine",
      lucidePath("M12 22V12"),
      lucidePath("M12 22v-9"),
    ),
    strokeLayer(
      "package-shell",
      "Package shell",
      lucidePath(
        "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z",
      ),
      lucidePath(
        "M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z",
      ),
    ),
    strokeLayer(
      "package-fold",
      "Package lower fold",
      lucidePath("m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"),
      lucidePath(
        "M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13",
      ),
    ),
    strokeLayer(
      "package-flap",
      "Package upper flap",
      lucidePath("m7.5 4.27 9 5.15"),
      lucidePath(
        "M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z",
      ),
    ),
  ],
  "door-closed-open": [
    strokeLayer(
      "door-frame",
      "Door frame",
      lucidePath("M18 20V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14"),
      lucidePath("M13 4h3a2 2 0 0 1 2 2v14"),
    ),
    strokeLayer(
      "door-threshold-left",
      "Door threshold left",
      lucidePath("M2 20h20"),
      lucidePath("M2 20h3"),
    ),
    strokeLayer(
      "door-threshold-right",
      "Door threshold right",
      collapsedLucidePath(13, 20),
      lucidePath("M13 20h9"),
      0,
      1,
    ),
    strokeLayer(
      "door-handle",
      "Door handle",
      lucidePath("M14 12v.01"),
      lucidePath("M10 12v.01"),
    ),
    strokeLayer(
      "door-panel",
      "Open door panel",
      collapsedLucidePath(13, 4.562),
      lucidePath(
        "M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z",
      ),
      0,
      1,
    ),
  ],
  "panel-bottom-close-open": [
    strokeLayer(
      "bottom-panel-frame",
      "Bottom panel frame",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucideRoundedRect(3, 3, 18, 18, 2),
    ),
    strokeLayer(
      "bottom-panel-divider",
      "Bottom panel divider",
      lucidePath("M3 15h18"),
      lucidePath("M3 15h18"),
    ),
    strokeLayer(
      "bottom-panel-arrow",
      "Bottom panel arrow",
      lucidePath("m15 8-3 3-3-3"),
      lucidePath("m9 10 3-3 3 3"),
    ),
  ],
  "circle-plus-check": [
    strokeLayer(
      "circle-action-frame",
      "Action circle",
      lucideCircle(12, 12, 10),
      lucideCircle(12, 12, 10),
    ),
    strokeLayer(
      "circle-action-primary",
      "Add to complete",
      lucidePath("M8 12h8"),
      lucidePath("m9 12 2 2 4-4"),
    ),
    strokeLayer(
      "circle-action-secondary",
      "Retracting add arm",
      lucidePath("M12 8v8"),
      collapsedLucidePath(11, 14),
      1,
      0,
    ),
  ],
  "circle-alert-check": [
    strokeLayer(
      "circle-status-frame",
      "Status circle",
      lucideCircle(12, 12, 10),
      lucideCircle(12, 12, 10),
    ),
    strokeLayer(
      "circle-status-primary",
      "Alert to check",
      lucideLine(12, 8, 12, 12),
      lucidePath("m9 12 2 2 4-4"),
    ),
    strokeLayer(
      "circle-status-dot",
      "Alert dot",
      lucideLine(12, 16, 12.01, 16),
      collapsedLucidePath(11, 14),
      1,
      0,
    ),
  ],
  "clipboard-clipboard-check": [
    strokeLayer(
      "clipboard-clip",
      "Clipboard clip",
      lucideRoundedRect(8, 2, 8, 4, 1),
      lucideRoundedRect(8, 2, 8, 4, 1),
    ),
    strokeLayer(
      "clipboard-frame",
      "Clipboard frame",
      lucidePath("M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"),
      lucidePath("M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"),
    ),
    strokeLayer(
      "clipboard-check",
      "Clipboard check",
      collapsedLucidePath(9, 14),
      lucidePath("m9 14 2 2 4-4"),
      0,
      1,
    ),
  ],
  "calendar-plus-check": [
    strokeLayer(
      "event-calendar-left-ring",
      "Left calendar ring",
      lucidePath("M8 2v4"),
      lucidePath("M8 2v4"),
    ),
    strokeLayer(
      "event-calendar-right-ring",
      "Right calendar ring",
      lucidePath("M16 2v4"),
      lucidePath("M16 2v4"),
    ),
    strokeLayer(
      "event-calendar-frame",
      "Calendar frame",
      lucidePath("M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"),
      lucideRoundedRect(3, 4, 18, 18, 2),
    ),
    strokeLayer(
      "event-calendar-divider",
      "Calendar divider",
      lucidePath("M3 10h18"),
      lucidePath("M3 10h18"),
    ),
    strokeLayer(
      "event-calendar-action",
      "Add to confirm",
      lucidePath("M16 19h6"),
      lucidePath("m9 16 2 2 4-4"),
    ),
    strokeLayer(
      "event-calendar-add-arm",
      "Retracting add arm",
      lucidePath("M19 16v6"),
      collapsedLucidePath(11, 18),
      1,
      0,
    ),
  ],
  "user-plus-minus": [
    strokeLayer(
      "membership-body",
      "User body",
      lucidePath("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"),
      lucidePath("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"),
    ),
    strokeLayer(
      "membership-head",
      "User head",
      lucideCircle(9, 7, 4),
      lucideCircle(9, 7, 4),
    ),
    strokeLayer(
      "membership-horizontal",
      "Membership action",
      lucideLine(22, 11, 16, 11),
      lucideLine(22, 11, 16, 11),
    ),
    strokeLayer(
      "membership-vertical",
      "Retracting add arm",
      lucideLine(19, 8, 19, 14),
      collapsedLucidePath(19, 11),
      1,
      0,
    ),
  ],
  "bookmark-plus-check": [
    strokeLayer(
      "bookmark-action-ribbon",
      "Bookmark ribbon",
      lucidePath("m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"),
      bookmarkCheck,
    ),
    strokeLayer(
      "bookmark-action-primary",
      "Add to save",
      lucideLine(15, 10, 9, 10),
      lucidePath("m9 10 2 2 4-4"),
    ),
    strokeLayer(
      "bookmark-action-secondary",
      "Retracting add arm",
      lucideLine(12, 7, 12, 13),
      collapsedLucidePath(11, 12),
      1,
      0,
    ),
  ],
  "folder-plus-check": [
    strokeLayer("folder-action-frame", "Folder frame", folder, folder),
    strokeLayer(
      "folder-action-primary",
      "Add to ready",
      lucidePath("M9 13h6"),
      lucidePath("m9 13 2 2 4-4"),
    ),
    strokeLayer(
      "folder-action-secondary",
      "Retracting add arm",
      lucidePath("M12 10v6"),
      collapsedLucidePath(11, 15),
      1,
      0,
    ),
  ],
  "file-plus-check": [
    strokeLayer("file-action-outline", "File outline", fileOutline, fileOutline),
    strokeLayer("file-action-fold", "File fold", fileFold, fileFold),
    strokeLayer(
      "file-action-primary",
      "Add to ready",
      lucidePath("M9 15h6"),
      lucidePath("m9 15 2 2 4-4"),
    ),
    strokeLayer(
      "file-action-secondary",
      "Retracting add arm",
      lucidePath("M12 18v-6"),
      collapsedLucidePath(11, 17),
      1,
      0,
    ),
  ],
  "cloud-cloud-off": [
    strokeLayer(
      "cloud-status-lower",
      "Cloud body",
      lucidePath("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"),
      lucidePath("M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"),
    ),
    strokeLayer(
      "cloud-status-upper",
      "Cloud body end",
      collapsedLucidePath(21.532, 16.5),
      lucidePath("M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"),
      0,
      1,
    ),
    strokeLayer(
      "cloud-status-slash",
      "Cloud offline slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "monitor-play-stop": [
    strokeLayer(
      "screen-control",
      "Screen playback control",
      lucidePath("M10 7.75a.75.75 0 0 1 1.142-.638l3.664 2.249a.75.75 0 0 1 0 1.278l-3.664 2.25a.75.75 0 0 1-1.142-.64z"),
      lucideRoundedRect(9, 7, 6, 6, 1),
    ),
    strokeLayer(
      "screen-stand",
      "Monitor stand",
      lucidePath("M12 17v4"),
      lucidePath("M12 17v4"),
    ),
    strokeLayer(
      "screen-base",
      "Monitor base",
      lucidePath("M8 21h8"),
      lucidePath("M8 21h8"),
    ),
    strokeLayer(
      "screen-frame",
      "Monitor frame",
      lucideRoundedRect(2, 3, 20, 14, 2),
      lucideRoundedRect(2, 3, 20, 14, 2),
    ),
  ],
  "mouse-pointer-click": [
    strokeLayer(
      "pointer-body",
      "Pointer body",
      lucidePath("M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"),
      lucidePath("M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"),
    ),
    strokeLayer(
      "pointer-ray-top-right",
      "Click ray top right",
      lucidePath("M12.586 12.586 19 19"),
      lucidePath("M14 4.1 12 6"),
    ),
    strokeLayer(
      "pointer-ray-left",
      "Click ray left",
      collapsedLucidePath(5.1, 8),
      lucidePath("m5.1 8-2.9-.8"),
      0,
      1,
    ),
    strokeLayer(
      "pointer-ray-bottom-left",
      "Click ray bottom left",
      collapsedLucidePath(6, 12),
      lucidePath("m6 12-1.9 2"),
      0,
      1,
    ),
    strokeLayer(
      "pointer-ray-top-left",
      "Click ray top left",
      collapsedLucidePath(7.2, 2.2),
      lucidePath("M7.2 2.2 8 5.1"),
      0,
      1,
    ),
  ],
  "scan-scan-line": [
    strokeLayer(
      "scanner-top-left",
      "Scanner top left corner",
      lucidePath("M3 7V5a2 2 0 0 1 2-2h2"),
      lucidePath("M3 7V5a2 2 0 0 1 2-2h2"),
    ),
    strokeLayer(
      "scanner-top-right",
      "Scanner top right corner",
      lucidePath("M17 3h2a2 2 0 0 1 2 2v2"),
      lucidePath("M17 3h2a2 2 0 0 1 2 2v2"),
    ),
    strokeLayer(
      "scanner-bottom-right",
      "Scanner bottom right corner",
      lucidePath("M21 17v2a2 2 0 0 1-2 2h-2"),
      lucidePath("M21 17v2a2 2 0 0 1-2 2h-2"),
    ),
    strokeLayer(
      "scanner-bottom-left",
      "Scanner bottom left corner",
      lucidePath("M7 21H5a2 2 0 0 1-2-2v-2"),
      lucidePath("M7 21H5a2 2 0 0 1-2-2v-2"),
    ),
    strokeLayer(
      "scanner-line",
      "Scanning line",
      collapsedLucidePath(7, 12),
      lucidePath("M7 12h10"),
      0,
      1,
    ),
  ],
  "printer-printer-check": [
    strokeLayer(
      "print-body",
      "Printer body",
      lucidePath("M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"),
      lucidePath("M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2"),
    ),
    strokeLayer(
      "print-paper",
      "Printer paper",
      lucidePath("M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"),
      lucidePath("M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"),
    ),
    strokeLayer(
      "print-output",
      "Printed page",
      lucideRoundedRect(6, 14, 12, 8, 1),
      lucidePath("M13.5 22H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v.5"),
    ),
    strokeLayer(
      "print-check",
      "Printed check",
      collapsedLucidePath(16, 19),
      lucidePath("m16 19 2 2 4-4"),
      0,
      1,
    ),
  ],
  "laptop-laptop-check": [
    strokeLayer(
      "device-frame",
      "Laptop frame",
      lucideRoundedRect(3, 4, 18, 12, 2),
      lucideRoundedRect(3, 4, 18, 12, 2),
    ),
    strokeLayer(
      "device-base",
      "Laptop base",
      lucideLine(2, 20, 22, 20),
      lucidePath("M2 20h20"),
    ),
    strokeLayer(
      "device-check",
      "Device check",
      collapsedLucidePath(9, 10),
      lucidePath("m9 10 2 2 4-4"),
      0,
      1,
    ),
  ],
  "receipt-receipt-text": [
    strokeLayer(
      "receipt-outline",
      "Receipt outline",
      lucidePath("M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"),
      lucidePath("M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"),
    ),
    strokeLayer(
      "receipt-content-primary",
      "Receipt amount to text",
      lucidePath("M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"),
      lucidePath("M14 8H8"),
    ),
    strokeLayer(
      "receipt-content-secondary",
      "Receipt currency stem to text",
      lucidePath("M12 17.5v-11"),
      lucidePath("M16 12H8"),
    ),
    strokeLayer(
      "receipt-content-tertiary",
      "Receipt detail line",
      collapsedLucidePath(13, 16),
      lucidePath("M13 16H8"),
      0,
      1,
    ),
  ],
  "list-list-checks": [
    strokeLayer(
      "checklist-bottom-marker",
      "Bottom list marker",
      lucidePath("M3 18h.01"),
      lucidePath("m3 17 2 2 4-4"),
    ),
    strokeLayer(
      "checklist-top-marker",
      "Top list marker",
      lucidePath("M3 6h.01"),
      lucidePath("m3 7 2 2 4-4"),
    ),
    strokeLayer(
      "checklist-middle-marker",
      "Retracting middle marker",
      lucidePath("M3 12h.01"),
      collapsedLucidePath(13, 12),
      1,
      0,
    ),
    strokeLayer(
      "checklist-top-rail",
      "Top list rail",
      lucidePath("M8 6h13"),
      lucidePath("M13 6h8"),
    ),
    strokeLayer(
      "checklist-middle-rail",
      "Middle list rail",
      lucidePath("M8 12h13"),
      lucidePath("M13 12h8"),
    ),
    strokeLayer(
      "checklist-bottom-rail",
      "Bottom list rail",
      lucidePath("M8 18h13"),
      lucidePath("M13 18h8"),
    ),
  ],
  "table-cells-merge-split": [
    strokeLayer(
      "table-action-frame",
      "Table frame",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucideRoundedRect(3, 3, 18, 18, 2),
    ),
    strokeLayer(
      "table-action-top-divider",
      "Top row divider",
      lucidePath("M3 9h18"),
      lucidePath("M3 9h18"),
    ),
    strokeLayer(
      "table-action-bottom-divider",
      "Bottom row divider",
      lucidePath("M3 15h18"),
      lucidePath("M3 15h18"),
    ),
    strokeLayer(
      "table-action-lower-split",
      "Lower cell split",
      lucidePath("M12 21v-6"),
      lucidePath("M12 15V9"),
    ),
    strokeLayer(
      "table-action-upper-split",
      "Retracting upper split",
      lucidePath("M12 9V3"),
      collapsedLucidePath(12, 9),
      1,
      0,
    ),
  ],
  "chart-bar-decrease-increase": [
    strokeLayer(
      "trend-frame",
      "Chart frame",
      lucidePath("M3 3v16a2 2 0 0 0 2 2h16"),
      lucidePath("M3 3v16a2 2 0 0 0 2 2h16"),
    ),
    strokeLayer(
      "trend-middle-bar",
      "Middle trend bar",
      lucidePath("M7 11h8"),
      lucidePath("M7 11h8"),
    ),
    strokeLayer(
      "trend-top-bar",
      "Top trend bar",
      lucidePath("M7 6h12"),
      lucidePath("M7 6h3"),
    ),
    strokeLayer(
      "trend-bottom-bar",
      "Bottom trend bar",
      lucidePath("M7 16h3"),
      lucidePath("M7 16h12"),
    ),
  ],
  "battery-charging-full": [
    strokeLayer(
      "charge-shell-primary",
      "Charging shell to battery shell",
      lucidePath("M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"),
      lucideRoundedRect(2, 7, 16, 10, 2),
    ),
    strokeLayer(
      "charge-shell-secondary",
      "Charging shell to first cell",
      lucidePath("M6 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1"),
      lucideLine(6, 11, 6, 13),
    ),
    strokeLayer(
      "charge-bolt",
      "Charge bolt to middle cell",
      lucidePath("m11 7-3 5h4l-3 5"),
      lucideLine(10, 11, 10, 13),
    ),
    strokeLayer(
      "charge-terminal",
      "Battery terminal",
      lucideLine(22, 11, 22, 13),
      lucideLine(22, 11, 22, 13),
    ),
    strokeLayer(
      "charge-final-cell",
      "Final charge cell",
      collapsedLucidePath(14, 12),
      lucideLine(14, 11, 14, 13),
      0,
      1,
    ),
  ],
  "square-plus-check": [
    strokeLayer(
      "square-action-frame",
      "Action square",
      lucideRoundedRect(3, 3, 18, 18, 2),
      lucideRoundedRect(3, 3, 18, 18, 2),
    ),
    strokeLayer(
      "square-action-primary",
      "Add to complete",
      lucidePath("M8 12h8"),
      lucidePath("m9 12 2 2 4-4"),
    ),
    strokeLayer(
      "square-action-secondary",
      "Retracting add arm",
      lucidePath("M12 8v8"),
      collapsedLucidePath(11, 14),
      1,
      0,
    ),
  ],
  "mail-plus-check": [
    strokeLayer(
      "mail-action-frame",
      "Mail frame",
      lucidePath("M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"),
      lucidePath("M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"),
    ),
    strokeLayer(
      "mail-action-flap",
      "Mail flap",
      lucidePath("m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"),
      lucidePath("m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"),
    ),
    strokeLayer(
      "mail-action-primary",
      "Add to confirm",
      lucidePath("M16 19h6"),
      lucidePath("m16 19 2 2 4-4"),
    ),
    strokeLayer(
      "mail-action-secondary",
      "Retracting add arm",
      lucidePath("M19 16v6"),
      collapsedLucidePath(18, 21),
      1,
      0,
    ),
  ],
  "alarm-clock-plus-check": [
    strokeLayer(
      "alarm-action-face",
      "Alarm face",
      lucideCircle(12, 13, 8),
      lucideCircle(12, 13, 8),
    ),
    strokeLayer(
      "alarm-action-left-bell",
      "Left alarm bell",
      lucidePath("M5 3 2 6"),
      lucidePath("M5 3 2 6"),
    ),
    strokeLayer(
      "alarm-action-right-bell",
      "Right alarm bell",
      lucidePath("m22 6-3-3"),
      lucidePath("m22 6-3-3"),
    ),
    strokeLayer(
      "alarm-action-left-foot",
      "Left alarm foot",
      lucidePath("M6.38 18.7 4 21"),
      lucidePath("M6.38 18.7 4 21"),
    ),
    strokeLayer(
      "alarm-action-right-foot",
      "Right alarm foot",
      lucidePath("M17.64 18.67 20 21"),
      lucidePath("M17.64 18.67 20 21"),
    ),
    strokeLayer(
      "alarm-action-primary",
      "Add to confirm",
      lucidePath("M9 13h6"),
      lucidePath("m9 13 2 2 4-4"),
    ),
    strokeLayer(
      "alarm-action-secondary",
      "Retracting add arm",
      lucidePath("M12 10v6"),
      collapsedLucidePath(11, 15),
      1,
      0,
    ),
  ],
  "timer-timer-reset": [
    strokeLayer(
      "timer-reset-cap",
      "Timer cap",
      lucideLine(10, 2, 14, 2),
      lucidePath("M10 2h4"),
    ),
    strokeLayer(
      "timer-reset-hand",
      "Timer hand",
      lucideLine(12, 14, 15, 11),
      lucidePath("M12 14v-4"),
    ),
    strokeLayer(
      "timer-reset-face",
      "Timer face to reset arc",
      lucideCircle(12, 14, 8),
      lucidePath("M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6"),
    ),
    strokeLayer(
      "timer-reset-arrow",
      "Reset arrow",
      collapsedLucidePath(9, 17),
      lucidePath("M9 17H4v5"),
      0,
      1,
    ),
  ],
  "power-power-off": [
    strokeLayer(
      "power-off-stem",
      "Power stem",
      lucidePath("M12 2v10"),
      lucidePath("M12 2v4"),
    ),
    strokeLayer(
      "power-off-lower",
      "Power ring",
      lucidePath("M18.4 6.6a9 9 0 1 1-12.77.04"),
      lucidePath("M6.16 6.16a9 9 0 1 0 12.68 12.68"),
    ),
    strokeLayer(
      "power-off-upper",
      "Power ring end",
      collapsedLucidePath(18.36, 6.64),
      lucidePath("M18.36 6.64A9 9 0 0 1 20.77 15"),
      0,
      1,
    ),
    strokeLayer(
      "power-off-slash",
      "Power off slash",
      collapsedLucidePath(2, 2),
      lucideLine(2, 2, 22, 22),
      0,
      1,
    ),
  ],
  "circle-pause-play": [
    strokeLayer(
      "circle-media-frame",
      "Media circle",
      lucideCircle(12, 12, 10),
      lucideCircle(12, 12, 10),
    ),
    strokeLayer(
      "circle-media-primary",
      "Pause bar to play symbol",
      lucideLine(10, 15, 10, 9),
      lucidePolygon("10 8 16 12 10 16 10 8"),
    ),
    strokeLayer(
      "circle-media-secondary",
      "Retracting pause bar",
      lucideLine(14, 15, 14, 9),
      collapsedLucidePath(10, 12),
      1,
      0,
    ),
  ],
}

export function applyPresetEndpointDesign(asset: MorphAsset): MorphAsset {
  const layers = endpointPresets[asset.id]
  if (!layers) throw new Error(`Missing Lucide endpoint design for ${asset.id}.`)

  return {
    ...asset,
    layers: layers.map((layer) => ({ ...layer })),
  }
}

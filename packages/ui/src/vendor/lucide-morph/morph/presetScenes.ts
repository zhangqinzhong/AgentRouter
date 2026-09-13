import type { MorphAsset, MorphLayer } from "./types"

type Point = {
  x: number
  y: number
}

type CubicSegment = {
  p0: Point
  p1: Point
  p2: Point
  p3: Point
}

type CubicSubpath = {
  start: Point
  segments: CubicSegment[]
}

type LayerScene = {
  loading: string | ((layer: MorphLayer) => string)
  loadingOpacity: number
}

type PresetScene = {
  label: string
  rotationCenter?: Point
  rotationDirection: "clockwise" | "counterclockwise"
  rotationDuration: number
  layers: Record<string, LayerScene>
}

const pathTokenRE = /[MLCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/g
const commandRE = /^[MLCZ]$/
const loaderCenter = 12
const loaderRadius = 9

function lerpPoint(from: Point, to: Point, progress: number): Point {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  }
}

function lineAsCubic(from: Point, to: Point): CubicSegment {
  return {
    p0: from,
    p1: lerpPoint(from, to, 1 / 3),
    p2: lerpPoint(from, to, 2 / 3),
    p3: to,
  }
}

function splitCubic(
  segment: CubicSegment,
  progress: number,
): [CubicSegment, CubicSegment] {
  const p01 = lerpPoint(segment.p0, segment.p1, progress)
  const p12 = lerpPoint(segment.p1, segment.p2, progress)
  const p23 = lerpPoint(segment.p2, segment.p3, progress)
  const p012 = lerpPoint(p01, p12, progress)
  const p123 = lerpPoint(p12, p23, progress)
  const midpoint = lerpPoint(p012, p123, progress)

  return [
    { p0: segment.p0, p1: p01, p2: p012, p3: midpoint },
    { p0: midpoint, p1: p123, p2: p23, p3: segment.p3 },
  ]
}

function subdivideCubic(segment: CubicSegment, parts: number) {
  const segments: CubicSegment[] = []
  let remainder = segment

  for (let remainingParts = parts; remainingParts > 1; remainingParts -= 1) {
    const [head, tail] = splitCubic(remainder, 1 / remainingParts)
    segments.push(head)
    remainder = tail
  }

  segments.push(remainder)
  return segments
}

function parsePath(path: string): CubicSubpath[] {
  const unsupported = path.replace(pathTokenRE, "").replace(/[\s,]+/g, "")
  if (unsupported) {
    throw new Error(`Unsupported SVG path syntax: ${unsupported}`)
  }

  const tokens = path.match(pathTokenRE) ?? []
  const subpaths: CubicSubpath[] = []
  let index = 0
  let currentPoint: Point | undefined
  let currentSubpath: CubicSubpath | undefined

  const readNumber = () => {
    const token = tokens[index]
    if (token === undefined || commandRE.test(token)) {
      throw new Error("Invalid SVG path number sequence.")
    }

    index += 1
    return Number(token)
  }

  const readPoint = (): Point => ({ x: readNumber(), y: readNumber() })

  while (index < tokens.length) {
    const command = tokens[index]
    index += 1

    if (!commandRE.test(command)) {
      throw new Error(`Expected an SVG path command, received ${command}.`)
    }

    if (command === "M") {
      currentPoint = readPoint()
      currentSubpath = { start: currentPoint, segments: [] }
      subpaths.push(currentSubpath)
      continue
    }

    if (!currentPoint || !currentSubpath) {
      throw new Error("SVG path must begin with M.")
    }

    if (command === "L") {
      const end = readPoint()
      currentSubpath.segments.push(lineAsCubic(currentPoint, end))
      currentPoint = end
      continue
    }

    if (command === "C") {
      const p1 = readPoint()
      const p2 = readPoint()
      const p3 = readPoint()
      currentSubpath.segments.push({ p0: currentPoint, p1, p2, p3 })
      currentPoint = p3
      continue
    }

    const end = currentSubpath.start
    currentSubpath.segments.push(lineAsCubic(currentPoint, end))
    currentPoint = end
  }

  if (
    subpaths.length === 0 ||
    subpaths.some((subpath) => subpath.segments.length === 0)
  ) {
    throw new Error("Every SVG subpath must contain at least one segment.")
  }

  return subpaths
}

function expandSubpath(subpath: CubicSubpath, targetCount: number) {
  if (targetCount < subpath.segments.length) {
    throw new Error("Scene paths cannot discard cubic segments.")
  }

  const baseParts = Math.floor(targetCount / subpath.segments.length)
  const remainder = targetCount % subpath.segments.length

  return {
    start: subpath.start,
    segments: subpath.segments.flatMap((segment, index) =>
      subdivideCubic(segment, baseParts + (index < remainder ? 1 : 0)),
    ),
  }
}

function normalizeScenePaths(from: string, loading: string, to: string) {
  const states = [parsePath(from), parsePath(loading), parsePath(to)]
  const subpathCount = states[0].length
  if (states.some((state) => state.length !== subpathCount)) {
    throw new Error(
      `Scene states must use the same number of subpaths (${states
        .map((state) => state.length)
        .join("/")}).`,
    )
  }

  const normalized = states.map((state) =>
    state.map((subpath, index) => {
      const targetCount = Math.max(
        ...states.map((candidate) => candidate[index].segments.length),
      )
      return expandSubpath(subpath, targetCount)
    }),
  )

  return {
    from: serializePath(normalized[0]),
    loading: serializePath(normalized[1]),
    to: serializePath(normalized[2]),
  }
}

function formatPathNumber(value: number) {
  const rounded = Number(value.toFixed(4))
  return Object.is(rounded, -0) ? "0" : rounded.toString()
}

function serializePath(subpaths: CubicSubpath[]) {
  return subpaths
    .map((subpath) => {
      const commands = subpath.segments.map(
        (segment) =>
          `C${formatPathNumber(segment.p1.x)} ${formatPathNumber(
            segment.p1.y,
          )} ${formatPathNumber(segment.p2.x)} ${formatPathNumber(
            segment.p2.y,
          )} ${formatPathNumber(segment.p3.x)} ${formatPathNumber(
            segment.p3.y,
          )}`,
      )

      return `M${formatPathNumber(subpath.start.x)} ${formatPathNumber(
        subpath.start.y,
      )} ${commands.join(" ")}`
    })
    .join(" ")
}

function pointOnCircle(angle: number, radius = loaderRadius): Point {
  return {
    x: loaderCenter + Math.cos(angle) * radius,
    y: loaderCenter + Math.sin(angle) * radius,
  }
}

function createArcSegment(
  startAngle: number,
  endAngle: number,
  radius = loaderRadius,
): CubicSegment {
  const p0 = pointOnCircle(startAngle, radius)
  const p3 = pointOnCircle(endAngle, radius)
  const handle = radius * (4 / 3) * Math.tan((endAngle - startAngle) / 4)

  return {
    p0,
    p1: {
      x: p0.x - Math.sin(startAngle) * handle,
      y: p0.y + Math.cos(startAngle) * handle,
    },
    p2: {
      x: p3.x + Math.sin(endAngle) * handle,
      y: p3.y - Math.cos(endAngle) * handle,
    },
    p3,
  }
}

function degrees(value: number) {
  return (value * Math.PI) / 180
}

function arcSegments(
  startDegrees: number,
  endDegrees: number,
  segmentCount: number,
  radius = loaderRadius,
) {
  const start = degrees(startDegrees)
  const end = degrees(endDegrees)
  const sweep = (end - start) / segmentCount

  return Array.from({ length: segmentCount }, (_, index) =>
    createArcSegment(start + sweep * index, start + sweep * (index + 1), radius),
  )
}

function loaderArc(
  startDegrees: number,
  endDegrees: number,
  segmentCount: number,
  radius = loaderRadius,
) {
  const segments = arcSegments(startDegrees, endDegrees, segmentCount, radius)
  return serializePath([{ start: segments[0].p0, segments }])
}

function collapsedPath(
  points: Array<{ point: Point; segmentCount: number }>,
) {
  return serializePath(
    points.map(({ point, segmentCount }) => ({
      start: point,
      segments: Array.from({ length: segmentCount }, () => ({
        p0: point,
        p1: point,
        p2: point,
        p3: point,
      })),
    })),
  )
}

function collapsedAt(point: Point, segmentCount: number) {
  return collapsedPath([{ point, segmentCount }])
}

const loaderGapEnd = pointOnCircle(degrees(288))

// Keep the most recognizable silhouette responsible for the loading motion.
// Secondary marks retreat to the center and only return after the gap closes.
function createOutlineScene(
  label: string,
  outlineLayerIds: string[],
  detailLayerIds: string[],
  rotationDirection: PresetScene["rotationDirection"] = "clockwise",
  rotationDuration = 900,
  radius = loaderRadius,
): PresetScene {
  const sweep = 288 / outlineLayerIds.length

  return {
    label,
    rotationDirection,
    rotationDuration,
    layers: Object.fromEntries(
      [
        ...outlineLayerIds.map((layerId, index) => {
          const start = sweep * index
          const end = sweep * (index + 1)
          return [
            layerId,
            {
              loading: loaderArc(
                start,
                end,
                Math.max(1, Math.ceil((end - start) / 90)),
                radius,
              ),
              loadingOpacity: 1,
            },
          ] as const
        }),
        ...detailLayerIds.map(
          (layerId) =>
            [
              layerId,
              {
                loading: collapsedAt({ x: loaderCenter, y: loaderCenter }, 1),
                loadingOpacity: 0,
              },
            ] as const,
        ),
      ],
    ),
  }
}

// Menu rails curl in sequence and stitch themselves into the loader.
const menuToXScene: PresetScene = {
  label: "Loading",
  rotationDirection: "clockwise",
  rotationDuration: 820,
  layers: {
    "menu-top": { loading: loaderArc(0, 96, 2), loadingOpacity: 1 },
    "menu-middle": { loading: loaderArc(96, 192, 2), loadingOpacity: 1 },
    "menu-bottom": { loading: loaderArc(192, 288, 2), loadingOpacity: 1 },
  },
}

// The Play outline opens into one sweep while both Pause bars form the exit.
const playToPauseScene: PresetScene = {
  label: "Buffering",
  rotationDirection: "clockwise",
  rotationDuration: 900,
  layers: {
    "play-left": { loading: loaderArc(0, 180, 3), loadingOpacity: 1 },
    "play-right": { loading: loaderArc(180, 288, 2), loadingOpacity: 1 },
  },
}

// Plus arms bend in opposite directions before straightening into a check.
const plusToCheckScene: PresetScene = {
  label: "Saving",
  rotationDirection: "clockwise",
  rotationDuration: 860,
  layers: {
    "plus-horizontal": { loading: loaderArc(0, 144, 2), loadingOpacity: 1 },
    "plus-vertical": { loading: loaderArc(144, 288, 2), loadingOpacity: 1 },
  },
}

// The arrow shaft makes the long sweep while its wings close the ring.
const arrowDownToUpScene: PresetScene = {
  label: "Transferring",
  rotationDirection: "clockwise",
  rotationDuration: 760,
  layers: {
    "arrow-shaft": { loading: loaderArc(0, 144, 2), loadingOpacity: 1 },
    "arrow-left": { loading: loaderArc(144, 216, 1), loadingOpacity: 1 },
    "arrow-right": { loading: loaderArc(216, 288, 1), loadingOpacity: 1 },
  },
}

// The search handle retracts; the lens itself opens into LoaderCircle.
const searchToXScene: PresetScene = {
  label: "Searching",
  rotationDirection: "clockwise",
  rotationDuration: 900,
  layers: {
    "search-ring": { loading: loaderArc(0, 288, 4), loadingOpacity: 1 },
    "search-handle": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
  },
}

// The eye outline rounds into the loader while pupil and slash withdraw.
const eyeToEyeOffScene: PresetScene = {
  label: "Updating visibility",
  rotationDirection: "clockwise",
  rotationDuration: 1080,
  layers: {
    "eye-outline": { loading: loaderArc(0, 288, 4), loadingOpacity: 1 },
    "eye-pupil": {
      loading: collapsedAt({ x: 12, y: 12 }, 4),
      loadingOpacity: 0,
    },
    "eye-lower-outline": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "eye-slash": { loading: collapsedAt(loaderGapEnd, 1), loadingOpacity: 0 },
  },
}

// The bell dome becomes the ring and the clapper tucks into its lower edge.
const bellToBellOffScene: PresetScene = {
  label: "Updating notifications",
  rotationDirection: "clockwise",
  rotationDuration: 960,
  layers: {
    "bell-body": { loading: loaderArc(0, 288, 5), loadingOpacity: 1 },
    "bell-clapper": {
      loading: collapsedAt({ x: 12, y: 21 }, 1),
      loadingOpacity: 0,
    },
    "bell-upper": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "bell-slash": { loading: collapsedAt(loaderGapEnd, 1), loadingOpacity: 0 },
  },
}

// Sound waves continue around the speaker body to complete the loader.
const volumeToMuteScene: PresetScene = {
  label: "Updating audio",
  rotationDirection: "clockwise",
  rotationDuration: 780,
  layers: {
    "volume-speaker": { loading: loaderArc(144, 288, 6), loadingOpacity: 1 },
    "volume-wave-upper": { loading: loaderArc(0, 72, 2), loadingOpacity: 1 },
    "volume-wave-lower": { loading: loaderArc(72, 144, 2), loadingOpacity: 1 },
  },
}

// Capsule, stand, and base curl into consecutive microphone-ring segments.
const micToMicOffScene: PresetScene = {
  label: "Updating microphone",
  rotationDirection: "clockwise",
  rotationDuration: 880,
  layers: {
    "mic-capsule": { loading: loaderArc(0, 150, 6), loadingOpacity: 1 },
    "mic-capsule-lower": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "mic-stand": { loading: loaderArc(150, 240, 2), loadingOpacity: 1 },
    "mic-stand-upper": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "mic-base": {
      loading: loaderArc(240, 288, 2),
      loadingOpacity: 1,
    },
    "mic-slash": { loading: collapsedAt(loaderGapEnd, 1), loadingOpacity: 0 },
  },
}

// Shackle and body open from opposite sides and meet as a loading ring.
const lockToUnlockScene: PresetScene = {
  label: "Updating access",
  rotationDirection: "clockwise",
  rotationDuration: 980,
  layers: {
    "lock-body": { loading: loaderArc(120, 288, 4), loadingOpacity: 1 },
    "lock-shackle": { loading: loaderArc(0, 120, 4), loadingOpacity: 1 },
  },
}

// Heart lobes relax into one continuous circular stroke.
const heartToHeartOffScene: PresetScene = {
  label: "Updating favorite",
  rotationDirection: "clockwise",
  rotationDuration: 1040,
  layers: {
    "heart-body": { loading: loaderArc(0, 288, 6), loadingOpacity: 1 },
    "heart-upper": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "heart-slash": { loading: collapsedAt(loaderGapEnd, 1), loadingOpacity: 0 },
  },
}

// Star points are smoothed one edge at a time into LoaderCircle.
const starToStarOffScene: PresetScene = {
  label: "Updating star",
  rotationDirection: "clockwise",
  rotationDuration: 900,
  layers: {
    "star-body": { loading: loaderArc(0, 288, 10), loadingOpacity: 1 },
    "star-upper": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "star-slash": { loading: collapsedAt(loaderGapEnd, 1), loadingOpacity: 0 },
  },
}

// The bookmark ribbon rounds out; its check waits at the loader gap.
const bookmarkToSavedScene: PresetScene = {
  label: "Saving bookmark",
  rotationDirection: "clockwise",
  rotationDuration: 940,
  layers: {
    "bookmark-ribbon": { loading: loaderArc(0, 288, 5), loadingOpacity: 1 },
    "bookmark-check-short": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "bookmark-check-long": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
  },
}

// The calendar frame rounds into the loader as bindings and check retract.
const calendarToConfirmedScene: PresetScene = {
  label: "Scheduling",
  rotationDirection: "clockwise",
  rotationDuration: 840,
  layers: {
    "calendar-frame": { loading: loaderArc(0, 288, 4), loadingOpacity: 1 },
    "calendar-top-rule": {
      loading: collapsedAt({ x: 12, y: 3 }, 1),
      loadingOpacity: 0,
    },
    "calendar-rings": {
      loading: collapsedPath([
        { point: { x: 21, y: 12 }, segmentCount: 1 },
        { point: loaderGapEnd, segmentCount: 1 },
      ]),
      loadingOpacity: 0,
    },
    "calendar-check-short": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "calendar-check-long": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
  },
}

// Paper-plane edges spiral into two arcs before resolving as a check.
const sendToCheckScene: PresetScene = {
  label: "Sending",
  rotationDirection: "clockwise",
  rotationDuration: 720,
  layers: {
    "send-short-check": { loading: loaderArc(0, 96, 2), loadingOpacity: 1 },
    "send-long-check": { loading: loaderArc(96, 288, 3), loadingOpacity: 1 },
  },
}

// Filter bars bow progressively into three ordered loader sections.
const filterToListScene: PresetScene = {
  label: "Applying filters",
  rotationDirection: "clockwise",
  rotationDuration: 820,
  layers: {
    "filter-top": { loading: loaderArc(0, 96, 2), loadingOpacity: 1 },
    "filter-middle": { loading: loaderArc(96, 192, 2), loadingOpacity: 1 },
    "filter-bottom": { loading: loaderArc(192, 288, 2), loadingOpacity: 1 },
  },
}

// Chevron wings keep their symmetry while curling into opposing half-rings.
const chevronDownToUpScene: PresetScene = {
  label: "Loading",
  rotationDirection: "clockwise",
  rotationDuration: 800,
  layers: {
    "chevron-left": { loading: loaderArc(0, 144, 2), loadingOpacity: 1 },
    "chevron-right": { loading: loaderArc(144, 288, 2), loadingOpacity: 1 },
  },
}

// Sun rays retract into the core, which grows into LoaderCircle and then a moon.
const sunToMoonScene: PresetScene = {
  label: "Switching theme",
  rotationDirection: "clockwise",
  rotationDuration: 1100,
  layers: {
    "sun-core": { loading: loaderArc(0, 288, 5), loadingOpacity: 1 },
    "sun-ray-vertical": {
      loading: collapsedPath([
        { point: { x: 12, y: 12 }, segmentCount: 1 },
        { point: { x: 12, y: 12 }, segmentCount: 1 },
      ]),
      loadingOpacity: 0,
    },
    "sun-ray-horizontal": {
      loading: collapsedPath([
        { point: { x: 12, y: 12 }, segmentCount: 1 },
        { point: { x: 12, y: 12 }, segmentCount: 1 },
      ]),
      loadingOpacity: 0,
    },
    "sun-ray-diagonal-a": {
      loading: collapsedPath([
        { point: { x: 12, y: 12 }, segmentCount: 1 },
        { point: { x: 12, y: 12 }, segmentCount: 1 },
      ]),
      loadingOpacity: 0,
    },
    "sun-ray-diagonal-b": {
      loading: collapsedPath([
        { point: { x: 12, y: 12 }, segmentCount: 1 },
        { point: { x: 12, y: 12 }, segmentCount: 1 },
      ]),
      loadingOpacity: 0,
    },
  },
}

// Folder tab leads the curl and its body completes the longer lower sweep.
const folderToOpenScene: PresetScene = {
  label: "Opening folder",
  rotationDirection: "clockwise",
  rotationDuration: 920,
  layers: {
    "folder-tab": { loading: loaderArc(0, 120, 3), loadingOpacity: 1 },
    "folder-body": { loading: loaderArc(120, 288, 3), loadingOpacity: 1 },
  },
}

// The document outline becomes the loader; fold and check gather at its gap.
const fileToApprovedScene: PresetScene = {
  label: "Checking file",
  rotationDirection: "clockwise",
  rotationDuration: 900,
  layers: {
    "file-outline": { loading: loaderArc(0, 288, 5), loadingOpacity: 1 },
    "file-fold": { loading: collapsedAt(loaderGapEnd, 2), loadingOpacity: 0 },
    "file-check-short": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
    "file-check-long": {
      loading: collapsedAt(loaderGapEnd, 1),
      loadingOpacity: 0,
    },
  },
}

// The power ring is already a complete loading track with a natural gap.
// Keep it intact and only withdraw the stem; the off details return afterward.
const powerOnToOffScene: PresetScene = {
  label: "Powering off",
  rotationCenter: { x: 12, y: 13 },
  rotationDirection: "clockwise",
  rotationDuration: 840,
  layers: {
    "power-off-lower": {
      loading: (layer) => layer.from,
      loadingOpacity: 1,
    },
    "power-off-upper": {
      loading: collapsedAt({ x: loaderCenter, y: loaderCenter }, 1),
      loadingOpacity: 0,
    },
    "power-off-stem": {
      loading: collapsedAt({ x: loaderCenter, y: loaderCenter }, 1),
      loadingOpacity: 0,
    },
    "power-off-slash": {
      loading: collapsedAt({ x: loaderCenter, y: loaderCenter }, 1),
      loadingOpacity: 0,
    },
  },
}

const presetScenes: Record<string, PresetScene> = {
  "menu-x": menuToXScene,
  "play-pause": playToPauseScene,
  "plus-check": plusToCheckScene,
  "arrow-down-up": arrowDownToUpScene,
  "search-x": searchToXScene,
  "eye-eye-off": eyeToEyeOffScene,
  "bell-bell-off": bellToBellOffScene,
  "volume-volume-x": volumeToMuteScene,
  "mic-mic-off": micToMicOffScene,
  "lock-lock-open": lockToUnlockScene,
  "heart-heart-off": heartToHeartOffScene,
  "star-star-off": starToStarOffScene,
  "bookmark-bookmark-check": bookmarkToSavedScene,
  "calendar-calendar-check": calendarToConfirmedScene,
  "send-check": sendToCheckScene,
  "filter-list-filter": filterToListScene,
  "chevron-down-up": chevronDownToUpScene,
  "sun-moon": sunToMoonScene,
  "folder-folder-open": folderToOpenScene,
  "file-file-check": fileToApprovedScene,
  "collapse-sidebar-to-expand-inspector": createOutlineScene(
    "Switching panel",
    ["workspace-frame"],
    ["workspace-divider", "workspace-arrow"],
    "clockwise",
    840,
  ),
  "maximize-minimize": createOutlineScene(
    "Resizing view",
    ["fullscreen-corner-a", "fullscreen-corner-b"],
    ["fullscreen-diagonal-a", "fullscreen-diagonal-b"],
    "clockwise",
    780,
  ),
  "layout-grid-list": createOutlineScene(
    "Changing view",
    ["view-item-a", "view-item-b", "view-item-c", "view-item-d"],
    ["view-item-e", "view-item-f"],
    "clockwise",
    860,
  ),
  "columns-rows": createOutlineScene(
    "Rotating layout",
    ["layout-frame"],
    ["layout-divider"],
    "clockwise",
    880,
  ),
  "undo-redo": createOutlineScene(
    "Updating history",
    ["history-curve"],
    ["history-arrow"],
    "clockwise",
    760,
  ),
  "rotate-ccw-cw": createOutlineScene(
    "Changing direction",
    ["rotate-orbit"],
    ["rotate-corner"],
    "clockwise",
    780,
  ),
  "zoom-in-out": createOutlineScene(
    "Updating zoom",
    ["zoom-ring"],
    ["zoom-handle", "zoom-horizontal", "zoom-vertical"],
    "clockwise",
    820,
    8,
  ),
  "pin-pin-off": createOutlineScene(
    "Updating pin",
    ["pin-body"],
    ["pin-stem", "pin-upper", "pin-slash"],
    "clockwise",
    900,
  ),
  "link-unlink": createOutlineScene(
    "Updating link",
    ["link-upper", "link-lower"],
    ["unlink-mark-a", "unlink-mark-b", "unlink-mark-c", "unlink-mark-d"],
    "clockwise",
    860,
  ),
  "cloud-download-upload": createOutlineScene(
    "Transferring",
    ["cloud-body"],
    ["cloud-arrow-primary", "cloud-arrow-secondary"],
    "clockwise",
    800,
  ),
  "mail-mail-open": createOutlineScene(
    "Opening mail",
    ["mail-frame"],
    ["mail-flap"],
    "clockwise",
    900,
  ),
  "user-plus-check": createOutlineScene(
    "Adding user",
    ["user-head"],
    ["user-body", "user-action-horizontal", "user-action-vertical"],
    "clockwise",
    840,
  ),
  "toggle-left-right": createOutlineScene(
    "Updating toggle",
    ["toggle-thumb"],
    ["toggle-track"],
    "clockwise",
    740,
  ),
  "align-left-right": createOutlineScene(
    "Aligning content",
    ["align-top", "align-middle", "align-bottom"],
    [],
    "clockwise",
    760,
  ),
  "image-image-off": createOutlineScene(
    "Updating image",
    ["image-frame-lower", "image-frame-upper"],
    ["image-sun", "image-mountain", "image-ridge", "image-slash"],
    "clockwise",
    940,
  ),
  "wifi-wifi-off": createOutlineScene(
    "Updating connection",
    ["wifi-outer-left", "wifi-outer-right"],
    ["wifi-dot", "wifi-inner", "wifi-middle-left", "wifi-middle-right", "wifi-slash"],
    "clockwise",
    880,
  ),
  "circle-play-stop": createOutlineScene(
    "Updating playback",
    ["media-circle"],
    ["media-control"],
    "clockwise",
    780,
    10,
  ),
  "archive-restore": createOutlineScene(
    "Restoring archive",
    ["archive-lid", "archive-body-left", "archive-body-right"],
    ["archive-action", "archive-shaft"],
    "clockwise",
    900,
  ),
  "log-in-out": createOutlineScene(
    "Updating session",
    ["session-door"],
    ["session-arrow", "session-shaft"],
    "clockwise",
    820,
  ),
  "copy-clipboard-check": createOutlineScene(
    "Copying",
    ["copy-front", "copy-back"],
    ["copy-check"],
    "clockwise",
    800,
  ),
  "message-message-off": createOutlineScene(
    "Updating messages",
    ["message-lower", "message-upper"],
    ["message-slash"],
    "clockwise",
    920,
  ),
  "battery-low-full": createOutlineScene(
    "Charging battery",
    ["battery-shell"],
    ["battery-terminal", "battery-cell-low", "battery-cell-middle", "battery-cell-full"],
    "clockwise",
    820,
  ),
  "signal-low-high": createOutlineScene(
    "Improving signal",
    ["signal-origin"],
    ["signal-low-bar", "signal-middle-bar", "signal-high-bar"],
    "clockwise",
    780,
  ),
  "volume-low-high": createOutlineScene(
    "Raising volume",
    ["volume-level-outer"],
    ["volume-level-speaker", "volume-level-inner"],
    "clockwise",
    760,
  ),
  "shield-shield-check": createOutlineScene(
    "Verifying",
    ["shield-outline"],
    ["shield-check"],
    "clockwise",
    880,
  ),
  "camera-camera-off": createOutlineScene(
    "Updating camera",
    ["camera-frame-lower", "camera-frame-upper"],
    ["camera-lens", "camera-slash"],
    "clockwise",
    900,
  ),
  "video-video-off": createOutlineScene(
    "Updating video",
    ["video-body", "video-lens"],
    ["video-slash"],
    "clockwise",
    860,
  ),
  "bluetooth-bluetooth-off": createOutlineScene(
    "Updating Bluetooth",
    ["bluetooth-lower", "bluetooth-upper"],
    ["bluetooth-slash"],
    "clockwise",
    840,
  ),
  "navigation-navigation-off": createOutlineScene(
    "Updating navigation",
    ["navigation-lower", "navigation-upper"],
    ["navigation-slash"],
    "clockwise",
    900,
  ),
  "map-pin-map-pin-check": createOutlineScene(
    "Confirming location",
    ["location-pin"],
    ["location-dot", "location-check"],
    "clockwise",
    860,
  ),
  "package-package-open": createOutlineScene(
    "Opening package",
    ["package-shell"],
    ["package-spine", "package-fold", "package-flap"],
    "clockwise",
    940,
  ),
  "door-closed-open": createOutlineScene(
    "Opening door",
    ["door-frame"],
    ["door-threshold-left", "door-threshold-right", "door-handle", "door-panel"],
    "clockwise",
    920,
  ),
  "panel-bottom-close-open": createOutlineScene(
    "Updating panel",
    ["bottom-panel-frame"],
    ["bottom-panel-divider", "bottom-panel-arrow"],
    "clockwise",
    800,
  ),
  "circle-plus-check": createOutlineScene(
    "Completing action",
    ["circle-action-frame"],
    ["circle-action-primary", "circle-action-secondary"],
    "clockwise",
    780,
    10,
  ),
  "circle-alert-check": createOutlineScene(
    "Resolving alert",
    ["circle-status-frame"],
    ["circle-status-primary", "circle-status-dot"],
    "clockwise",
    820,
    10,
  ),
  "clipboard-clipboard-check": createOutlineScene(
    "Checking clipboard",
    ["clipboard-frame"],
    ["clipboard-clip", "clipboard-check"],
    "clockwise",
    820,
  ),
  "calendar-plus-check": createOutlineScene(
    "Confirming event",
    ["event-calendar-frame"],
    [
      "event-calendar-left-ring",
      "event-calendar-right-ring",
      "event-calendar-divider",
      "event-calendar-action",
      "event-calendar-add-arm",
    ],
    "clockwise",
    900,
  ),
  "user-plus-minus": createOutlineScene(
    "Updating membership",
    ["membership-head"],
    ["membership-body", "membership-horizontal", "membership-vertical"],
    "clockwise",
    820,
  ),
  "bookmark-plus-check": createOutlineScene(
    "Saving bookmark",
    ["bookmark-action-ribbon"],
    ["bookmark-action-primary", "bookmark-action-secondary"],
    "clockwise",
    820,
  ),
  "folder-plus-check": createOutlineScene(
    "Creating folder",
    ["folder-action-frame"],
    ["folder-action-primary", "folder-action-secondary"],
    "clockwise",
    860,
  ),
  "file-plus-check": createOutlineScene(
    "Creating file",
    ["file-action-outline"],
    ["file-action-fold", "file-action-primary", "file-action-secondary"],
    "clockwise",
    860,
  ),
  "cloud-cloud-off": createOutlineScene(
    "Updating cloud",
    ["cloud-status-lower", "cloud-status-upper"],
    ["cloud-status-slash"],
    "clockwise",
    900,
  ),
  "monitor-play-stop": createOutlineScene(
    "Updating playback",
    ["screen-frame"],
    ["screen-control", "screen-stand", "screen-base"],
    "clockwise",
    820,
  ),
  "mouse-pointer-click": createOutlineScene(
    "Clicking",
    ["pointer-body"],
    ["pointer-ray-top-right", "pointer-ray-left", "pointer-ray-bottom-left", "pointer-ray-top-left"],
    "clockwise",
    760,
  ),
  "scan-scan-line": createOutlineScene(
    "Scanning",
    ["scanner-top-left", "scanner-top-right", "scanner-bottom-right", "scanner-bottom-left"],
    ["scanner-line"],
    "clockwise",
    820,
  ),
  "printer-printer-check": createOutlineScene(
    "Printing",
    ["print-body", "print-paper"],
    ["print-output", "print-check"],
    "clockwise",
    900,
  ),
  "laptop-laptop-check": createOutlineScene(
    "Verifying device",
    ["device-frame"],
    ["device-base", "device-check"],
    "clockwise",
    840,
  ),
  "receipt-receipt-text": createOutlineScene(
    "Preparing receipt",
    ["receipt-outline"],
    ["receipt-content-primary", "receipt-content-secondary", "receipt-content-tertiary"],
    "clockwise",
    880,
  ),
  "list-list-checks": createOutlineScene(
    "Building checklist",
    ["checklist-top-rail", "checklist-middle-rail", "checklist-bottom-rail"],
    ["checklist-top-marker", "checklist-middle-marker", "checklist-bottom-marker"],
    "clockwise",
    860,
  ),
  "table-cells-merge-split": createOutlineScene(
    "Updating table cells",
    ["table-action-frame"],
    [
      "table-action-top-divider",
      "table-action-bottom-divider",
      "table-action-lower-split",
      "table-action-upper-split",
    ],
    "clockwise",
    860,
  ),
  "chart-bar-decrease-increase": createOutlineScene(
    "Updating trend",
    ["trend-frame"],
    ["trend-middle-bar", "trend-top-bar", "trend-bottom-bar"],
    "clockwise",
    820,
  ),
  "battery-charging-full": createOutlineScene(
    "Finishing charge",
    ["charge-shell-primary", "charge-shell-secondary"],
    ["charge-bolt", "charge-terminal", "charge-final-cell"],
    "clockwise",
    840,
  ),
  "square-plus-check": createOutlineScene(
    "Completing action",
    ["square-action-frame"],
    ["square-action-primary", "square-action-secondary"],
    "clockwise",
    780,
  ),
  "mail-plus-check": createOutlineScene(
    "Confirming mail",
    ["mail-action-frame"],
    ["mail-action-flap", "mail-action-primary", "mail-action-secondary"],
    "clockwise",
    860,
  ),
  "alarm-clock-plus-check": createOutlineScene(
    "Confirming alarm",
    ["alarm-action-face"],
    [
      "alarm-action-left-bell",
      "alarm-action-right-bell",
      "alarm-action-left-foot",
      "alarm-action-right-foot",
      "alarm-action-primary",
      "alarm-action-secondary",
    ],
    "clockwise",
    900,
    8,
  ),
  "timer-timer-reset": createOutlineScene(
    "Resetting timer",
    ["timer-reset-face"],
    ["timer-reset-cap", "timer-reset-hand", "timer-reset-arrow"],
    "clockwise",
    860,
    8,
  ),
  "power-power-off": powerOnToOffScene,
  // The existing 10px media ring is already the ideal loader. It opens in
  // place while the pause bars retreat, then closes around the emerging play.
  "circle-pause-play": createOutlineScene(
    "Updating playback",
    ["circle-media-frame"],
    ["circle-media-primary", "circle-media-secondary"],
    "clockwise",
    780,
    10,
  ),
}

function applyLayerScene(layer: MorphLayer, scene: LayerScene): MorphLayer {
  let paths
  try {
    const loading =
      typeof scene.loading === "function" ? scene.loading(layer) : scene.loading
    paths = normalizeScenePaths(layer.from, loading, layer.to)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${layer.id}: ${message}`)
  }

  return {
    ...layer,
    ...paths,
    loadingOpacity: scene.loadingOpacity,
  }
}

export function applyPresetSceneDesign(asset: MorphAsset): MorphAsset {
  const scene = presetScenes[asset.id]
  if (!scene) {
    throw new Error(`Missing scene design for ${asset.id}.`)
  }

  const layers = asset.layers.map((layer) => {
    const layerScene = scene.layers[layer.id]
    if (!layerScene) {
      throw new Error(`Missing scene design for ${asset.id}/${layer.id}.`)
    }

    return applyLayerScene(layer, layerScene)
  })

  if (Object.keys(scene.layers).length !== layers.length) {
    throw new Error(`Scene design for ${asset.id} contains unknown layers.`)
  }

  return {
    ...asset,
    loading: {
      enabled: true,
      label: scene.label,
      rotationCenter: scene.rotationCenter,
      rotationDirection: scene.rotationDirection,
      rotationDuration: scene.rotationDuration,
    },
    layers,
  }
}

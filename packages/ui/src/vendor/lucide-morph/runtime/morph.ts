import { morphPresets, getPresetById } from "../morph/presets"
import type { MorphAsset, MorphLayer, MorphLayerMode } from "../morph/types"
import { clamp, interpolateOpacity, interpolatePath } from "../morph/path"

export type MorphIconState = "from" | "loading" | "to"
export type MorphIconPreset = string | MorphAsset

export type MorphIconFrame = {
  id: string
  d: string
  opacity: number
  mode: MorphLayerMode
}

export type MorphIconSvgOptions = {
  color?: string
  loading?: boolean
  size?: number
  strokeWidth?: number
  title?: string
}

export function hasLoadingMorph(asset: MorphAsset) {
  return Boolean(
    asset.loading &&
      asset.layers.length > 0 &&
      asset.layers.every(
        (layer) => layer.loading && layer.loadingOpacity !== undefined,
      ),
  )
}

export function resolveMorphIconAsset(
  preset?: MorphIconPreset,
  asset?: MorphAsset,
) {
  if (asset) return asset
  if (typeof preset === "string") return getPresetById(preset)
  if (preset) return preset
  return morphPresets[0]
}

export function resolveMorphIconState(
  asset: MorphAsset,
  state: MorphIconState | undefined,
  active = false,
) {
  const requested = state ?? (active ? "to" : "from")
  return requested === "loading" && !hasLoadingMorph(asset) ? "from" : requested
}

export function targetPositionForState(asset: MorphAsset, state: MorphIconState) {
  if (!hasLoadingMorph(asset)) {
    return state === "to" ? 1 : 0
  }

  switch (state) {
    case "loading":
      return 1
    case "to":
      return 2
    case "from":
    default:
      return 0
  }
}

export function progressToPosition(asset: MorphAsset, progress: number) {
  return clamp(progress) * (hasLoadingMorph(asset) ? 2 : 1)
}

function frameForDirectLayer(layer: MorphLayer, progress: number) {
  const directLayer: MorphLayer = {
    ...layer,
    from: layer.from,
    fromOpacity: layer.fromOpacity,
    to: layer.to,
    toOpacity: layer.toOpacity,
  }

  return {
    d: interpolatePath(directLayer, clamp(progress)),
    opacity: interpolateOpacity(directLayer, clamp(progress)),
  }
}

function frameForLoadingLayer(layer: MorphLayer, position: number) {
  if (!layer.loading || layer.loadingOpacity === undefined) {
    return frameForDirectLayer(layer, position / 2)
  }

  const entering = position <= 1
  const progress = entering ? clamp(position) : clamp(position - 1)
  const activeLayer: MorphLayer = entering
    ? {
        ...layer,
        from: layer.from,
        fromOpacity: layer.fromOpacity,
        to: layer.loading,
        toOpacity: layer.loadingOpacity,
      }
    : {
        ...layer,
        from: layer.loading,
        fromOpacity: layer.loadingOpacity,
        to: layer.to,
        toOpacity: layer.toOpacity,
      }

  return {
    d: interpolatePath(activeLayer, progress),
    opacity: interpolateOpacity(activeLayer, progress),
  }
}

export function getMorphIconFrames(asset: MorphAsset, position: number) {
  const loadingMorph = hasLoadingMorph(asset)

  return asset.layers.map((layer): MorphIconFrame => {
    const frame = loadingMorph
      ? frameForLoadingLayer(layer, clamp(position, 0, 2))
      : frameForDirectLayer(layer, clamp(position))

    return {
      id: layer.id,
      mode: layer.mode,
      ...frame,
    }
  })
}

export function getViewBoxCenter(viewBox: string) {
  const values = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number)

  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return { x: 12, y: 12 }
  }

  const [x, y, width, height] = values
  return {
    x: x + width / 2,
    y: y + height / 2,
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatNumber(value: number) {
  const rounded = Number(value.toFixed(3))
  return Object.is(rounded, -0) ? "0" : rounded.toString()
}

export function renderMorphIconSvg(
  asset: MorphAsset,
  position: number,
  {
    color = "currentColor",
    loading = false,
    size = 24,
    strokeWidth = 2,
    title,
  }: MorphIconSvgOptions = {},
) {
  const frames = getMorphIconFrames(asset, position)
  const center = asset.loading?.rotationCenter ?? getViewBoxCenter(asset.viewBox)
  const loadingMorph = loading && hasLoadingMorph(asset) && asset.loading
  const titleMarkup = title ? `<title>${escapeHtml(title)}</title>` : ""
  const animationMarkup = loadingMorph
    ? `<animateTransform attributeName="transform" type="rotate" from="0 ${formatNumber(center.x)} ${formatNumber(center.y)}" to="${
        asset.loading?.rotationDirection === "counterclockwise" ? "-360" : "360"
      } ${formatNumber(center.x)} ${formatNumber(center.y)}" dur="${
        asset.loading?.rotationDuration ?? 900
      }ms" repeatCount="indefinite" />`
    : ""

  const paths = frames
    .map((frame) => {
      if (frame.mode === "fill" && !asset.strokeLocked) {
        return `<path d="${escapeHtml(frame.d)}" opacity="${formatNumber(
          frame.opacity,
        )}" fill="currentColor" />`
      }

      return `<path d="${escapeHtml(frame.d)}" opacity="${formatNumber(
        frame.opacity,
      )}" fill="none" stroke="currentColor" stroke-width="${formatNumber(
        strokeWidth,
      )}" stroke-linecap="round" stroke-linejoin="round" />`
    })
    .join("")

  return `<svg aria-hidden="${
    title ? "false" : "true"
  }" viewBox="${escapeHtml(asset.viewBox)}" width="${formatNumber(
    size,
  )}" height="${formatNumber(
    size,
  )}" style="color:${escapeHtml(
    color,
  )};display:block;overflow:visible">${titleMarkup}<g>${animationMarkup}${paths}</g></svg>`
}

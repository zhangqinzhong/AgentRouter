import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react"
import { getPresetById } from "./morph/presets"
import type { MorphAsset } from "./morph/types"
import {
  getMorphIconFrames,
  getViewBoxCenter,
  hasLoadingMorph,
  progressToPosition,
  resolveMorphIconAsset,
  resolveMorphIconState,
  targetPositionForState,
  type MorphIconPreset,
  type MorphIconState,
} from "./runtime/morph"

export {
  cloneAsset,
  getPresetById,
  morphPresets,
} from "./morph/presets"
export type {
  MorphAsset,
  MorphLayer,
  MorphLayerMode,
  MorphLoadingDesign,
} from "./morph/types"
export type {
  MorphIconPreset,
  MorphIconState,
} from "./runtime/morph"

export type MorphIconProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children" | "color"
> & {
  active?: boolean
  asset?: MorphAsset
  color?: string
  duration?: number
  preset?: MorphIconPreset
  progress?: number
  size?: number
  state?: MorphIconState
  strokeWidth?: number
  title?: string
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3)
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}

function canAnimate() {
  return (
    typeof requestAnimationFrame !== "undefined" &&
    typeof cancelAnimationFrame !== "undefined"
  )
}

export function MorphIcon({
  active = false,
  asset,
  color = "currentColor",
  duration = 420,
  preset,
  progress,
  size = 24,
  state,
  strokeWidth = 2,
  style,
  title,
  ...spanProps
}: MorphIconProps) {
  const resolvedAsset = useMemo(
    () => resolveMorphIconAsset(preset, asset),
    [asset, preset],
  )
  const resolvedState = resolveMorphIconState(resolvedAsset, state, active)
  const targetPosition =
    progress === undefined
      ? targetPositionForState(resolvedAsset, resolvedState)
      : progressToPosition(resolvedAsset, progress)
  const [position, setPosition] = useState(targetPosition)
  const loading = resolvedState === "loading" && hasLoadingMorph(resolvedAsset)
  const frames = getMorphIconFrames(resolvedAsset, position)
  const center =
    resolvedAsset.loading?.rotationCenter ??
    getViewBoxCenter(resolvedAsset.viewBox)

  useEffect(() => {
    if (progress !== undefined || !canAnimate()) {
      setPosition(targetPosition)
      return
    }

    const from = position
    const to = targetPosition
    const start = now()
    const safeDuration = Math.max(1, duration)
    let frame = 0

    const tick = (time: number) => {
      const elapsed = Math.min(1, (time - start) / safeDuration)
      setPosition(from + (to - from) * easeOutCubic(elapsed))

      if (elapsed < 1) {
        frame = requestAnimationFrame(tick)
      }
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [duration, progress, resolvedAsset.id, targetPosition])

  return (
    <span
      {...spanProps}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      aria-busy={loading || undefined}
      style={
        {
          color,
          display: "inline-grid",
          height: size,
          lineHeight: 0,
          placeItems: "center",
          width: size,
          ...style,
        } as CSSProperties
      }
    >
      <svg
        aria-hidden="true"
        viewBox={resolvedAsset.viewBox}
        width={size}
        height={size}
        style={{
          display: "block",
          gridArea: "1 / 1",
          overflow: "visible",
        }}
      >
        <g>
          {loading && resolvedAsset.loading && (
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`0 ${center.x} ${center.y}`}
              to={`${
                resolvedAsset.loading.rotationDirection === "counterclockwise"
                  ? -360
                  : 360
              } ${center.x} ${center.y}`}
              dur={`${resolvedAsset.loading.rotationDuration}ms`}
              repeatCount="indefinite"
            />
          )}
          {frames.map((frame) =>
            frame.mode === "fill" && !resolvedAsset.strokeLocked ? (
              <path
                key={frame.id}
                d={frame.d}
                opacity={frame.opacity}
                fill="currentColor"
              />
            ) : (
              <path
                key={frame.id}
                d={frame.d}
                opacity={frame.opacity}
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={strokeWidth}
              />
            ),
          )}
        </g>
      </svg>
    </span>
  )
}

export function getMorphIconPreset(id: string) {
  return getPresetById(id)
}

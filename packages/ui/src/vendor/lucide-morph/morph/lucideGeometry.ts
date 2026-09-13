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

const pathTokenRE = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi
const commandRE = /^[a-zA-Z]$/

function formatNumber(value: number) {
  const rounded = Number(value.toFixed(6))
  return Object.is(rounded, -0) ? "0" : rounded.toString()
}

function samePoint(a: Point, b: Point) {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

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

function vectorAngle(ux: number, uy: number, vx: number, vy: number) {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
}

function arcAsCubics(
  from: Point,
  rxValue: number,
  ryValue: number,
  rotation: number,
  largeArc: number,
  sweep: number,
  to: Point,
) {
  if (samePoint(from, to)) return []

  let rx = Math.abs(rxValue)
  let ry = Math.abs(ryValue)
  if (rx === 0 || ry === 0) return [lineAsCubic(from, to)]

  const phi = (rotation * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const xPrime = cosPhi * dx + sinPhi * dy
  const yPrime = -sinPhi * dx + cosPhi * dy
  const radiusScale =
    (xPrime * xPrime) / (rx * rx) + (yPrime * yPrime) / (ry * ry)

  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale)
    rx *= scale
    ry *= scale
  }

  const numerator =
    rx * rx * ry * ry -
    rx * rx * yPrime * yPrime -
    ry * ry * xPrime * xPrime
  const denominator =
    rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime
  const sign = Boolean(largeArc) === Boolean(sweep) ? -1 : 1
  const centerScale =
    denominator === 0
      ? 0
      : sign * Math.sqrt(Math.max(0, numerator / denominator))
  const centerPrimeX = (centerScale * rx * yPrime) / ry
  const centerPrimeY = (-centerScale * ry * xPrime) / rx
  const center = {
    x:
      cosPhi * centerPrimeX -
      sinPhi * centerPrimeY +
      (from.x + to.x) / 2,
    y:
      sinPhi * centerPrimeX +
      cosPhi * centerPrimeY +
      (from.y + to.y) / 2,
  }
  const startVector = {
    x: (xPrime - centerPrimeX) / rx,
    y: (yPrime - centerPrimeY) / ry,
  }
  const endVector = {
    x: (-xPrime - centerPrimeX) / rx,
    y: (-yPrime - centerPrimeY) / ry,
  }
  const startAngle = vectorAngle(1, 0, startVector.x, startVector.y)
  let sweepAngle = vectorAngle(
    startVector.x,
    startVector.y,
    endVector.x,
    endVector.y,
  )

  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2

  const segmentCount = Math.max(
    1,
    Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)),
  )
  const angleStep = sweepAngle / segmentCount
  const pointAt = (angle: number): Point => ({
    x:
      center.x +
      rx * cosPhi * Math.cos(angle) -
      ry * sinPhi * Math.sin(angle),
    y:
      center.y +
      rx * sinPhi * Math.cos(angle) +
      ry * cosPhi * Math.sin(angle),
  })
  const derivativeAt = (angle: number): Point => ({
    x: -rx * cosPhi * Math.sin(angle) - ry * sinPhi * Math.cos(angle),
    y: -rx * sinPhi * Math.sin(angle) + ry * cosPhi * Math.cos(angle),
  })

  return Array.from({ length: segmentCount }, (_, index) => {
    const segmentStart = startAngle + angleStep * index
    const segmentEnd = segmentStart + angleStep
    const p0 = index === 0 ? from : pointAt(segmentStart)
    const p3 = index === segmentCount - 1 ? to : pointAt(segmentEnd)
    const startDerivative = derivativeAt(segmentStart)
    const endDerivative = derivativeAt(segmentEnd)
    const handle = (4 / 3) * Math.tan(angleStep / 4)

    return {
      p0,
      p1: {
        x: p0.x + handle * startDerivative.x,
        y: p0.y + handle * startDerivative.y,
      },
      p2: {
        x: p3.x - handle * endDerivative.x,
        y: p3.y - handle * endDerivative.y,
      },
      p3,
    }
  })
}

function serializePath(subpaths: CubicSubpath[]) {
  return subpaths
    .map((subpath) => {
      const segments = subpath.segments
        .map(
          (segment) =>
            `C${formatNumber(segment.p1.x)} ${formatNumber(
              segment.p1.y,
            )} ${formatNumber(segment.p2.x)} ${formatNumber(
              segment.p2.y,
            )} ${formatNumber(segment.p3.x)} ${formatNumber(segment.p3.y)}`,
        )
        .join(" ")

      return `M${formatNumber(subpath.start.x)} ${formatNumber(
        subpath.start.y,
      )} ${segments}`
    })
    .join(" ")
}

export function lucidePath(path: string) {
  const tokens = path.match(pathTokenRE) ?? []
  const subpaths: CubicSubpath[] = []
  let index = 0
  let command = ""
  let current: Point = { x: 0, y: 0 }
  let activeSubpath: CubicSubpath | undefined

  const hasNumber = () =>
    index < tokens.length && !commandRE.test(tokens[index] ?? "")
  const readNumber = () => {
    const token = tokens[index]
    if (token === undefined || commandRE.test(token)) {
      throw new Error(`Invalid Lucide path near ${token ?? "the end"}.`)
    }
    index += 1
    return Number(token)
  }
  const readPoint = (relative: boolean): Point => {
    const point = { x: readNumber(), y: readNumber() }
    return relative
      ? { x: current.x + point.x, y: current.y + point.y }
      : point
  }
  const appendSegment = (segment: CubicSegment) => {
    if (!activeSubpath) throw new Error("Lucide path must begin with M.")
    activeSubpath.segments.push(segment)
    current = segment.p3
  }

  while (index < tokens.length) {
    if (commandRE.test(tokens[index] ?? "")) {
      command = tokens[index]
      index += 1
    } else if (!command) {
      throw new Error("Lucide path is missing a command.")
    }

    const upper = command.toUpperCase()
    const relative = command !== upper

    if (upper === "M") {
      current = readPoint(relative)
      activeSubpath = { start: current, segments: [] }
      subpaths.push(activeSubpath)
      while (hasNumber()) {
        const end = readPoint(relative)
        appendSegment(lineAsCubic(current, end))
      }
      command = relative ? "l" : "L"
      continue
    }

    if (!activeSubpath) throw new Error("Lucide path must begin with M.")

    if (upper === "L") {
      while (hasNumber()) {
        const end = readPoint(relative)
        appendSegment(lineAsCubic(current, end))
      }
      continue
    }

    if (upper === "H") {
      while (hasNumber()) {
        const x = readNumber()
        const end = { x: relative ? current.x + x : x, y: current.y }
        appendSegment(lineAsCubic(current, end))
      }
      continue
    }

    if (upper === "V") {
      while (hasNumber()) {
        const y = readNumber()
        const end = { x: current.x, y: relative ? current.y + y : y }
        appendSegment(lineAsCubic(current, end))
      }
      continue
    }

    if (upper === "C") {
      while (hasNumber()) {
        const p1 = readPoint(relative)
        const p2 = readPoint(relative)
        const p3 = readPoint(relative)
        appendSegment({ p0: current, p1, p2, p3 })
      }
      continue
    }

    if (upper === "A") {
      while (hasNumber()) {
        const rx = readNumber()
        const ry = readNumber()
        const rotation = readNumber()
        const largeArc = readNumber()
        const sweep = readNumber()
        const end = readPoint(relative)
        const segments = arcAsCubics(
          current,
          rx,
          ry,
          rotation,
          largeArc,
          sweep,
          end,
        )
        segments.forEach(appendSegment)
      }
      continue
    }

    if (upper === "Z") {
      if (!samePoint(current, activeSubpath.start)) {
        appendSegment(lineAsCubic(current, activeSubpath.start))
      }
      current = activeSubpath.start
      command = ""
      continue
    }

    throw new Error(`Unsupported Lucide path command: ${command}`)
  }

  if (
    subpaths.length === 0 ||
    subpaths.some((subpath) => subpath.segments.length === 0)
  ) {
    throw new Error("Lucide paths must contain drawable segments.")
  }

  return serializePath(subpaths)
}

export function lucideLine(x1: number, y1: number, x2: number, y2: number) {
  return lucidePath(`M${x1} ${y1} L${x2} ${y2}`)
}

export function lucideCircle(cx: number, cy: number, radius: number) {
  return lucidePath(
    `M${cx + radius} ${cy} A${radius} ${radius} 0 1 1 ${
      cx - radius
    } ${cy} A${radius} ${radius} 0 1 1 ${cx + radius} ${cy}`,
  )
}

export function lucideRoundedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  ry = rx,
) {
  if (rx === 0 && ry === 0) {
    return lucidePath(
      `M${x} ${y} H${x + width} V${y + height} H${x} Z`,
    )
  }

  return lucidePath(
    `M${x + rx} ${y} H${x + width - rx} A${rx} ${ry} 0 0 1 ${
      x + width
    } ${y + ry} V${y + height - ry} A${rx} ${ry} 0 0 1 ${
      x + width - rx
    } ${y + height} H${x + rx} A${rx} ${ry} 0 0 1 ${x} ${
      y + height - ry
    } V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`,
  )
}

export function lucidePolygon(points: string) {
  const values = points.trim().split(/[\s,]+/).map(Number)
  if (values.length < 4 || values.length % 2 !== 0) {
    throw new Error("Lucide polygons require coordinate pairs.")
  }

  const commands = [`M${values[0]} ${values[1]}`]
  for (let index = 2; index < values.length; index += 2) {
    commands.push(`L${values[index]} ${values[index + 1]}`)
  }
  commands.push("Z")
  return lucidePath(commands.join(" "))
}

export function joinLucidePaths(...paths: string[]) {
  return paths.join(" ")
}

export function collapsedLucidePath(x = 12, y = 12) {
  return lucideLine(x, y, x, y)
}

// Brushing from a pre-aggregated index, as Mosaic does: one query per chart
// when a brush starts, then each move is a few subtractions.
import { binCount, cellWidth, CELLS, type Dimension, type Range } from "./Flights.ts"
import type { Bin } from "./queries.ts"

const cellOf = (active: Dimension, value: number): number =>
  Math.min(CELLS - 1, Math.max(0, Math.floor((value - active.domain[0]) / cellWidth(active))))

// `cumulative[c * width + b]` counts the flights in cells before `c`, per
// bin `b`, so any run of cells is one subtraction per bin.
export const accumulate = (
  cells: ReadonlyArray<number>,
  bins: ReadonlyArray<number> | undefined,
  counts: ReadonlyArray<number>,
  width: number
): Array<number> => {
  const out = new Array<number>((CELLS + 1) * width).fill(0)
  for (let k = 0; k < cells.length; k++) {
    const at = (cells[k]! + 1) * width + (bins?.[k] ?? 0)
    out[at] = out[at]! + counts[k]!
  }
  for (let c = 1; c <= CELLS; c++) {
    for (let b = 0; b < width; b++) out[c * width + b] = out[c * width + b]! + out[(c - 1) * width + b]!
  }
  return out
}

export const binsIn = (
  cumulative: ReadonlyArray<number>,
  active: Dimension,
  target: Dimension,
  [lo, hi]: Range
): ReadonlyArray<Bin> => {
  const width = binCount(target)
  const from = cellOf(active, lo) * width
  const to = (cellOf(active, hi) + 1) * width
  return Array.from({ length: width }, (_, b) => {
    const bin0 = target.domain[0] + b * target.step
    return { bin0, bin1: bin0 + target.step, count: cumulative[to + b]! - cumulative[from + b]! }
  })
}

export const countIn = (cumulative: ReadonlyArray<number>, active: Dimension, [lo, hi]: Range): number =>
  cumulative[cellOf(active, hi) + 1]! - cumulative[cellOf(active, lo)]!

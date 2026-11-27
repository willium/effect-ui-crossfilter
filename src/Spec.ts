// Vega-Lite specs as values, built by small typed functions, in the spirit
// of elm-vega: the app decides what to draw, and the Vega runtime draws it.
import type { TopLevelSpec } from "vega-lite"
import type { MarkDef } from "vega-lite/types_unstable/mark.js"
import type { SelectionParameter } from "vega-lite/types_unstable/selection.js"
import type { UnitSpec } from "vega-lite/types_unstable/spec/unit.js"
import type { Dimension } from "./Flights.ts"

// Names the mount uses to reach into a running view.
export const BRUSH = "brush"
export const TOTALS = "totals"
export const FILTERED = "filtered"

export const colors = {
  background: "#d9d6d0",
  foreground: "#3b6ea5"
}

const bar = (color: string): MarkDef<"bar"> => ({
  type: "bar",
  color,
  binSpacing: 1,
  cornerRadiusTopLeft: 1,
  cornerRadiusTopRight: 1
})

const intervalX = (name: string): SelectionParameter<"interval"> => ({
  name,
  select: { type: "interval", encodings: ["x"] }
})

// One layer of pre-binned counts from a named dataset. DuckDB bins, so the
// chart only draws `bin0`..`bin1` against `count`.
const bins = (dataset: string, mark: MarkDef<"bar">): UnitSpec<string> => ({
  data: { name: dataset },
  mark
})

// A crossfilter histogram: every flight in the background, the flights that
// pass the other charts' brushes in front, and an interval brush on x.
export const histogram = ({ domain, label }: Dimension): TopLevelSpec => ({
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  width: "container",
  height: 150,
  autosize: { type: "fit-x", contains: "padding" },
  config: {
    view: { stroke: null },
    axis: { labelColor: "#57534e", titleColor: "#292524", gridColor: "#eeece8", domainColor: "#a8a29e" }
  },
  encoding: {
    x: {
      field: "bin0",
      type: "quantitative",
      title: label,
      scale: { domain: [domain[0], domain[1]], nice: false, zero: false }
    },
    x2: { field: "bin1" },
    y: { field: "count", type: "quantitative", title: "Flights", axis: { format: "~s", tickCount: 4 } },
    y2: { datum: 0 }
  },
  layer: [
    { ...bins(TOTALS, bar(colors.background)), params: [intervalX(BRUSH)] },
    bins(FILTERED, bar(colors.foreground))
  ]
})

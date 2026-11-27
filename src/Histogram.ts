import { Mount, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Queue, Schema, Stream } from "effect"
import { AsyncResult } from "effect/reactivity"
import { parse, View } from "vega"
import { compile } from "vega-lite"
import { binsIn } from "./Cube.ts"
import { Dimension, Filter, Range } from "./Flights.ts"
import { Bin, BinCounts, CubeCounts } from "./queries.ts"
import { BRUSH, FILTERED, histogram, TOTALS } from "./Spec.ts"

// A brush value from Vega-Lite is `{ bin0: [a, b] }` while brushing and `{}`
// once cleared. Dragging leftwards gives `a > b`.
const toRange = (value: unknown): Range | null => {
  const extent = (value as { readonly bin0?: ReadonlyArray<number> } | null)?.bin0
  if (extent === undefined || extent.length !== 2) return null
  const [a, b] = extent as unknown as Range
  return a <= b ? [a, b] : [b, a]
}

// Vega tags the tuples it ingests, so it gets its own copies.
const tuples = (bins: ReadonlyArray<Bin>) => bins.map((bin) => ({ ...bin }))

// Hosts one Vega view for the element's lifetime. The view is built once from
// the spec; new query results arrive through `changes` and are swapped into
// the running view, so a brush in progress survives every update. The brush
// is reported as a stream of ranges.
export const DrawHistogram = Mount.makeStream(
  "DrawHistogram",
  {
    args: {
      dimension: Dimension,
      totals: Schema.Array(Bin),
      filtered: Schema.Array(Bin)
    }
  },
  (node: HTMLElement, { dimension }, changes) =>
    Stream.callback<Range | null>((queue) =>
      Effect.gen(function*() {
        const view = yield* Effect.acquireRelease(
          Effect.promise(() =>
            new View(parse(compile(histogram(dimension)).spec), {
              container: node,
              renderer: "canvas",
              hover: true
            }).runAsync()
          ),
          (view) => Effect.sync(() => view.finalize())
        )
        const onBrush = (_: string, value: unknown) => Queue.offerUnsafe(queue, toRange(value))
        yield* Effect.acquireRelease(
          Effect.sync(() => view.addSignalListener(BRUSH, onBrush)),
          () => Effect.sync(() => view.removeSignalListener(BRUSH, onBrush))
        )
        let shown: { totals?: ReadonlyArray<Bin>; filtered?: ReadonlyArray<Bin> } = {}
        yield* changes.pipe(
          Stream.runForEach(({ totals, filtered }) =>
            Effect.promise(() => {
              if (totals !== shown.totals) view.data(TOTALS, tuples(totals))
              if (filtered !== shown.filtered) view.data(FILTERED, tuples(filtered))
              shown = { totals, filtered }
              return view.runAsync()
            })
          ),
          Effect.forkScoped
        )
      })
    )
)

// While another chart is brushed: that chart, its brush, and the brushes
// that hold still meanwhile.
export const Slice = Schema.Struct({
  active: Dimension,
  range: Range,
  fixed: Schema.Array(Filter)
})
export type Slice = typeof Slice.Type

export const HistogramProps = Schema.Struct({
  dimension: Dimension,
  where: Schema.Array(Filter),
  slice: Schema.NullOr(Slice)
})

export const HistogramMessage = UiSchema.TaggedEnum({
  MovedBrush: { range: Schema.NullOr(Range) }
})

export const HistogramEvents = UiSchema.TaggedEnum({
  Brushed: { range: Schema.NullOr(Range) }
})

const binsOf = (result: AsyncResult.AsyncResult<{ readonly bins: ReadonlyArray<Bin> }, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value.bins : []

export const Histogram = Html.component({
  name: "Histogram",
  props: HistogramProps,
  model: Schema.Null,
  message: HistogramMessage,
  events: HistogramEvents,
  queries: {
    totals: {
      query: BinCounts,
      args: ({ props }) => ({ dimension: props.dimension, where: [] })
    },
    // While another chart is brushed, an index of this chart's bins by cell
    // of that chart answers every move of its brush without a query.
    index: {
      query: CubeCounts,
      dropPrevious: true,
      args: ({ props }) =>
        props.slice === null
          ? undefined
          : { active: props.slice.active, target: props.dimension, where: props.slice.fixed }
    },
    // Until the index is in, and when no other chart is brushed, DuckDB
    // filters directly. A zero debounce makes the latest brush win: when the
    // filters change again, the fetch for the old ones is interrupted.
    filtered: {
      query: BinCounts,
      debounce: "0 millis",
      args: ({ props, queries }) =>
        props.slice !== null && AsyncResult.isSuccess(queries.index)
          ? undefined
          : { dimension: props.dimension, where: props.where }
    }
  }
}).make({
  init: () => null,
  update: ($, { range }) => $.emit(HistogramEvents.Brushed({ range })),
  view: (h) => {
    const { filtered, index, totals } = h.queries
    const { dimension, slice } = h.props
    const indexed = slice !== null && AsyncResult.isSuccess(index)
    const busy = !indexed && (filtered.waiting || AsyncResult.isInitial(filtered))
    return h.figure.class("chart").children(
      h.div.class("chart-view").onMount(
        DrawHistogram({
          dimension,
          totals: binsOf(totals),
          filtered: indexed ? binsIn(index.value.cumulative, slice.active, dimension, slice.range) : binsOf(filtered)
        }).pipe(Mount.map((range) => HistogramMessage.MovedBrush({ range })))
      ),
      h.figcaption.class(busy ? "timing busy" : "timing").children(
        indexed
          ? `indexed in ${index.value.ms.toFixed(0)} ms`
          : AsyncResult.isSuccess(filtered)
          ? `${filtered.value.ms.toFixed(0)} ms`
          : "…"
      )
    )
  }
})

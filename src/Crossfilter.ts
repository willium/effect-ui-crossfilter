import { UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { countIn } from "./Cube.ts"
import { brushesExcept, dimensionOf, dimensions, Field, Filter, Range, ROWS, setBrush } from "./Flights.ts"
import { Histogram, type Slice } from "./Histogram.ts"
import { CountRows, CubeCounts } from "./queries.ts"

// The Model holds what the user did: one brush per chart, and which chart was
// brushed last. Every count and bin comes from a query, never from a copy in
// the Model.
export const CrossfilterModel = Schema.Struct({
  brushes: Schema.Array(Filter),
  active: Schema.NullOr(Field),
  generation: Schema.Number
})
export type CrossfilterModel = typeof CrossfilterModel.Type

export const CrossfilterMessage = UiSchema.TaggedEnum({
  BrushedHistogram: { field: Field, range: Schema.NullOr(Range) },
  ClickedReset: {}
})

const format = new Intl.NumberFormat("en-US")

// The brush being dragged: the last one brushed, while it holds a range.
const activeBrush = ({ active, brushes }: CrossfilterModel): Filter | undefined =>
  brushes.find((brush) => brush.field === active)

// What another chart's index needs while `field`'s chart is not the one brushed.
const sliceFor = (model: CrossfilterModel, field: Field): Slice | null => {
  const brush = activeBrush(model)
  return brush === undefined || brush.field === field
    ? null
    : {
      active: dimensionOf(brush.field),
      range: brush.range,
      fixed: brushesExcept(brushesExcept(model.brushes, field), brush.field)
    }
}

export const Crossfilter = Html.component({
  name: "Crossfilter",
  model: CrossfilterModel,
  message: CrossfilterMessage,
  queries: {
    // The total under the still brushes, per cell of the brushed chart.
    index: {
      query: CubeCounts,
      dropPrevious: true,
      args: ({ model }) => {
        const brush = activeBrush(model)
        return brush === undefined ? undefined : {
          active: dimensionOf(brush.field),
          target: null,
          where: brushesExcept(model.brushes, brush.field)
        }
      }
    },
    selected: {
      query: CountRows,
      debounce: "0 millis",
      args: ({ model, queries }) =>
        activeBrush(model) !== undefined && AsyncResult.isSuccess(queries.index)
          ? undefined
          : { where: model.brushes }
    }
  }
}).make({
  init: () => ({ brushes: [], active: null, generation: 0 }),
  update: {
    BrushedHistogram: ($, { field, range }) =>
      $.evolve({
        brushes: (brushes) => setBrush(brushes, field, range),
        active: (active) => range !== null ? field : active === field ? null : active
      }),
    // A Vega brush lives in its view, so clearing every brush remounts the
    // charts under new keys. Their results are cached, so nothing refetches.
    ClickedReset: ($) => $.evolve({ brushes: [], active: null, generation: (n) => n + 1 })
  },
  view: (h, model) => {
    const { index, selected } = h.queries
    const brush = activeBrush(model)
    const count = brush !== undefined && AsyncResult.isSuccess(index)
      ? countIn(index.value.cumulative, dimensionOf(brush.field), brush.range)
      : AsyncResult.isSuccess(selected)
      ? selected.value
      : undefined
    const busy = !(brush !== undefined && AsyncResult.isSuccess(index)) && selected.waiting
    return h.main.class("app").children(
      h.header.children(
        h.h1.children("Flights crossfilter"),
        h.p.class("lede").children(
          `${format.format(ROWS)} synthetic flights in DuckDB-WASM. Drag across a chart to filter `
            + "the others, and double-click it to clear its brush."
        ),
        h.div.class("toolbar").children(
          h.p.class(busy ? "count busy" : "count").children(
            count === undefined
              ? "Counting…"
              : `${format.format(count)} of ${format.format(ROWS)} flights selected`
          ),
          h.button.class("reset").disabled(model.brushes.length === 0)
            .on("click", CrossfilterMessage.ClickedReset())
            .children("Clear brushes")
        )
      ),
      h.section.class("charts").children(
        ...dimensions.map((dimension) =>
          Histogram(h, {
            key: `${dimension.field}-${model.generation}`,
            props: {
              dimension,
              where: brushesExcept(model.brushes, dimension.field),
              slice: sliceFor(model, dimension.field)
            },
            onEmit: {
              Brushed: ({ range }) =>
                CrossfilterMessage.BrushedHistogram({ field: dimension.field, range })
            }
          })
        )
      ),
      h.footer.children(
        "Built with Effect UI, Vega-Lite and DuckDB-WASM, after Mosaic's flights crossfilter."
      )
    )
  }
})

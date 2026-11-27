import { Story } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Crossfilter, CrossfilterMessage } from "./Crossfilter.ts"
import { brushesExcept, dimensions } from "./Flights.ts"
import { Histogram, HistogramEvents, HistogramMessage } from "./Histogram.ts"

describe("Crossfilter", () => {
  it.effect("a brush filters the other charts, and clearing it lifts the filter", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Crossfilter, {})
      // A story writes each result itself. Every brush gives the count new
      // args, and the index for the brushed chart stays pending here.
      story.given({ brushes: [], active: null, generation: 0 })
        .loaded("selected", 1_000_000)
        .send(CrossfilterMessage.BrushedHistogram({ field: "time", range: [15, 22] }))
        .keepPending("index")
        .loaded("selected", 383_000)
        .send(CrossfilterMessage.BrushedHistogram({ field: "delay", range: [30, 90] }))
        .keepPending("index")
        .loaded("selected", 61_000)
      // Kept in chart order, so equal selections make equal query args.
      assert.deepStrictEqual(story.model.brushes, [
        { field: "delay", range: [30, 90] },
        { field: "time", range: [15, 22] }
      ])
      assert.strictEqual(story.model.active, "delay")
      // Each chart is filtered by every brush but its own.
      assert.deepStrictEqual(brushesExcept(story.model.brushes, "time"), [
        { field: "delay", range: [30, 90] }
      ])
      // Clearing the brush being dragged leaves no chart active.
      story.send(CrossfilterMessage.BrushedHistogram({ field: "delay", range: null }))
        .loaded("selected", 383_000)
      assert.deepStrictEqual(story.model.brushes, [{ field: "time", range: [15, 22] }])
      assert.strictEqual(story.model.active, null)
    }))

  it.effect("clearing every brush remounts the charts under new keys", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Crossfilter, {})
      story.given({ brushes: [{ field: "distance", range: [500, 1500] }], active: null, generation: 3 })
        .loaded("selected", 655_000)
        .send(CrossfilterMessage.ClickedReset())
        .loaded("selected", 1_000_000)
      assert.deepStrictEqual(story.model, { brushes: [], active: null, generation: 4 })
    }))
})

describe("Histogram", () => {
  it.effect("reports each brush movement to its parent", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Histogram, { dimension: dimensions[2]!, where: [], slice: null })
      story.given(null)
        .keepPending("totals")
        .keepPending("filtered")
        .send(HistogramMessage.MovedBrush({ range: [6, 9] }))
        .emitted(HistogramEvents.Brushed({ range: [6, 9] }))
        .send(HistogramMessage.MovedBrush({ range: null }))
        .emitted(HistogramEvents.Brushed({ range: null }))
    }))
})

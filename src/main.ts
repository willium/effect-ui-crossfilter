import { BrowserHost } from "@effect/ui/html"
import { Cause, Effect, Layer } from "effect"
import { Crossfilter } from "./Crossfilter.ts"
import { DuckDB } from "./DuckDB.ts"
import { BinCounts, CountRows, CubeCounts } from "./queries.ts"

const root = document.getElementById("root")!

const Queries = Layer.mergeAll(BinCounts.layer, CountRows.layer, CubeCounts.layer).pipe(
  Layer.provide(DuckDB.layer)
)

const Main = BrowserHost.mount(Crossfilter, {}, root).pipe(Layer.provide(Queries))

Layer.launch(Main).pipe(
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      root.textContent = `Failed to start: ${Cause.pretty(cause)}`
    })
  ),
  Effect.runFork
)

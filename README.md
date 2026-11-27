# Flights crossfilter: Effect UI + DuckDB-WASM + Vega-Lite

**[Try the live demo](https://willium.github.io/effect-ui-crossfilter/)**. It
downloads DuckDB-WASM, about 8 MB compressed, before the charts appear.

A [Mosaic](https://idl.uw.edu/mosaic/)-style linked-views dashboard built with
[Effect UI](https://ui.effect.website/). One million synthetic flights live in
DuckDB-WASM. Drag across any histogram to filter the other two; every
aggregate is a SQL query that DuckDB answers in the browser.

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # Story tests, and the index math against brute force
npm run check   # tsc
```

## How it maps onto Mosaic

| Mosaic | Here |
| --- | --- |
| Selection (crossfilter) | `Crossfilter`'s Model: one `{ field, range }` per brushed chart. Each chart gets every brush but its own (`brushesExcept`). |
| Client issuing SQL | `Histogram`, a component whose `queries` are `BinCounts` for all flights and for the filtered ones. |
| Coordinator | Effect UI's query cache (dedup, caching, and interrupting superseded fetches) over a `DuckDB` service that runs one query at a time. |
| Data cube indexes | `CubeCounts`: when a brush starts, one index per linked chart. Each move of the brush is then a lookup, not a query. |
| vgplot marks | Vega-Lite specs built by typed functions in `Spec.ts`, after [elm-vega](https://package.elm-lang.org/packages/gicentre/elm-vega/latest/): the app builds the spec as a value, and the Vega runtime draws it. |

## Things worth noticing

- **The Model holds what the user did, never fetched data.** Bins and counts
  are query results. Equal selections give equal query args, so revisiting a
  brush is served from the cache.
- **One Vega view per chart, updated in place.** `DrawHistogram` is a stream
  mount: it builds the view once, takes new query results through the mount's
  `changes` stream and swaps them in with `view.data(...)`, and reports the
  brush as a stream of ranges. Re-embedding the spec on each update, the
  naive elm-vega-with-ports approach, would reset the brush mid-drag.
- **The brush lives in Vega.** The parent never pushes it back into the
  view, which avoids a feedback loop. "Clear brushes" remounts the charts
  under new keys instead, and their queries come back from the cache.
- **Latest brush wins.** While you drag, the filters change on every pointer
  move. When a query's args change, Effect UI interrupts the fetch for the
  old args ([Effect-TS/ui#481](https://github.com/Effect-TS/ui/pull/481)).
  The `DuckDB` service queues queries behind a one-permit semaphore, so an
  interrupted query that is still waiting never reaches DuckDB. An
  interrupted query that is already running asks DuckDB to cancel
  (`cancelSent`), which is best effort.

  Measured in headless Chrome on a 46-step drag across the time chart, with
  the index off so every move queries DuckDB:

  | Effect UI | Queries run to completion | Dropped before running | Interrupted while running |
  | --- | --- | --- | --- |
  | before #481 | 138 (all) | 0 | 0 |
  | with #481 | 96 | 8 | 34 |

  DuckDB-WASM's `cancelSent` rarely stops a running query at this size,
  because it's already finishing. Queueing in Effect is what saves the work.

- **Brushing reads from an index, as Mosaic's data cubes do.** When a chart
  is brushed, each other chart queries `CubeCounts` once. That index counts
  flights by cell of the brushed axis (1,024 cells, about pixel resolution)
  and by the chart's own bins, under the brushes that hold still, and is
  stored as running totals. Every later move of the brush is a subtraction
  per bin in `Cube.ts`, with no query. Until the index arrives, the chart
  queries DuckDB directly. The count works the same way, with one total per
  cell. Brushes snap to cell edges, which is finer than a pixel at this
  width.

  Redraws per second of the linked charts, on a 60 Hz drag in headless
  Chrome:

  | | Delay | Distance | Slowest frame gap (p95) |
  | --- | --- | --- | --- |
  | querying DuckDB per move | 48 | 37 | 31–50 ms, one stall of ~1 s |
  | indexed | 52 | 52 | 18 ms |

## Effect UI features used

- **Components:** `Html.component(...).make({ init, update, view })`, with
  Schema-typed `props`, `model`, `message` and `events`, and
  `UiSchema.TaggedEnum` for messages and events (`Crossfilter`, `Histogram`).
- **Children:** declared with `key`, `props` and `onEmit`. A chart's `Brushed`
  event becomes the root's `BrushedHistogram` message, and re-keying the
  charts resets their brushes.
- **Queries:** `queries` entries backed by `Query.Service` (`BinCounts`,
  `CountRows`, `CubeCounts`). Results are cached by args with
  `staleTime: "Infinity"` and read as `AsyncResult`, including `waiting`. The
  indexes set `dropPrevious: true`. One query's args read another's result:
  `filtered` turns itself off once `index` has arrived, and args of
  `undefined` disable a query. Superseded fetches are interrupted.
- **Mounts:** `Mount.makeStream`, its `changes` stream, and `Mount.map`. Each
  chart's Vega view is built once and updated in place (`DrawHistogram`).
- **Updates:** `$.evolve` and `$.emit`.
- **Host:** `BrowserHost.mount`, launched with `Layer.launch`.
- **Tests:** `Story` from `@effect/ui/testing`, with `given`, `send`,
  `loaded`, `keepPending` and `emitted`.

## Effect features used

- **Services and layers:** `Context.Service` and `Layer.effect` for the
  `DuckDB` service, and `Layer.mergeAll` and `Layer.provide` to give the
  queries their database.
- **Resources:** `Effect.acquireRelease` for the DuckDB worker and
  connection, each Vega view, and its signal listener. Each is released when
  its scope closes.
- **Interruption:** `Effect.tryPromise` with its `AbortSignal`, and
  `Effect.onInterrupt`. An interrupted fetch reaches DuckDB as `cancelSent`.
- **Concurrency:** `Semaphore.withPermit` runs one query at a time, so a
  query interrupted while it waits never runs.
- **Streams:** `Stream.callback` with `Queue.offerUnsafe` turns a Vega signal
  listener into a Stream. `Stream.runForEach` and `Effect.forkScoped` apply
  new args to a running view.
- **Schema:** `Struct`, `Literals`, `Tuple`, `NullOr`, `Array` and
  `TaggedError`, for the domain, props, Models, and query args and results.
- **Also:** `Effect.timed` and `Duration` for the per-chart timings,
  `AsyncResult` from `effect/reactivity`, and `@effect/vitest`.

## Issues and pull requests

Building this example led to these reports and fixes upstream.

**[Effect UI](https://github.com/Effect-TS/ui):**

- [#305](https://github.com/Effect-TS/ui/issues/305): history restore saved
  every watched query result into `history.state`. Fixed by
  [#361](https://github.com/Effect-TS/ui/pull/361), which adds
  `restore: false` on a `queries` entry.
- [#461](https://github.com/Effect-TS/ui/issues/461): a query entry
  interrupted a superseded fetch only when it had a `debounce`. Fixed by
  [#481](https://github.com/Effect-TS/ui/pull/481), which interrupts
  superseded fetches by default. Until then, this example set
  `debounce: "0 millis"` to get the same effect.

**[Foldkit](https://github.com/foldkit/foldkit), Effect UI's predecessor:**

- Closed, because Effect UI already covers them:
  - [#1951](https://github.com/foldkit/foldkit/issues/1951): a running Mount
    receiving updated args. `DrawHistogram` relies on Effect UI's version.
  - [#1953](https://github.com/foldkit/foldkit/issues/1953): long Commands
    holding up paint.
  - [#1954](https://github.com/foldkit/foldkit/issues/1954): Canvas
    repainting unchanged scenes.
- [#1952](https://github.com/foldkit/foldkit/issues/1952): large data outside
  the Model. Ported to Effect UI as #305.
- [#1955](https://github.com/foldkit/foldkit/issues/1955): memoizing derived
  values. Still open.
- [A comment on #1908](https://github.com/foldkit/foldkit/issues/1908#issuecomment-7046770212):
  superseding in-flight fetches, which led to Effect UI #461.

## Files

- `src/Flights.ts`: the dataset's dimensions, brush helpers and SQL.
- `src/DuckDB.ts`: DuckDB-WASM as an Effect service. It generates the
  table, runs queries one at a time, and cancels on interruption.
- `src/queries.ts`: `BinCounts`, `CountRows` and `CubeCounts`, as `Query.Service`s.
- `src/Cube.ts`: building an index's running totals, and answering a brush from them.
- `src/Spec.ts`: typed Vega-Lite builders.
- `src/Histogram.ts`: the chart component and its `DrawHistogram` mount.
- `src/Crossfilter.ts`: the root, which owns the brushes.

## Limits

- The data is synthetic, generated by SQL in the browser (`generateSql`), so
  the example runs offline. Departures peak morning and evening, distances
  are long-tailed, and delays grow through the day.
- An index is built per brushed chart and per combination of the still
  brushes. Building one takes 50–200 ms over 1M rows; Mosaic also keeps its
  indexes in the database, which this example doesn't.
- The DuckDB-WASM build is single-threaded.

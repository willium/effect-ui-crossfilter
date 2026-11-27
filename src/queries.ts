import { Query } from "@effect/ui"
import { Duration, Effect, Schema } from "effect"
import { DuckDB, DuckDBError } from "./DuckDB.ts"
import { accumulate } from "./Cube.ts"
import { binCount, binSql, countSql, cubeSql, Dimension, Filter } from "./Flights.ts"

export const Bin = Schema.Struct({
  bin0: Schema.Number,
  bin1: Schema.Number,
  count: Schema.Number
})
export type Bin = typeof Bin.Type

// Counts per bin of one dimension, under the given filters. DuckDB does the
// aggregation, so a result is a few dozen rows whatever the table size.
export class BinCounts extends Query.Service<BinCounts>()("crossfilter/BinCounts", {
  args: { dimension: Dimension, where: Schema.Array(Filter) },
  success: Schema.Struct({ bins: Schema.Array(Bin), ms: Schema.Number }),
  error: DuckDBError,
  staleTime: "Infinity"
}) {
  static readonly layer = this.toLayer(Effect.gen(function*() {
    const db = yield* DuckDB
    return ({ dimension, where }) =>
      db.query(binSql(dimension, where)).pipe(
        Effect.timed,
        Effect.map(([duration, rows]) => ({
          bins: rows.map((row) => ({
            bin0: Number(row.bin0),
            bin1: Number(row.bin0) + dimension.step,
            count: Number(row.count)
          })),
          ms: Duration.toMillis(duration)
        }))
      )
  }))
}

export class CountRows extends Query.Service<CountRows>()("crossfilter/CountRows", {
  args: { where: Schema.Array(Filter) },
  success: Schema.Number,
  error: DuckDBError,
  staleTime: "Infinity"
}) {
  static readonly layer = this.toLayer(Effect.gen(function*() {
    const db = yield* DuckDB
    return ({ where }) =>
      db.query(countSql(where)).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)))
  }))
}

// The index a brush on `active` reads from: per cell of `active`, the counts
// per bin of `target`, or the total when `target` is null, kept cumulative.
export class CubeCounts extends Query.Service<CubeCounts>()("crossfilter/CubeCounts", {
  args: { active: Dimension, target: Schema.NullOr(Dimension), where: Schema.Array(Filter) },
  success: Schema.Struct({ cumulative: Schema.Array(Schema.Number), ms: Schema.Number }),
  error: DuckDBError,
  staleTime: "Infinity"
}) {
  static readonly layer = this.toLayer(Effect.gen(function*() {
    const db = yield* DuckDB
    return ({ active, target, where }) =>
      db.columns(cubeSql(active, target, where)).pipe(
        Effect.timed,
        Effect.map(([duration, { bin, cell = [], count = [] }]) => ({
          cumulative: accumulate(cell, bin, count, target === null ? 1 : binCount(target)),
          ms: Duration.toMillis(duration)
        }))
      )
  }))
}

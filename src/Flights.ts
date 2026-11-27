import { Schema } from "effect"

export const Field = Schema.Literals(["delay", "distance", "time"])
export type Field = typeof Field.Type

export const Range = Schema.Tuple([Schema.Number, Schema.Number])
export type Range = typeof Range.Type

export const Filter = Schema.Struct({ field: Field, range: Range })
export type Filter = typeof Filter.Type

export const Dimension = Schema.Struct({
  field: Field,
  label: Schema.String,
  domain: Range,
  step: Schema.Number
})
export type Dimension = typeof Dimension.Type

export const ROWS = 1_000_000

export const dimensions: ReadonlyArray<Dimension> = [
  { field: "delay", label: "Arrival delay (minutes)", domain: [-60, 180], step: 10 },
  { field: "distance", label: "Distance (miles)", domain: [0, 3000], step: 100 },
  { field: "time", label: "Departure time (hour of day)", domain: [0, 24], step: 1 }
]

// One filter per brushed dimension, kept in `dimensions` order so that equal
// selections always give equal query args.
export const setBrush = (
  brushes: ReadonlyArray<Filter>,
  field: Field,
  range: Range | null
): ReadonlyArray<Filter> =>
  dimensions.flatMap((dimension): ReadonlyArray<Filter> =>
    dimension.field === field
      ? range === null ? [] : [{ field, range }]
      : brushes.filter((brush) => brush.field === dimension.field)
  )

// Crossfilter: a chart is filtered by every brush but its own.
export const brushesExcept = (
  brushes: ReadonlyArray<Filter>,
  field: Field
): ReadonlyArray<Filter> => brushes.filter((brush) => brush.field !== field)

// Fields are Schema literals and bounds are numbers, so nothing user-typed
// reaches the SQL text.
export const whereSql = (filters: ReadonlyArray<Filter>): string =>
  filters.length === 0
    ? ""
    : "WHERE " + filters.map(({ field, range: [lo, hi] }) =>
      `${field} BETWEEN ${sqlNumber(lo)} AND ${sqlNumber(hi)}`
    ).join(" AND ")

const sqlNumber = (n: number): string => Number.isFinite(n) ? String(n) : "0"

export const binSql = ({ field, step }: Dimension, filters: ReadonlyArray<Filter>): string =>
  `SELECT floor(${field} / ${sqlNumber(step)}) * ${sqlNumber(step)} AS bin0, count(*)::INTEGER AS count
   FROM flights ${whereSql(filters)}
   GROUP BY 1 ORDER BY 1`

export const dimensionOf = (field: Field): Dimension => dimensions.find((d) => d.field === field)!

export const binCount = ({ domain: [lo, hi], step }: Dimension): number => Math.round((hi - lo) / step)

// An index for brushing `active`: flights counted by cell of `active`, at
// about pixel resolution, and by bin of `target` (or in total), under the
// brushes that hold still while `active` is dragged.
export const CELLS = 1024

export const cellWidth = ({ domain: [lo, hi] }: Dimension): number => (hi - lo) / CELLS

export const cubeSql = (
  active: Dimension,
  target: Dimension | null,
  filters: ReadonlyArray<Filter>
): string => {
  const cell = `least(greatest(floor((${active.field} - ${sqlNumber(active.domain[0])}) / ${
    sqlNumber(cellWidth(active))
  }), 0), ${CELLS - 1})::INTEGER AS cell`
  const bin = target === null ? "" : `, least(greatest(floor((${target.field} - ${
    sqlNumber(target.domain[0])
  }) / ${sqlNumber(target.step)}), 0), ${binCount(target) - 1})::INTEGER AS bin`
  return `SELECT ${cell}${bin}, count(*)::INTEGER AS count FROM flights ${whereSql(filters)} GROUP BY ALL`
}

export const countSql = (filters: ReadonlyArray<Filter>): string =>
  `SELECT count(*)::INTEGER AS count FROM flights ${whereSql(filters)}`

// Synthetic flights with structure worth brushing: departures peak in the
// morning and evening, distances are long-tailed, and delays grow through
// the day. Draws are materialized so each row's random values are fixed.
export const generateSql = `
SELECT setseed(0.42);
CREATE TABLE flights AS
WITH draws AS MATERIALIZED (
  SELECT random() AS u_peak, random() AS u_t1, random() AS u_t2, random() AS u_d,
         random() AS u_y1, random() AS u_y2, random() AS u_y3
  FROM range(${ROWS})
),
shaped AS (
  SELECT
    least(greatest(
      (CASE WHEN u_peak < 0.55 THEN 8.5 ELSE 17.5 END)
        + 2.6 * sqrt(-2 * ln(1 - u_t1)) * cos(2 * pi() * u_t2),
      0), 23.99) AS time,
    least(greatest(120 + 650 * -ln(1 - u_d), 50), 2999) AS distance,
    u_y1, u_y2, u_y3
  FROM draws
)
SELECT
  time::DOUBLE AS time,
  distance::DOUBLE AS distance,
  least(greatest(round(
    -12
    + -ln(1 - u_y1) * (7 + 2.2 * greatest(time - 5, 0))
    + 9 * sqrt(-2 * ln(1 - u_y2)) * cos(2 * pi() * u_y3)
  ), -60), 179)::DOUBLE AS delay
FROM shaped;
`

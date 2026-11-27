import { assert, describe, it } from "@effect/vitest"
import { accumulate, binsIn, countIn } from "./Cube.ts"
import { binCount, CELLS, cellWidth, dimensionOf } from "./Flights.ts"

// Brushing departure time, with distance as the chart the index answers for.
const time = dimensionOf("time")
const distance = dimensionOf("distance")

// A few flights: [hour, miles].
const flights: ReadonlyArray<readonly [number, number]> = [
  [0.2, 120],
  [6.5, 450],
  [6.9, 2_950],
  [12, 1_000],
  [17.25, 450],
  [23.99, 80]
]

const cellOf = (hour: number) => Math.min(CELLS - 1, Math.floor(hour / cellWidth(time)))
const binOf = (miles: number) => Math.min(binCount(distance) - 1, Math.floor(miles / distance.step))

// The rows DuckDB would return for the cube: one per (cell, bin), with a count.
const rows = new Map<string, number>()
for (const [hour, miles] of flights) {
  const key = `${cellOf(hour)}:${binOf(miles)}`
  rows.set(key, (rows.get(key) ?? 0) + 1)
}
const [cells, bins, counts] = [...rows].reduce<[Array<number>, Array<number>, Array<number>]>(
  ([cells, bins, counts], [key, count]) => {
    const [cell, bin] = key.split(":").map(Number)
    return [[...cells, cell!], [...bins, bin!], [...counts, count]]
  },
  [[], [], []]
)

describe("Cube", () => {
  it("answers a brush with the same bins as filtering every flight", () => {
    const cube = accumulate(cells, bins, counts, binCount(distance))
    for (const range of [[0, 24], [6, 7], [6.4, 17.3], [12, 12.01]] as const) {
      const expected = new Map<number, number>()
      for (const [hour, miles] of flights) {
        if (cellOf(hour) >= cellOf(range[0]) && cellOf(hour) <= cellOf(range[1])) {
          expected.set(binOf(miles), (expected.get(binOf(miles)) ?? 0) + 1)
        }
      }
      const got = binsIn(cube, time, distance, range)
      assert.strictEqual(got.length, binCount(distance))
      for (const [b, bin] of got.entries()) {
        assert.strictEqual(bin.bin0, b * distance.step)
        assert.strictEqual(bin.count, expected.get(b) ?? 0, `range ${range} bin ${b}`)
      }
    }
  })

  it("counts the flights in a brush", () => {
    const total = accumulate(cells, undefined, counts, 1)
    assert.strictEqual(countIn(total, time, [0, 24]), flights.length)
    assert.strictEqual(countIn(total, time, [6, 7]), 2)
    assert.strictEqual(countIn(total, time, [13, 17]), 0)
  })
})

import * as duckdb from "@duckdb/duckdb-wasm"
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { generateSql } from "./Flights.ts"

export class DuckDBError extends Schema.TaggedError<DuckDBError>()("DuckDBError", {
  message: Schema.String
}) {}

export type Row = Readonly<Record<string, unknown>>

type Batch = Awaited<ReturnType<duckdb.AsyncDuckDBConnection["send"]>> extends AsyncIterable<infer B> ? B
  : never

const toRows = (batches: ReadonlyArray<Batch>): ReadonlyArray<Row> =>
  batches.flatMap((batch) => batch.toArray().map((row) => row.toJSON()))

// Numeric columns straight from Arrow, for results too big to walk as rows.
const toColumns = (batches: ReadonlyArray<Batch>): Readonly<Record<string, ReadonlyArray<number>>> => {
  const out: Record<string, Array<number>> = {}
  for (const batch of batches) {
    for (const field of batch.schema.fields) {
      const column = (out[field.name] ??= [])
      for (const value of batch.getChild(field.name)!.toArray()) column.push(Number(value))
    }
  }
  return out
}

const toError = (error: unknown) =>
  new DuckDBError({ message: error instanceof Error ? error.message : String(error) })

const bundles: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker }
}

const open = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const bundle = await duckdb.selectBundle(bundles)
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker!))
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
      return db
    },
    catch: toError
  }),
  (db) => Effect.promise(() => db.terminate())
)

const connect = (db: duckdb.AsyncDuckDB) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => db.connect(), catch: toError }),
    (conn) => Effect.promise(() => conn.close())
  )

// Runs one statement. Interrupted while it runs, it asks DuckDB to cancel,
// which is best effort: a short query usually finishes first. It then waits
// for the query to settle, so the next one starts on a quiet connection.
const run = <A>(
  conn: duckdb.AsyncDuckDBConnection,
  sql: string,
  collect: (batches: ReadonlyArray<Batch>) => A
) =>
  Effect.suspend(() => {
    let settled: Promise<unknown> = Promise.resolve()
    return Effect.tryPromise({
      try: (signal) => {
        const result = (async () => {
          const batches: Array<Batch> = []
          for await (const batch of await conn.send(sql)) batches.push(batch)
          return collect(batches)
        })()
        settled = result.catch(() => undefined)
        signal.addEventListener("abort", () => void conn.cancelSent(), { once: true })
        return result
      },
      catch: toError
    }).pipe(Effect.onInterrupt(() => Effect.promise(() => settled)))
  })

export class DuckDB extends Context.Service<DuckDB, {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<Row>, DuckDBError>
  readonly columns: (
    sql: string
  ) => Effect.Effect<Readonly<Record<string, ReadonlyArray<number>>>, DuckDBError>
}>()("crossfilter/DuckDB") {
  static readonly layer = Layer.effect(
    DuckDB,
    Effect.gen(function*() {
      const conn = yield* connect(yield* open)
      for (const statement of generateSql.split(";").map((s) => s.trim()).filter((s) => s !== "")) {
        yield* run(conn, statement, () => undefined)
      }
      // DuckDB-WASM runs one query at a time anyway, so queries wait their
      // turn here instead of in its worker. A query whose fetch is
      // interrupted while it waits, because a newer brush superseded it,
      // never reaches DuckDB.
      const turn = Semaphore.withPermit(yield* Semaphore.make(1))
      return {
        query: (sql: string) => turn(run(conn, sql, toRows)),
        columns: (sql: string) => turn(run(conn, sql, toColumns))
      }
    })
  )
}

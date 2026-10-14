# SQLite adapter for DALgo (browser and Node)

`@dalgo/sqlite-wasm` turns one SQLite connection into a read-write DALgo
`Database`: `get`, `getMany`, `query` and `runReadwriteTransaction` with
`insert`, `set`, `update` and `delete`. It runs wherever a SQLite driver does,
and ships an adapter for the official
[`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
build, so a web page can browse and edit a real SQLite database.

The database also implements `CapabilityAware` and, when you pass `onReset`,
`Resettable` from `@dalgo/core` 0.8.

## Install

```sh
pnpm add @dalgo/sqlite-wasm @dalgo/core @sqlite.org/sqlite-wasm
```

`@sqlite.org/sqlite-wasm` is an optional peer: this package never imports it,
so any driver works.

## Quick start

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Key } from "@dalgo/core";
import { createSqliteDatabase, enableForeignKeys, fromOo1Db } from "@dalgo/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
const driver = fromOo1Db(new sqlite3.oo1.DB(":memory:"));
await enableForeignKeys(driver); // SQLite leaves foreign keys off by default

const db = createSqliteDatabase(driver, { persistent: false });
await db.runReadwriteTransaction(async (tx) => {
  await tx.update(new Key("Artist", 1), { Name: "AC/DC" });
});
const page = await db.query({
  source: { kind: "collection", name: "Album" },
  filters: [{ field: "ArtistId", operator: "==", value: 1 }],
  orders: [{ field: "Title", direction: "asc" }],
  limit: 20,
});
```

An OPFS-backed binding will be published from the `@dalgo/sqlite-wasm/opfs`
subpath; it reuses `fromOo1Db` and `createSqliteDatabase` from this root export.

## Drivers

```ts
interface SqliteDriver {
  exec(sql: string, binds?: readonly SqliteBindValue[]): SqliteExecResult | Promise<SqliteExecResult>;
}
```

A driver runs one statement on one connection and returns its rows (keyed by
column name, values exactly as SQLite produced them) and `changes`. It throws
SQLite's errors unchanged. `fromOo1Db(db)` wraps any `sqlite3.oo1.DB`
(in-memory, OPFS or other VFS). Other drivers, such as `node:sqlite` or
better-sqlite3, need a few lines of glue.

Transactions are run by the database through `exec`: `BEGIN IMMEDIATE` (plain
`BEGIN` when writes are disabled), then `COMMIT`, or `ROLLBACK` if the callback
or any statement fails, so a batch is all-or-nothing. All operations, including
whole transactions, run in order on one queue. Inside a transaction callback
use the transaction argument: calling the database itself would wait for the
transaction to finish and never return.

## Keys and schema

Collections are table names and record keys are `<Table>/<primary key>`, for
example `new Key("Artist", 1)`. The schema is read from the database with
`PRAGMA table_info` and `PRAGMA foreign_key_list` (`db.schema()`), and cached
until `reset()`.

- Record data contains every column, including the primary key. In `insert`
  and `set` the key comes from the `Key`; a primary key field in the data must
  match it. Unknown columns are rejected.
- `set` replaces the record: columns missing from the data get their declared
  default, or NULL. It never deletes the row, so foreign key actions do not fire.
- Tables with a composite primary key are query-only: reads and writes by key
  throw `UnsupportedError("composite primary key")`. Query results identify
  their records with a JSON array of the key values. Tables without a declared
  primary key are query-only too, and their query records use the row's
  ordinal in the result.
- Views and SQLite's internal tables are not exposed.

Queries are compiled by `@dalgo/sqlite-sql` (shared with `@dalgo/d1`):
`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, ordering, `limit`, `offset`
and `DOCUMENT_ID` on single-column keys. Joins and aggregation are not
supported. A query without `limit` returns every matching row.

## Values and NUMERIC fidelity

Values are never coerced. Reads return what SQLite returns: numbers, strings,
`Uint8Array` blobs, `null`, and `bigint` for integers beyond 2^53 (sqlite-wasm).
SQLite stores a `NUMERIC(10,2)` value such as `0.99` as a REAL, so it arrives
as a JavaScript number. To display or edit decimals faithfully, check the
column's `declaredType` from `db.schema()` and render the value as fixed-point
text yourself.

Writes accept strings, finite numbers (integers must be safe), `bigint`,
booleans (stored as 1/0), `null`, `Uint8Array`/`ArrayBuffer`/other byte views
and `{ $type: "blob", base64 }`. Objects, arrays and dates are rejected.

## Errors

| SQLite failure | DALgo error |
| --- | --- |
| UNIQUE or PRIMARY KEY conflict on a write | `AlreadyExistsError` |
| `update` or `delete` of a missing row | `NotFoundError` |
| FOREIGN KEY, NOT NULL, CHECK and other constraints | `ConstraintViolationError` (`code: "constraint_violation"`, `constraint: "foreign_key" \| "not_null" \| "check" \| "unique" \| "other"`) |
| Unsupported table shape or operation | `UnsupportedError` |

The original SQLite error is kept as `cause`. A deferred foreign key failure
surfaces from `COMMIT` as a `ConstraintViolationError` without a `key`.
`mapSqliteError` and `sqliteConstraint` are exported for custom drivers.

## Capabilities and reset

```ts
const db = createSqliteDatabase(driver, {
  write: true,       // insert/set/update; default true
  delete: true,      // default: the write value
  persistent: false, // true when the data survives a reload (OPFS)
  onReset: async (current) => {
    // Restore the initial data. Return a new driver to replace the
    // connection, or nothing to keep using `current`.
  },
});
db.capabilities();
// { read: true, query: true, write: true, delete: true, reset: true,
//   persistent: false, joins: false, aggregation: false }
await db.reset();
```

`reset()` exists only when `onReset` is given, so `isResettable(db)` from
`@dalgo/core` reflects it. It waits for queued work, then calls `onReset` and
forgets the cached schema.

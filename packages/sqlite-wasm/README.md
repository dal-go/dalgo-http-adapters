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

The root export uses no browser API and runs under Node. Browsers persist
edits with the [`/opfs` subpath](#editable-demo-datasets-in-the-browser-opfs).

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

## Editable demo datasets in the browser (`/opfs`)

`@dalgo/sqlite-wasm/opfs` keeps an editable copy of a pinned SQLite dataset in
the [origin private file system](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system),
shared by every tab of the origin. It uses sqlite-wasm's `opfs-sahpool` VFS in
a dedicated worker, which needs **no COOP/COEP headers**: the page does not
have to be cross-origin isolated.

```ts
// demodb.worker.ts: the dataset worker
import { serveDemoDbWorker } from "@dalgo/sqlite-wasm/opfs/worker";
serveDemoDbWorker();
```

```ts
// in the page
import { Key } from "@dalgo/core";
import { LeaderChangedError, openDemoDb } from "@dalgo/sqlite-wasm/opfs";

const session = openDemoDb({
  pin: {
    dataset: "chinook",
    url: "/data/chinook.sqlite",
    sha256: "7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15",
    bytes: 1007616,
  },
  createWorker: () => new Worker(new URL("./demodb.worker.ts", import.meta.url), { type: "module" }),
  serve: {
    // Runs in the leader tab for requests from every tab.
    request: async (payload, { database }) => (await database.get(new Key("Artist", payload as number))).data,
  },
});
const report = await session.ready();
if (report.replacedPreviousVersion) showNotice("The demo data was updated; your edits to the old version were discarded.");
if (!report.persistent) showNotice("Edits are kept in memory only and are lost on reload.");
const artist = await session.request(1);
await session.reset(); // back to the pristine dataset: { canonical: { sha256 } }
```

### Pins and storage

A pin names the pristine file: `{ dataset, url, sha256, bytes }`, where
`sha256` and `bytes` describe the decoded SQLite file. Large files can be
served gzip-compressed in parts, as the demo-db `adventureworks` artifacts are:

```ts
const pin: CanonicalPin = {
  dataset: "adventureworks",
  url: "/data/",                 // the parts resolve against it
  sha256: decodedSha256,         // of the decoded .sqlite file
  bytes: 126820352,              // decoded size
  compression: "gzip",
  parts: [
    { url: "adventureworks.sqlite.gz.part-0001", sha256: part1Sha256, bytes: part1Bytes },
    { url: "adventureworks.sqlite.gz.part-0002", sha256: part2Sha256, bytes: part2Bytes },
  ],
};
```

Every part is checked (size and SHA-256) before the parts are joined and
decoded with `DecompressionStream`, then the decoded file is checked. A file
must be a SQLite database in rollback-journal mode (header bytes 18 and 19 set
to 1), because the pool rewrites WAL headers on import and the stored copy
would no longer match its pin.

Each dataset has its own pool (VFS `demodb-<dataset>`, OPFS directory
`.demodb/<dataset>`) holding two files per version:
`/demodb/<dataset>/<sha256>.sqlite` (the working copy) and
`/demodb/<dataset>/<sha256>.canonical` (the pristine copy). Opening:

1. If both files of the pinned version exist, open the working copy.
2. Otherwise download and verify the pin, import the pristine copy, then the
   working copy.
3. Run `PRAGMA quick_check`; a working copy that fails it (for example after a
   crash during an import) is downloaded and imported again. Then
   `PRAGMA foreign_keys = ON`.
4. Delete the files of every other version of the dataset. If a working copy
   was among them, the report says `replacedPreviousVersion: true`: the edits
   to the old version are gone, and the app should say so once. There is no
   migration of edits between versions.

The first write transaction asks for persistent storage
(`navigator.storage.persist()`); `session.persistence()` reports `"granted"`,
`"denied"` or `"unavailable"`. Firefox shows the user a prompt, so the promise
can stay pending.

`reset()` closes the connection, overwrites the working copy with the pristine
copy (downloading it again if it no longer matches the pin), drops the
journal, reopens it and checks that it is byte-identical to the pin. It
returns `{ canonical: { sha256 } }`; the database's `reset()` (DALgo
`Resettable`) does the same. The database reports
`capabilities()` with `reset: true` and `persistent: true`.

### Without OPFS

When the pool cannot be used (no OPFS or sync access handles, for example in a
Firefox private window or a webview, OPFS refused, quota exhausted, or files
still locked after every retry), the dataset is downloaded, verified and
loaded into memory with `sqlite3_deserialize`. Reads, writes and reset work;
edits are lost on reload. The report has `persistent: false` and a typed
`fallback: { kind: "memory", reason, message }` with `reason` one of
`"missing-api" | "security" | "sync-handles-unavailable" | "locked" | "quota" | "other"`.

### Tabs: one leader

An exclusive Web Lock (`navigator.locks`, named `demodb:<dataset>`) picks one
leader tab per dataset. The leader starts the worker, opens the dataset and
answers every tab, itself included, over a `BroadcastChannel` of the same
name. Other tabs are followers: `session.request(payload)` and
`session.reset()` go to the leader, which runs `serve.request(payload,
{ database, report })`. `session.role` is `connecting`, `leader`,
`follower`, `suspended`, `failed` or `closed`; `session.subscribe` reports
role changes, `opened` and errors.

When the leader tab closes, crashes or navigates away, the browser releases
its lock and a waiting tab becomes the leader and reopens the same OPFS files,
so every committed write is kept. A request that was in flight to the old
leader fails with `LeaderChangedError` (`retriable: true`); retry it. Requests
made while no leader is known wait for the next one. A crashed worker (an
`error` event) is replaced up to `maxWorkerRestarts` times (default 3).

- `pagehide` stops the worker and releases the lock at once (so the next tab
  or the reloaded page takes over quickly); `pageshow` from the back/forward
  cache rejoins.
- When the page becomes visible while no leader is known, the tab asks for one
  again.
- A reload can find the pool's files still locked by the worker of the page
  being unloaded (`NoModificationAllowedError` in Chromium and Firefox, a bare
  `InvalidStateError` in WebKit). Before installing the pool the worker probes
  every pool file and waits with exponential backoff (50 ms doubling to 1 s,
  10 attempts) until the handles are free. Probing first matters:
  `installOpfsSAHPoolVfs` reacts to a lock failure by calling `removeVfs()`,
  which deletes the pool's directory.

Without Web Locks every tab leads its own worker; the pool still allows only
one of them to hold the files, so the others wait and then fall back to
memory (by design; not exercised by the browser suite). Two tabs pinned to different versions of a dataset share one leader:
the follower is served the leader's version (its `report.canonical.sha256`
says which).

### Ports for OVDB

`session.connect(protocol?)` returns a `MessagePort`-shaped endpoint, the
`FetchPort` contract of `@openvaultdb/inprocess`, routed to whichever tab
leads. The leader serves each endpoint with `serve.port(port, context)`. This
package does not depend on OVDB; wiring it looks like this:

```ts
const session = openDemoDb({
  pin, createWorker,
  serve: { port: (port, { database }) => serveFetchOverPort(createOvdbFetch(/* over database */), port) },
});
const fetch = fetchOverPort(session.connect({
  requestId: (m) => (m as { type?: string }).type === "openvaultdb/fetch-request" ? (m as { id: number }).id : undefined,
  responseId: (m) => (m as { type?: string }).type === "openvaultdb/fetch-response" ? (m as { id: number }).id : undefined,
  failure: (m, error) => ({ type: "openvaultdb/fetch-response", id: (m as { id: number }).id, ok: false, name: error.name, message: error.message }),
}));
```

The `protocol` tells the endpoint which messages are requests and answers, so
a request in flight when the leader changes is answered with `failure(...)`
(a `LeaderChangedError`) instead of hanging. Transfer lists are ignored:
`BroadcastChannel` copies the data.

### Browser support (verified)

The Playwright suite in `test/browser` runs the real Chinook file (served
without COOP/COEP; it asserts `crossOriginIsolated === false`) in a fresh
persistent profile per test:

| Check | Chromium 156 | Firefox 157 | WebKit 27.2 |
| --- | --- | --- | --- |
| OPFS sahpool in a worker, edit survives reload | yes | yes | yes |
| delete survives reload, reset restores the pin | yes | yes | yes |
| changed pin replaces the old version | yes | yes | yes |
| gzip parts verified and opened | yes | yes | yes |
| hidden `getDirectory` falls back to memory | yes | yes | yes |
| two tabs read and write through one leader | yes | yes | yes |
| leader tab closes, the other takes over, no data lost | yes | yes | yes |
| fast reloads | yes | yes | yes |
| pool locked by a terminating worker is waited for | yes (`NoModificationAllowedError`) | yes (`NoModificationAllowedError`) | yes (`InvalidStateError`) |
| Playwright's ephemeral (private-like) context | OPFS | OPFS | memory fallback: `getDirectory()` rejects with `UnknownError` |

Not verified: real Safari, iOS, Android and in-app webviews, the
back/forward cache path in a browser (covered by unit tests only), and
opening `adventureworks` in a browser: the browser suite runs the gzip-parts
path on a gzip of Chinook split in two, and the real `adventureworks` parts
(two parts, 126,820,352 decoded bytes) were verified by `fetchCanonical`
under Node only. Playwright's WebKit keeps OPFS data outside the
profile directory, so the suite wipes the origin's OPFS before and after each
test.

```sh
pnpm exec playwright install chromium firefox webkit
CHINOOK_SQLITE=/path/to/demo-db/chinook/artifacts/data/chinook.sqlite pnpm test:browser
```

### Bundle size

Measured with `node test/browser/bundle-size.ts` (esbuild, minified, ES2022;
the main-thread entry keeps every export):

| Asset | Raw (minified) | gzip -9 | brotli 11 |
| --- | --- | --- | --- |
| `/opfs` main-thread entry (`@dalgo/core` external) | 27.1 KiB | 9.4 KiB | 8.4 KiB |
| dataset worker (`/opfs/worker` + sqlite-wasm JS) | 221.3 KiB | 68.1 KiB | 60.1 KiB |
| `sqlite3.wasm` | 848.5 KiB | 392.6 KiB | 340.6 KiB |

`@sqlite.org/sqlite-wasm` is needed by the worker only: install it and let
the bundler emit `sqlite3.wasm` next to the worker (sqlite-wasm loads it from
`new URL("sqlite3.wasm", import.meta.url)`).

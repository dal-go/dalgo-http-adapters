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
pnpm add @dalgo/sqlite-wasm @dalgo/sqlite-sql @dalgo/core @sqlite.org/sqlite-wasm
```

`@dalgo/core` and `@dalgo/sqlite-sql` (the query compiler shared with
`@dalgo/d1`) are peers. `@sqlite.org/sqlite-wasm` is an optional peer: the
root export never imports it, so any driver works; the `/opfs/worker` entry
needs it.

The peer range on `@dalgo/core` is `>=0.7.4 <0.9.0`. At runtime the package
uses only what core 0.7.4 already has (`Key`, the DALgo errors,
`identityCodec`); its type declarations import `CapabilityAware`,
`DatabaseCapabilities` and `Resettable`, which arrive with core 0.8
(dal-go/dalgo-js commit `24eb5b7`, which still reports version 0.7.4). With
the npm 0.7.4 build, TypeScript fails on those imports.

### Installing before `@dalgo/core` 0.8.0 and `@dalgo/sqlite-sql` are published

Pin all three from GitHub in the consuming project (pnpm 11). `<sha>` is a
dal-go/dalgo-http-adapters commit that contains this package:

```jsonc
// package.json
"@dalgo/core": "github:dal-go/dalgo-js#24eb5b7ef8f044c274cb33beda353b2413e17c42",
"@dalgo/sqlite-sql": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/sqlite-sql",
"@dalgo/sqlite-wasm": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/sqlite-wasm",
"@sqlite.org/sqlite-wasm": "3.53.4-build2"
```

```yaml
# pnpm-workspace.yaml: the GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/24eb5b7ef8f044c274cb33beda353b2413e17c42': true
  '@dalgo/sqlite-sql@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/sqlite-sql': true
  '@dalgo/sqlite-wasm@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/sqlite-wasm': true
```

`@dalgo/sqlite-sql` is a peer rather than a dependency so that this works with
pnpm 11's default `blockExoticSubdeps`: a GitHub-hosted dependency of a
dependency would be refused. The package's `prepack` builds `sqlite-sql`
before itself, which is what makes the GitHub-path install build.

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
| PRIMARY KEY conflict on `insert` (`SQLITE_CONSTRAINT_PRIMARYKEY`) | `AlreadyExistsError` |
| UNIQUE conflict on another column (`SQLITE_CONSTRAINT_UNIQUE`) | `ConstraintViolationError` with `constraint: "unique"`; the message names the column |
| `update` or `delete` of a missing row | `NotFoundError` |
| FOREIGN KEY, NOT NULL, CHECK and other constraints | `ConstraintViolationError` (`code: "constraint_violation"`, `constraint: "foreign_key" \| "not_null" \| "check" \| "unique" \| "other"`) |
| Unsupported table shape or operation | `UnsupportedError` |

The original SQLite error is kept as `cause`. A deferred foreign key failure
surfaces from `COMMIT` as a `ConstraintViolationError` without a `key`.
`mapSqliteError(error, key?, primaryKey?)` and `sqliteConstraint` are exported
for custom drivers; without extended result codes, pass the table's primary
key columns so a UNIQUE failure can be told apart from a key conflict.

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
  onProgress: ({ phase, loaded, total }) => showProgress(phase, loaded, total), // see Progress
  // memoryFallback: "forbid",     // fail instead of keeping edits in memory only
  // storagePolicy: "single-copy", // one OPFS copy; reset downloads again
});
const report = await session.ready(); // rejects if the dataset cannot be opened
if (report.replacedPreviousVersion) showNotice("The demo data was updated; your edits to the old version were discarded.");
if (!report.persistent) showNotice("Edits are kept in memory only and are lost on reload.");
const artist = await session.request(1);
await session.reset(); // back to the pristine dataset: { canonical: { sha256 } }
```

### Downloading the current database

`await session.export()` returns an independent `Uint8Array` containing the current
SQLite working copy, including committed edits, inserts and deletions. It works
from the leader or a follower tab, in OPFS and memory modes. It never downloads
the canonical file or reads the pristine copy.

```ts
const bytes = await session.export();
const file = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/vnd.sqlite3" });
// Offer this Blob as a download, then release the object URL after use.
```

Export waits for complete queued transactions, including commit or rollback,
without requesting persistent storage. Its default and hard maximum is 256 MiB;
`session.export({ maxBytes })` may choose a smaller positive integer limit. The
worker checks the SQLite page count and page size before allocating a snapshot,
and transfers the result buffer to the leader. A follower receives a bounded
binary copy over BroadcastChannel; no base64 or JSON representation is created.

Only one export may be in progress per leader. Consumer-visible errors retain
their `code` and message across the worker and tab bridges:

| Code | Recovery |
| --- | --- |
| `sqlite_export_too_large` | Export a smaller database or reduce its size. |
| `sqlite_export_busy` | Wait for the current export to finish, then retry. |
| `leader_changed` | Retry after the dataset has a current leader. |
| `worker_unavailable` | Retry after the worker has reopened the dataset. |

A pending export rejects when its leader steps down, crashes, or closes; a late
response from that leader cannot become a successful download. The root package
also exposes `SqliteDatabase.export()` for providers that supply an `onExport`
callback. Custom callbacks must return owned bytes and respect the supplied
limit; a database without that callback rejects export explicitly.

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
`/demodb/<dataset>/<sha256>.canonical` (the pristine copy; none with
`storagePolicy: "single-copy"`, see [Storage policy](#storage-policy-one-copy-or-two)). Opening:

1. If both files of the pinned version exist, open the working copy.
2. No working copy (first open, or a crash during an import): write it from
   the pristine copy, downloading and verifying the pin first when the
   pristine copy is missing or no longer matches it.
3. A working copy without a pristine copy: download only the pristine copy.
   The working copy and its edits are kept.
4. Run `PRAGMA quick_check` and turn on `PRAGMA foreign_keys`. Only a damaged
   working copy (`quick_check` fails, or SQLite reports `SQLITE_CORRUPT` or
   `SQLITE_NOTADB`) is written again from the pristine copy, once. Any other
   failure (I/O, quota, a full pool, foreign keys that cannot be enabled) is
   thrown as `DatasetStorageError` and the working copy is not touched.
5. Delete the files of every other version of the dataset. If a working copy
   was among them, the report says `replacedPreviousVersion: true`: the edits
   to the old version are gone, and the app should say so once. There is no
   migration of edits between versions.

The first write transaction asks for persistent storage
(`navigator.storage.persist()`); `session.persistence()` reports `"granted"`,
`"denied"` or `"unavailable"`. Firefox shows the user a prompt, so the promise
can stay pending.

`reset()` closes the connection, replaces the working copy with the pristine
copy (downloading it again if it no longer matches the pin), drops the
journal, reopens it and checks that it is byte-identical to the pin.

Every write of a whole file unlinks the old one first. sqlite-wasm 3.53's
`importDb` overwrites a pool file in place and never shrinks it, so a working
copy that had grown past the pristine size would keep its old tail; unlinking
truncates the slot, and the pool names a slot only once the whole file is
written, so a crash during an import leaves the file missing (and the next
open writes it again) rather than half old and half new. It
returns `{ canonical: { sha256 } }`; the database's `reset()` (DALgo
`Resettable`) does the same. The database reports
`capabilities()` with `reset: true` and `persistent: true`.

### Storage policy: one copy or two

`openDemoDb({ storagePolicy })` chooses how many copies of the pinned
version OPFS keeps:

| | `"working-and-pristine"` (default) | `"single-copy"` |
| --- | --- | --- |
| OPFS files per version | working copy + pristine copy | working copy only (half the space) |
| first open | download, write pristine, write working | download, write working |
| `reset()` | from the pristine copy, offline | downloads and verifies the pin again (needs the network) |
| damaged working copy | rewritten from the pristine copy | rewritten from a fresh download |
| a failed reset download | n/a | throws; the connection and the edits are kept |

In single-copy mode a missing pristine copy is expected, never an error. The
reset downloads and verifies the file (size and SHA-256 from the pin) while
the connection is still open, then closes it, unlinks the working copy and
imports the new one, so a crash in between leaves no working copy and the
next open writes it again; the reopened file is checked to be
byte-identical to the pin. Switching a dataset to `"single-copy"` deletes
its pristine copy at the next open (a still-valid one is used first if the
working copy is missing); switching back downloads it again. Version changes
work as described above under both policies. The leader tab's policy
applies. Use single-copy for large datasets where storage matters more than
an offline reset; a quota failure while writing a copy surfaces as
`DatasetStorageError` with `operation: "import"` (see
[Errors](#errors-across-the-worker-and-the-tabs)).

### Progress

`openDemoDb({ onProgress })` is called in the tab that leads while its
worker opens or resets the dataset (followers do not open it and get no
progress). Events are `{ phase, loaded?, total? }`, structured-clone safe,
at most one every 100 ms within a phase plus every phase change:

| Phase | When | `loaded` / `total` |
| --- | --- | --- |
| `fetch` | downloading the canonical file (first and last event always sent) | bytes read so far / bytes to read when known |
| `verify` | sizes, SHA-256 and gzip decoding of the download, or the SHA-256 of a stored pristine copy | none |
| `importPristine` | writing the pristine copy | `total`: its size |
| `importWorking` | writing the working copy | `total`: its size |
| `open` | opening the working copy and `PRAGMA quick_check` | none |

Phases come in this order and are skipped when not needed: a first open is
`fetch, verify, importPristine, importWorking, open`; a reopen is `open`; a
reset is `verify, importWorking, open` (single-copy: `fetch, verify,
importWorking, open`); the memory fallback is `fetch, verify, open`.

During `fetch`, `loaded` counts response body bytes as the page receives
them, after the browser has undone any HTTP `Content-Encoding`. `total` is
the sum of the parts' `bytes` for a pin with `parts`; the pin's `bytes`
(the decoded size) for a single uncompressed file; for a single
`compression: "gzip"` file, the `Content-Length` when the response has no
`Content-Encoding` header. A `Content-Length` that turns out smaller than
the body (for example a cross-origin response whose `Content-Encoding` is
not exposed) is dropped. Otherwise `total` is absent: show an indeterminate
bar. A listener that throws is ignored. In a custom worker,
`serveDemoDbWorker({ onProgress })` sees the same events for every open and
reset.

### Errors across the worker and the tabs

Errors keep their class when they cross from the dataset worker to the
leader tab, and from the leader tab to a follower: `DatasetStorageError`
(with `operation: "import" | "open"`), `PoolUnavailableError` (`reason`,
`retriable`), `CanonicalFetchError` (`status`), `CanonicalIntegrityError`,
`CorruptDatabaseError` and `DemoDbConfigError` are rebuilt as instances of
their class with `name`, `code` and their fields; the `cause` comes back as
an `Error` with its name and message (stacks are never sent). So a quota
failure is `error instanceof DatasetStorageError && error.operation ===
"import"` with `error.cause.name === "QuotaExceededError"`, not a message
to parse. Other errors from the worker are plain `Error`s with the
serialized name and fields (`resultCode`, so `mapSqliteError` works); other
errors a follower gets from the leader's handlers are
`RemoteRequestError`s with the same fields. `serializeError` and
`reviveError` are exported for custom transports.

### Without OPFS

When OPFS is unsupported or refused here (no OPFS or sync access handles, for
example in a Firefox private window or a webview; access refused; quota
exhausted; any other install failure), the dataset is downloaded, verified
and loaded into memory with `sqlite3_deserialize`. Reads, writes and reset
work; edits are lost on reload. The report has `persistent: false` and a typed
`fallback: { kind: "memory", reason, message }` with `reason` one of
`"missing-api" | "security" | "sync-handles-unavailable" | "quota" | "other"`,
or:

- `"web-locks-unavailable"`: the browser has no Web Locks, so tabs cannot
  share the OPFS files safely (see below);
- `"requested"`: `openDemoDb({ storage: "memory" })`;
- `"locked"`: only with `memoryFallbackWhenLocked: true`, see below.

`openDemoDb({ memoryFallback: "forbid" })` refuses the memory fallback
altogether: where OPFS cannot be used (any reason above, including a
browser without Web Locks) the session fails with `PoolUnavailableError`
(`ready()` rejects, `role` is `failed`) **before the canonical file is
downloaded**, so a large dataset is never fetched only to be lost on
reload. The default is `"allow"`. It contradicts `storage: "memory"` and
`memoryFallbackWhenLocked: true`; both combinations throw
`DemoDbConfigError`.

A pool whose files are **locked** right now is different: the stored dataset
is fine, just held by another context. The worker waits for it (20 attempts,
50 ms doubling to 1 s, about 16 s) and then fails with
`PoolUnavailableError { reason: "locked", retriable: true }`: `ready()`
rejects and `session.role` is `failed`, and the app can offer to try again.
It does not drop to memory by itself, because edits made there would be lost
on reload; `openDemoDb({ memoryFallbackWhenLocked: true })` opts in to that.

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
leader fails with `LeaderChangedError` (`retriable: true`). Retries give
**at-least-once** delivery: the old leader may have committed the write just
before it went away, so a retried write can run twice. Make retried writes
idempotent (`set` and `update` to absolute values are; an `insert` retried
after it committed fails with `AlreadyExistsError`), or read before writing
again. Requests made while no leader is known wait for the next one.

A crashed worker (an `error` event) is replaced up to `maxWorkerRestarts`
times in a row (default 3); a worker that led for `restartWindowMs` (default
60 s) before crashing starts the count again.

- `pagehide` stops the worker and releases the lock at once (so the next tab
  or the reloaded page takes over quickly); `pageshow` from the back/forward
  cache rejoins.
- When the page becomes visible while no leader is known, the tab asks for one
  again.
- A reload can find the pool's files still locked by the worker of the page
  being unloaded (`NoModificationAllowedError` in Chromium and Firefox, a bare
  `InvalidStateError` in WebKit). Before installing the pool the worker probes
  every pool file and waits with exponential backoff (50 ms doubling to 1 s,
  20 attempts) until the handles are free. Probing first matters:
  `installOpfsSAHPoolVfs` reacts to a lock failure by calling `removeVfs()`,
  which deletes the pool's directory.

OPFS needs leader election. If several tabs installed the pool at once, the
losers' failed installs would make sqlite-wasm's `removeVfs()` delete the pool
directory. So `openDemoDb({ locks: null })` throws `DemoDbConfigError` unless
it also says `storage: "memory"`, and in a browser without Web Locks the
session keeps the dataset in memory (fallback reason
`"web-locks-unavailable"`).

Two tabs pinned to different versions of a dataset share one leader: the
follower is served the leader's version (its `report.canonical.sha256` says
which).

### Ports for OVDB

`session.connect(protocol?)` returns a `MessagePort`-shaped endpoint, the
`FetchPort` contract of `@openvaultdb/inprocess`, routed to whichever tab
leads. The leader serves each endpoint with `serve.port(port, context)`.

Both kinds of port (`BridgePort`) keep listeners per event type, like an
`EventTarget` (`once` and `signal` work):

- `message`: a message from the other side, and nothing else.
- `close`: dispatched once. A tab's port closes when `port.close()` is
  called or its session closes or fails; a port opened after the session
  closed closes in a microtask. A served port (in the leader) closes when
  the tab's port closed, that tab left, or the leader stepped down. After
  `close` no messages are dispatched and `postMessage` does nothing.
- `messageerror`: accepted, never dispatched (data is copied by
  `BroadcastChannel`, not transferred).
- `start()` and `close()` exist, as on `MessagePort`.

A leader change does **not** close a tab's port: requests in flight to the
old leader are answered with the protocol's `failure(...)` and later
messages go to the new leader, so one `fetchOverPort(session.connect(...))`
stays usable for the life of the session. This package does not depend on
OVDB; wiring it looks like this:

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
browser context per test:

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
| pool that stays locked fails as retriable; memory only when opted in | yes | yes | yes |
| reset after the working copy grew by 2 MB and 3 MB, then reset again | yes | yes | yes |
| two tabs opening at the same moment keep stored edits | yes | yes | yes |
| 30 sequential requests over one follower port with `message` + `close` listeners | yes | yes | yes |
| progress phases in order; `fetch` counted against the pin | yes | yes | yes |
| `storagePolicy: "single-copy"`: reset downloads again, edits survive reload | yes | yes | yes |
| `memoryFallback: "forbid"` fails before any download | yes | yes | yes |
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

CI runs the suite in Chromium and Firefox (job `sqlite-wasm-browsers`)
whenever `sqlite-wasm`, `sqlite-sql`, the lockfile or the workflow changes,
with the pinned `chinook.sqlite` downloaded from chinook.demodb.dev and
checked against its SHA-256. WebKit runs locally only: it needs a persistent
profile for OPFS, and on Linux runners a persistent WebKit context aborts
MiniBrowser ("automation is not allowed in the context") when the suite opens
a second page. Chromium and Firefox run in ephemeral contexts, WebKit in a
fresh persistent profile per test.

### Bundle size

Measured with `node test/browser/bundle-size.ts` (esbuild, minified, ES2022;
the main-thread entry keeps every export):

| Asset | Raw (minified) | gzip -9 | brotli 11 |
| --- | --- | --- | --- |
| `/opfs` main-thread entry (`@dalgo/core` external) | 32.2 KiB | 11.0 KiB | 9.9 KiB |
| dataset worker (`/opfs/worker` + sqlite-wasm JS) | 225.0 KiB | 69.4 KiB | 61.3 KiB |
| `sqlite3.wasm` | 848.5 KiB | 392.6 KiB | 340.6 KiB |

`@sqlite.org/sqlite-wasm` is needed by the worker only: install it and let
the bundler emit `sqlite3.wasm` next to the worker (sqlite-wasm loads it from
`new URL("sqlite3.wasm", import.meta.url)`).

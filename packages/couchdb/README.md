# DALgo adapter for Apache CouchDB

`@dal-go/dalgo2couchdb` is a deliberately bounded TypeScript adapter from
[`@dalgo/core`](https://github.com/dal-go/dalgo-js) to an existing Apache
CouchDB database using its document and [Mango query API](https://docs.couchdb.org/en/stable/api/database/find.html).
It offers two explicit storage modes: a managed `__dalgo_*` envelope, and a
read-only native application-document mode that never writes an envelope. It
does not call CouchDB administration, user, cluster, or configuration APIs.

## Security and browser boundary

Supply an HTTPS database URL without credentials and a `headers` provider. The
provider runs for **every request**, so an application can obtain a refreshed,
short-lived Bearer token or cookie from its own authenticated token broker. The
adapter neither stores nor logs those values. Never put a CouchDB credential in
a URL, source control, analytics, browser storage, error report, or log.

Direct browser access requires a deliberate CouchDB CORS configuration and a
token/cookie design appropriate to the deployment. Configure only the trusted
origins, methods, and headers your application needs; do not use a wildcard
origin with credentials. CouchDB documents its [HTTP/CORS configuration](https://docs.couchdb.org/en/stable/config/http.html#cors), but deciding the
origin allowlist, authentication scheme, cookie policy, proxy boundary, token
audience, and database permissions remains application work.

The package source is browser-safe and imports no Node built-in. A real browser
CORS proof against a disposable CouchDB is included as a package script, but
the DataTug form/factory/query-session wiring and the whole DataTug UI journey
remain separate verification gates and are not claimed by the package tests.

## Install

`@dalgo/core` and `@dalgo/adapter-runtime` are peers. This package is not yet
published to npm. First-wave consumers pin a reviewed commit of this monorepo as
a pnpm Git subdirectory dependency, the same pattern used by
`@dalgo/sqlite-wasm`.

Each `github:` subdirectory dependency is fetched as its own workspace copy, and
only that copy is prepared. The package's `prepack` therefore builds
`@dalgo/adapter-runtime` from the same commit before type-checking itself; a
separate prebuilt runtime tarball or a local workspace link is not required.
Substitute the full 40-character SHA of the reviewed merged commit for
`<merged-sha>` in every place below:

```jsonc
// package.json
"@dalgo/core": "github:dal-go/dalgo-js#99165e9e1a39c32abee2b39d6395677843bc3559",
"@dalgo/adapter-runtime": "github:dal-go/dalgo-http-adapters#<merged-sha>&path:/packages/adapter-runtime",
"@dal-go/dalgo2couchdb": "github:dal-go/dalgo-http-adapters#<merged-sha>&path:/packages/couchdb"
```

```yaml
# pnpm-workspace.yaml: pnpm blocks build scripts until each exact package is approved
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/99165e9e1a39c32abee2b39d6395677843bc3559': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/adapter-runtime': true
  '@dal-go/dalgo2couchdb@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/couchdb': true
```

If an entry is missing, pnpm names the exact key it needs; approve only the
reviewed dependency, never a wildcard. From this repository,
`pnpm check:git-subdir-consumer` installs these three packages from a temporary
Git repository in a clean consumer and requires a strict typecheck, a dynamic
import of every entry point, exactly one `@dalgo/core` `0.7.4` instance, no
`@dal-go/dalgo`, and no local links. Run the identical check against a pushed
commit with
`DALGO_ADAPTER_GIT_SUBDIR_REF=github:dal-go/dalgo-http-adapters#<sha> pnpm check:git-subdir-consumer`.

The `@dalgo/core` peer range is `>=0.7.4 <0.9.0`; the workspace tests against the
exact `0.7.4` commit the web UI pins, so the browser contains one `Key`/query
identity. From the repository root, `pnpm install --frozen-lockfile` and
`pnpm --filter @dal-go/dalgo2couchdb check` run the workspace gate.

## Minimal setup

```ts
import { collection } from "@dalgo/core";
import { CouchDbDatabase } from "@dal-go/dalgo2couchdb";

const db = new CouchDbDatabase({
  databaseUrl: "https://couch.example.com/app",
  headers: async () => ({ authorization: `Bearer ${await getFreshCouchToken()}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
```

The type-checked version is [examples/basic.ts](examples/basic.ts). The
database must already exist and the supplied identity must have only the
required database-level permissions.

## Physical document layout and MVCC

One configured CouchDB database holds all adapter records. The adapter creates
a deterministic, opaque `_id` from the DALgo collection path and string or
safe-integer key ID. It stores the original values alongside codec data:

| CouchDB property | Meaning |
| --- | --- |
| `_id` | Adapter-owned deterministic document ID. |
| `_rev` | CouchDB MVCC revision; returned in `RecordSnapshot.metadata.revision`. |
| `__dalgo_collection` | Full DALgo collection path. |
| `__dalgo_id` | Original DALgo string or safe-integer key ID. |
| `data` | Codec-encoded, non-null plain JSON object. |

CouchDB requires the current revision to update or delete a document. `set`
and `delete` first read the revision and then send a conditional write. A
concurrent change is never silently overwritten: HTTP 409 becomes
`CouchDbConflictError`, carrying the DALgo key. Callers needing retry behavior
must re-read and decide how to merge their own data. This follows CouchDB's
[document PUT](https://docs.couchdb.org/en/stable/api/document/common.html#put--db-docid)
and [DELETE](https://docs.couchdb.org/en/stable/api/document/common.html#delete--db-docid)
revision rules.

This is the **managed-envelope** layout used by `CouchDbDatabase`. It is not the
only supported layout: `NativeCouchDbDatabase` reads pre-existing application
documents without that envelope and is described below. The managed
`COUCHDB_READ_CAPABILITIES` constant deliberately does not claim native reading.

## Native application-document mode (read-only)

`NativeCouchDbDatabase` exposes existing CouchDB documents. One configured
CouchDB database maps to exactly **one configured logical DALgo collection**;
the adapter never infers schema-less collections inside it. No `__dalgo_*` or
`data` envelope is written or required.

```ts
import { collection } from "@dalgo/core";
import { NativeCouchDbDatabase } from "@dal-go/dalgo2couchdb";

const db = new NativeCouchDbDatabase({
  databaseUrl: "https://couch.example.com/app",
  collection: "items",
  headers: async () => ({ authorization: `Bearer ${await getFreshCouchToken()}` }),
  permittedIndexes: [{
    ddoc: "_design/status-id",
    name: "status-id-index",
    fields: [
      { field: "status", direction: "asc" },
      { field: "_id", direction: "asc" },
    ],
  }],
});

const items = collection<{ title: string; status: string }>("items");
const page = await db.queryWithSignal({
  ...items.query().where("status", "==", "open").orderBy("status").limit(20).build(),
  projection: ["_id", "title"],
}, signal);
```

The type-checked version is [examples/native.ts](examples/native.ts).

| CouchDB document | Native DALgo mapping |
| --- | --- |
| `_id` (string) | `Key.id` and the preserved `data._id` field. |
| `_rev` | `RecordSnapshot.metadata.revision` and the preserved `data._rev` field when returned. |
| other fields | Returned unchanged in `data`; nested values, explicit `null` and arrays are never flattened or rewritten. |
| configured database | The only resource exposed; `Key.collection` must equal `collection` and nested keys are refused. |

A projection is an additive `NativeCouchDbQuery` option, because the modern
`@dalgo/core` `StructuredQuery` has no projection member. A projection must
explicitly include `_id`; CouchDB otherwise omits it, and the adapter refuses
that projection before HTTP rather than dropping the native ID. When `_rev` is
not projected, `metadata` contains `id` but no fabricated revision. The
`/app` database in a real fixture can be queried directly; cluster
`_all_dbs`, administration, user and configuration endpoints are never called.

### Read-only guarantee

`NativeCouchDbDatabase` implements the read/query side of `Database` and
deliberately does not implement the `WriteSession` contract. `insert`, `set`, `update`, `delete` and
`runReadwriteTransaction` still exist as explicit runtime refusals: each
rejects with `UnsupportedError` before any HTTP request. `readOnly` is `true`.
Use the managed `CouchDbDatabase` or a different adapter for writes.

### Batched point reads

`getMany` validates the whole bounded key list before I/O, preserves input
order, and runs at most `maxParallelReads` (default 8) requests.
`getManyWithSignal(keys, signal)` adds caller cancellation. One
operation-wide deadline (the configured `timeoutMs`) covers every key's header
acquisition, fetch and response-body read; it is not renewed per key. The first
failure — provider error, malformed or unsafe document, cancellation, or budget
— aborts in-flight sibling requests and prevents any later key from being
requested. A batch either returns every snapshot in order or fails; no partial
batch is returned, and a late response body cannot join a failed batch.

`maxGetManyBytes` (default 1 MiB, hard maximum 16 MiB) bounds the cumulative
decoded response bytes one batch may retain. It is checked from the exact
response-body byte counts before a result is accepted, so individually valid
documents that together exceed the budget fail with `CouchDbBatchSizeError`
rather than growing memory. Each request still has its own `maxResponseBytes`
ceiling. Point `get` remains an independent request with its own deadline.

### Numeric policy

CouchDB JSON numbers are eventually decoded by `JSON.parse`, which would
silently round an integer such as `9007199254740993` to `9007199254740992`.
Before parsing, the adapter scans the raw response text outside strings and
refuses any integer-valued number outside the safe-integer range, including
integer-valued decimal/exponent forms, and refuses `-0` and non-finite numbers.
Safe integers (`|n| <= 2^53-1`) are preserved exactly, numbers inside strings are
untouched, and a configured codec never receives a rounded integer. Request
bodies must also contain only finite safe integers.

This release has no lossless BigInt or arbitrary-precision number
representation; refusal is deliberate. Non-integer decimal/exponent values keep
normal IEEE-754 semantics. Cursor payloads are no longer JSON on the wire, so
the same policy applies uniformly to `get`, `getMany`, queries and discovery in
both the managed and native layouts.

### Filters, NULL and missing values

Supported filters are simple top-level fields plus `_id`/`_rev`; `DOCUMENT_ID`
maps to `_id`. Operators are `==`, `!=`, `<`, `<=`, `>`, `>=`, `in` and
`not-in`. Complex/dotted paths, array operators, `undefined`, and null with
ordering operators are refused before I/O. CouchDB's own semantics are kept:

- `field == null` matches an explicitly stored JSON `null` only.
- `field != null` matches a present, non-null value only.
- A missing field matches neither expression. Missing is not silently treated
  as `null`, and the adapter has no `$exists` escape hatch.

### Ordered queries and allowed indexes

An unordered query is bounded by `limit` and the Mango bookmark; CouchDB chooses
the index. An ordered DALgo query is admitted **only** when:

1. all sort directions are the same;
2. `_id` is the final sort field (the adapter appends it when omitted);
3. a configured `permittedIndexes` entry has exactly those fields and
   directions;
4. at least one requested sort field has an equality, range or `in` filter, as
   CouchDB's Mango index selection requires.

The request sends that index with `use_index` and `allow_fallback: false`. A
missing/mismatched index, mixed direction, or unfiltered sort is rejected before
HTTP; the adapter never claims a generic sort fallback. There is no raw Mango
selector or sort escape hatch.

### Bookmarks, projection and cursor binding

`queryWithSignal(query, signal)` combines the caller abort with one end-to-end
deadline covering header acquisition, fetch, body reading and each continuation
request. A pre-aborted caller performs no header/fetch work, and a late body is
cancelled rather than returned.

Pages use the configured `limit` (default 100, hard maximum 1,000). A full page
must include a Mango bookmark; if CouchDB omits it, the adapter throws rather
than reporting a false completion. `nextCursor` contains one adapter-issued
opaque handle. The adapter keeps a bounded, per-instance registry entry for the
complete handle: endpoint/instance, collection, query/filter/sort/projection
fingerprint, effective page size, credential scope and provider bookmark. The
handle is generated from 256 random bits and contains no bookmark, filter value,
query or credential. The provider bookmark is never trusted from the caller.

A handle is single-use: successfully continuing a query consumes it. Unknown,
reconstructed/forged, edited, foreign-instance, changed-query/page-size/
projection/credential-scope and replayed handles are refused before any HTTP
request. Because no cursor payload is decoded or trusted, editing a bookmark
while retaining the other fields is not possible; the remaining FNV
fingerprints are grouping keys only, never authentication.

Issued and consumed state are both bounded (1,000 entries each by default).
When pending state is full, the oldest unused handle is retired and its later
use is refused as unknown rather than growing the registry without bound.
Applications that fan out and hold many unused cursors for a long time should
re-issue the query; this is an explicit in-memory, per-instance limitation, not
a persistent credential. `startAt`, `endAt`, `endBefore` and `offset` are
refused; only `startAfter` continues a native query. Cursor tokens are never
logged. Because a header-refreshed token changes the implicit credential scope,
long-lived pagination should pass a stable non-secret `cursorScope` (for example
a user/session identifier) or re-issue the query. The legacy `query` method uses
the same configured deadline without a caller signal; a deadline surfaces as
`QueryCancelledError` with reason `deadline`.

### Connection, index and field discovery

`NativeCouchDbDatabase` uses only the configured database endpoints:

| Method | Request | Result |
| --- | --- | --- |
| `testConnection(signal?)` | `GET /{db}` | Discriminated `{ ok: true, database }` or `{ ok: false, reason, httpStatus? }`. |
| `listIndexes(signal?)` | `GET /{db}/_index` | Available index definitions, or explicit `unavailable`/denied reason. |
| `sampleFields(signal?)` | bounded `GET /{db}/_all_docs?include_docs=true&limit=N` | Top-level fields labelled `sampled`, with `sampleSize` and conservative `truncated`. |
| `describe(signal?)` | the above | Resource, connection, indexes, field provenance and configured limits. |

If `configuredFields` is supplied, fields are labelled `configured` and no
sampling request is made. Metadata bodies are bounded by `maxMetadataBytes`
(default 256 KiB), discovery by `maxSampleDocuments` (default 20) and
`maxIndexes` (default 100), and requests by the same `timeoutMs`,
`maxRequestBytes` and `maxResponseBytes` transport. Missing, denied or malformed
metadata is never converted into a successful empty database.

## Managed-envelope surface

| DALgo operation | CouchDB mapping |
| --- | --- |
| `get` | `GET /{db}/{_id}`; 404 is a missing snapshot and `_rev` is metadata. |
| `getMany` | Bounded, ordered, bounded-parallel point reads. |
| `insert` | `PUT /{db}/{_id}`; 409 becomes `AlreadyExistsError`. |
| `set` | Read `_rev`, then conditional `PUT`; a race becomes `CouchDbConflictError`. |
| `delete` | Read `_rev`, then conditional `DELETE`; missing is idempotent. |
| `query` | Bounded direct-collection Mango `_find` selector with an adapter-bound bookmark cursor. |
| `queryWithSignal` | The same query with caller cancellation and one end-to-end deadline. |

Mango queries support only direct, unordered collections and simple top-level
fields with equality, inequality, comparison, `in`, or `not-in` filters.
`DOCUMENT_ID` is mapped to `__dalgo_id`. Mango index selection and result order
are CouchDB concerns; this adapter does not claim a portable ordered-query
contract. Create and monitor the appropriate Mango indexes yourself.

## Cancellation and capability admission

```ts
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { COUCHDB_READ_CAPABILITIES, CouchDbDatabase } from "@dal-go/dalgo2couchdb";
import { collection } from "@dalgo/core";

const capabilities = COUCHDB_READ_CAPABILITIES;
const built = collection<{ done: boolean }>("items").query().limit(25).build();
if (capabilities.query.sort.status === "unsupported" && built.orders.length > 0) {
  throw new Error("CouchDB does not support ordered DALgo queries");
}

const controller = new AbortController();
try {
  const page = await db.queryWithSignal(built, controller.signal);
  return page;
} catch (error) {
  if (error instanceof QueryCancelledError) {
    // error.reason is "caller" or "deadline"; no token or abort reason leaks.
    return undefined;
  }
  throw error;
}
```

The caller signal covers header acquisition, `fetch` and response-body reading.
The adapter combines it with the configured `timeoutMs` (15 seconds by default,
maximum 120) as one end-to-end deadline. A pre-aborted signal does no header or
HTTP work; a late response body is cancelled and a late result is never returned.
`queryWithSignal` rejects with `QueryCancelledError` for caller abort/deadline,
`CouchDbRequestError` for redacted header/fetch/body transport failures, and
preserves `UnsupportedError`, `RangeError` and configuration `TypeError` messages.
Legacy `query` keeps its interface and success behaviour.

### Capability rows

| Feature | Status | Bound / reason |
| --- | --- | --- |
| read/get, read/getMany | native | `getMany` max 100 keys, 8 parallel reads by default |
| projection | unsupported | full records only |
| filter | native | simple `data.*` fields or `DOCUMENT_ID`; operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in` |
| sort | unsupported | ordered DALgo queries are refused |
| pagination | native | `limit` plus an adapter-bound Mango bookmark cursor; no offset/other cursors |
| joins, aggregation, grouping, subquery, fulltext, timeseries | unsupported | refused before HTTP |
| native query | unsupported | no raw Mango escape hatch |
| discovery | unsupported | no schema/index discovery |
| bounds | enforced | `maxQueryLimit` 100/1000, request/response 1 MiB/16 MiB |

The exported managed constant is `COUCHDB_READ_CAPABILITIES`; `storage` is
`"managed-envelope"` and `bounds` contains the constructor default and hard
maximum for each numeric limit.

The native constant is `NATIVE_COUCHDB_READ_CAPABILITIES` (also available as
`db.capabilities` on `NativeCouchDbDatabase`):

| Feature | Status | Bound / reason |
| --- | --- | --- |
| read/get, read/getMany | native | native `_id`; `getMany` max 100 keys, 8 parallel reads, 1 MiB cumulative response budget by default |
| projection | native | optional Mango `fields`; `_id` is mandatory and preserved |
| filter | native | simple top-level fields plus `_id`/`_rev`; explicit-null vs present-non-null vs missing semantics |
| sort | configured | only a permitted index matching the full order plus `_id`; fallback disabled |
| pagination | native | stable limit plus an adapter-issued opaque single-use handle with a bounded stored query/bookmark binding |
| joins, aggregation, grouping, subquery, fulltext, timeseries | unsupported | refused before HTTP |
| native query | unsupported | no raw Mango selector/order escape hatch |
| discovery | native | `GET /{db}`, `GET /{db}/_index`, bounded `_all_docs`; no cluster `_all_dbs` |
| bounds | enforced | query 100/1000, request/response 1 MiB/16 MiB, getMany 1 MiB cumulative, metadata 256 KiB, sample 20, indexes 100 |

`describe().limits` reports the actual instance bounds, including
`maxGetManyBytes`, `maxIssuedCursors`, `maxConservedCursors`,
`maxMetadataBytes`, `maxSampleDocuments` and `maxIndexes`.

## Intentional limitations

- `update` is rejected in both modes. Turning a DALgo partial update into a
  read-modify-write would conceal an MVCC race.
- Callback transactions and `_bulk_docs` ACID claims are rejected. CouchDB has
  per-document MVCC, not the DALgo callback transaction/retry contract.
- The managed adapter refuses collection-group/nested queries, ordering,
  offsets, inclusive/end cursors, null/undefined filters, complex field paths,
  array filters and attachments.
- Native mode refuses all writes and offers no raw Mango selector, `$exists`,
  `$regex`, `$or`, array, full-text, join, grouping or aggregation escape hatch.
  It supports one configured collection per database instance and no nested
  keys. Ordering requires a matching index that ends in `_id`; Mango's
  same-direction rule is enforced.
- There is no BigInt or arbitrary-precision number representation. Integer
  values outside the safe-integer range are refused on request and response
  instead of being rounded; this includes integer-valued decimal/exponent
  tokens. Decimal/exponent values keep IEEE-754 semantics.
- Cursor handles and their validated bindings are in-memory and per instance.
  Issued and consumed state are bounded; the oldest unused pending handle is
  retired when the issued registry is full. There is no persistent cursor store
  and no browser-stored secret.
- `getMany` never returns a partial batch: the first failure aborts siblings and
  no later key is requested. `CouchDbBatchSizeError` means the cumulative
  response budget was exceeded, not that one document was too large (that is
  still `maxResponseBytes`).
- `NativeCouchDbDatabase.describe()` samples at most `maxSampleDocuments`
  documents to label top-level fields. Sampling is not a schema, completeness or
  authorization claim; pass `configuredFields` for a deliberate label.
- CouchDB's [`_changes` feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
  can provide a continuous or long-poll change stream, but DALgo currently has
  no realtime/change-feed contract. This adapter deliberately does not expose it.
- Defaults are a 15-second timeout, 1 MiB request/response limits, `getMany`
  maximum 100 keys, 8 parallel reads and a 1 MiB cumulative response budget,
  native metadata 256 KiB, field sample 20, index discovery 100, and Mango query
  maximum 100 (each configurable within hard caps). Oversized response streams
  are cancelled without waiting. HTTP error bodies are intentionally redacted;
  `CouchDbHttpError` exposes only the status, and native metadata failures expose
  a reason and optional HTTP status, never a response body.

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks of the minimal examples. Unit tests inject `fetch` and
in-memory streams; they cover managed regressions plus native reads/mapping,
native NULL/missing filters, projection, index-matched ordering, exact bounds,
raw-wire numeric refusal, one batch deadline across delayed headers/bodies,
cumulative getMany budgets, fail-fast sibling aborts and no later-key requests,
opaque cursor binding/tampering/forgery/foreign-instance/replay and bounded
cursor state, malformed docs and index payloads, metadata
denial/unavailability, read-only refusals, caller/deadline cancellation through
headers/fetch/body, and redaction. They do not contact a CouchDB server.

The gated [native-live.test.ts](test/native-live.test.ts) suite runs against a
disposable CouchDB when `COUCHDB_NATIVE_URL` (plus optional
`COUCHDB_NATIVE_USER`, `COUCHDB_NATIVE_PASSWORD`, `COUCHDB_NATIVE_INDEX_DDOC`,
`COUCHDB_NATIVE_INDEX_NAME`) is set; otherwise it is skipped. It verifies real
native documents, NULL/missing semantics, index-backed pagination, tampered and
foreign cursor handles, metadata discovery, bad auth, byte/batch bounds and
transport redaction with the actual platform `fetch`.

[scripts/browser-native-smoke.mjs](scripts/browser-native-smoke.mjs) bundles the
actual class and runs it in Chromium with real browser `fetch` against a
disposable CouchDB whose CORS allowlist names the exact page origin. It also
checks a repeated, tampered and forged cursor handle and a pre-aborted
`getManyWithSignal` batch. It is a package-level browser proof, run from a
workspace that provides Playwright and esbuild:

```sh
cd packages/sqlite-wasm
COUCHDB_NATIVE_URL=http://127.0.0.1:<db-port>/app \
COUCHDB_NATIVE_BROWSER_ORIGIN=http://127.0.0.1:<page-port>/ \
node ../couchdb/scripts/browser-native-smoke.mjs
```

`pnpm check:packed-consumer` additionally packs the published artifacts into a
fresh directory outside the repository, installs only those tarballs plus the
exact modern `@dalgo/core` commit, and type-checks and runs the packed
declarations with no `@dal-go/dalgo` package available, including the native
facade. A DataTug form/factory/query-session wiring and the whole DataTug UI
journey remain separate owner gates and are not claimed here. The real browser
proof above does not claim DataTug UI integration.

The package manifest, exports, `prepack`, `publishConfig` and changeset are ready
for the repository's Changesets pattern, but no npm publication or DataTug UI
integration is claimed. Remaining owner gates include adding this package to the
release workflow, npm bootstrap/trusted publishing, an `.changeset` version PR,
and a real application consumer installation.

## License

MIT

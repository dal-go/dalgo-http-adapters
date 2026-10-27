# DALgo adapter for Apache CouchDB

`@dal-go/dalgo2couchdb` is a deliberately bounded TypeScript adapter from
[`@dalgo/core`](https://github.com/dal-go/dalgo-js) to an existing Apache
CouchDB database using its document and [Mango query API](https://docs.couchdb.org/en/stable/api/database/find.html).
It does not call CouchDB administration, user, cluster, or configuration APIs.

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
journey, CORS policy, and the DataTug web UI are separate verification gates and
are not claimed by the package tests.

## Install

`@dalgo/core` and `@dalgo/adapter-runtime` are peers. This package is not yet
published to npm. First-wave consumers can pin the reviewed monorepo commit as a
pnpm subdirectory dependency, the same pattern used by `@dalgo/sqlite-wasm`:

```jsonc
// package.json
"@dalgo/core": "github:dal-go/dalgo-js#99165e9e1a39c32abee2b39d6395677843bc3559",
"@dalgo/adapter-runtime": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/adapter-runtime",
"@dal-go/dalgo2couchdb": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/couchdb"
```

```yaml
# pnpm-workspace.yaml: GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/99165e9e1a39c32abee2b39d6395677843bc3559': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/adapter-runtime': true
  '@dal-go/dalgo2couchdb@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/couchdb': true
```

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

This is the **managed-envelope** layout. Reading pre-existing application
documents without that envelope, and native Mango pass-through, are future work;
the capability constants below do not claim them.

## Supported DALgo surface

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

The exported constant is `COUCHDB_READ_CAPABILITIES`; `storage` is
`"managed-envelope"` and `bounds` contains the constructor default and hard
maximum for each numeric limit.

## Intentional limitations

- `update` is rejected. Turning a DALgo partial update into a read-modify-write
  would conceal an MVCC race.
- Callback transactions and `_bulk_docs` ACID claims are rejected. CouchDB has
  per-document MVCC, not the DALgo callback transaction/retry contract.
- Collection-group and nested-collection queries, ordering, offsets, inclusive
  or end cursors, null/undefined filters, complex field paths, array filters,
  attachments, and management APIs are not implemented.
- CouchDB's [`_changes` feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
  can provide a continuous or long-poll change stream, but DALgo currently has
  no realtime/change-feed contract. This adapter deliberately does not expose it.
- Defaults are a 15-second timeout, 1 MiB request/response limits, `getMany`
  maximum 100, 8 parallel reads, and Mango query maximum 100 (each configurable
  within hard caps). Oversized response streams are cancelled without waiting.
  HTTP error bodies are intentionally redacted; `CouchDbHttpError` exposes only
  the status.

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks of the minimal example. Tests inject `fetch` and
in-memory streams; they do not contact a CouchDB server and are not a live
CouchDB acceptance test. They cover caller abort before headers, while headers
are pending, in flight, and while the body is hanging, the deadline in the same
phases, late-response cleanup, no later page request, redaction of arbitrary
transport `RangeError`s while retaining adapter-owned bounds diagnostics,
oversized query-page rejection before decoding, and legacy query behaviour.
`pnpm check:packed-consumer` additionally packs the published artifacts into a
fresh directory outside the repository, installs only those tarballs plus the
exact modern `@dalgo/core` commit, and type-checks and runs the packed
declarations with no `@dal-go/dalgo` package available. A real CouchDB container
and the DataTug UI remain separate gates.

The package manifest, exports, `prepack`, `publishConfig` and changeset are ready
for the repository's Changesets pattern, but no npm publication or DataTug UI
integration is claimed. Remaining owner gates include adding this package to the
release workflow, npm bootstrap/trusted publishing, an `.changeset` version PR,
and a real application consumer installation.

## License

MIT

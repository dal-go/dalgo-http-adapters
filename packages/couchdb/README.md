# DALgo adapter for Apache CouchDB

`@dal-go/dalgo2couchdb` is a deliberately bounded TypeScript adapter from
[`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) to an existing Apache
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

## Install

This package is developed in the repository workspace and is not yet published
to npm. From the repository root, run `pnpm install --frozen-lockfile` and
`pnpm --filter @dal-go/dalgo2couchdb build`.

## Minimal setup

```ts
import { collection } from "@dal-go/dalgo";
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

## Supported DALgo surface

| DALgo operation | CouchDB mapping |
| --- | --- |
| `get` | `GET /{db}/{_id}`; 404 is a missing snapshot and `_rev` is metadata. |
| `getMany` | Bounded, ordered, bounded-parallel point reads. |
| `insert` | `PUT /{db}/{_id}`; 409 becomes `AlreadyExistsError`. |
| `set` | Read `_rev`, then conditional `PUT`; a race becomes `CouchDbConflictError`. |
| `delete` | Read `_rev`, then conditional `DELETE`; missing is idempotent. |
| `query` | Bounded direct-collection Mango `_find` selector with an adapter-bound bookmark cursor. |

Mango queries support only direct, unordered collections and simple top-level
fields with equality, inequality, comparison, `in`, or `not-in` filters.
`DOCUMENT_ID` is mapped to `__dalgo_id`. Mango index selection and result order
are CouchDB concerns; this adapter does not claim a portable ordered-query
contract. Create and monitor the appropriate Mango indexes yourself.

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
  within hard caps). Oversized response streams are cancelled. HTTP error bodies
  are intentionally redacted; `CouchDbHttpError` exposes only the status.

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks of the minimal example. Tests inject `fetch` and do not
contact a CouchDB server; they are not a live CouchDB acceptance test.

## License

MIT

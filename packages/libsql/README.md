# DALgo adapter for libSQL HTTP

`@dal-go/dalgo2libsql` reads and writes existing SQLite/libSQL tables through
the JSON Hrana **v3** `POST /v3/pipeline` protocol. It uses only `fetch` and
never creates a DALgo table, `__dalgo_*` envelope or hosted libSQL/Turso
resource.

The package has two explicit surfaces:

| Surface | Class | Storage | Writes |
| --- | --- | --- | --- |
| Configured managed tables | `LibSQLDatabase` | existing native tables, explicit projection | `insert`/`set`/`update`/`delete` only with `uniqueKey: true` |
| Read-only native facade | `NativeLibSQLDatabase` | existing native tables/views, explicit allowlist | every mutation entry point refuses before I/O |

Both surfaces implement the modern `@dalgo/core` `Database` identity and add the
shared cancellable `queryWithSignal` contract from `@dalgo/adapter-runtime`.

libSQL and Turso are related but distinct projects. This adapter implements the
published wire protocol, so it can target any compatible server at a
credential-free origin. The tests in this repository prove a **local,
commit-pinned `ghcr.io/tursodatabase/libsql-server` fixture only**. They are not
proof of hosted Turso provisioning, replicas, sync, tenancy, plans, CORS policy
or token issuance.

## Install

```sh
pnpm add @dalgo/core @dalgo/adapter-runtime github:dal-go/dalgo-http-adapters#<sha>&path:/packages/libsql
```

The package has not been published to npm yet. `prepack` builds
`@dalgo/adapter-runtime` from the same commit first, so a pnpm Git
subdirectory install works without a prebuilt workspace `dist`.

## Managed table mapping

```ts
import { collection } from "@dalgo/core";
import { LibSQLDatabase } from "@dal-go/dalgo2libsql";

const db = new LibSQLDatabase({
  serverUrl: "https://db.example.com",
  headers: () => ({ authorization: `Bearer ${shortLivedToken()}` }),
  tables: {
    items: {
      table: "items",
      uniqueKey: true, // caller-confirmed PRIMARY KEY/UNIQUE on keyColumn
      keyColumn: { column: "id", nullable: false },
      columns: {
        title: { column: "title", nullable: false },
        rank: { column: "rank", nullable: false },
      },
    },
  },
});

const items = collection<{ title: string; rank: number }, number>("items");
const page = await db.queryWithSignal(
  items.query().orderBy("rank").limit(25).build(),
  signal,
);
await db.set(items.key(7), { title: "Milk", rank: 10 });
```

Identifiers come only from this validated configuration and are quoted. Values
are Hrana positional bindings; no value is interpolated into SQL. A field name
is exactly the data property a caller sees. `__proto__` is refused as a
collection or field name before any I/O, because it cannot be stored as an own
object property; every other simple identifier keeps its exact spelling.

## Read-only native facade

```ts
import { NativeLibSQLDatabase } from "@dal-go/dalgo2libsql";

const db = new NativeLibSQLDatabase({
  serverUrl: "https://db.example.com",
  headers: () => ({ authorization: `Bearer ${shortLivedReaderToken()}` }),
  // A stable, non-secret user/tenant identity bound into cursors.
  identityScope: user.id,
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      key: { column: "id", type: "integer" },
      columns: {
        title: { column: "title", nullable: false },
        rank: { column: "rank", nullable: true },
      },
    },
    items_view: {
      table: "items_view",
      uniqueKey: true, // explicit contract: metadata cannot prove a view key
      key: { column: "id", type: "integer" },
      columns: { title: { column: "title", nullable: false } },
    },
  },
});

const items = collection<{ title: string; rank: number | null }, number>("items");
const description = await db.describe(); // read-only connection + metadata
const page = await db.queryWithSignal(items.query().orderBy("rank").limit(20).build(), signal);
```

- The allowlist is the only query surface. Every native entry must set
  `uniqueKey: true`: that is the caller's explicit one-row-per-key contract.
  Discovery reports whether metadata independently proves the key, but metadata
  never authorises a read or expands the allowlist.
- Discovery can *describe* an unlisted table, but it never makes it queryable and
  never grants any right.
- `get`/`getMany`/`query` return native rows. The configured key column becomes
  `Key.id` and `metadata.id`; the `data` object contains only the allowlisted
  non-key fields. There is no `data`/`__dalgo_*` envelope.
- String IDs stay strings, integer IDs stay safe numbers and REAL IDs stay
  finite numbers. A numeric string is never converted to a number and a text
  value is never accepted for an `integer`/`real` key. An integer outside
  JavaScript's safe range is refused rather than rounded.
- SQLite has no boolean storage class: a stored `0`/`1` is returned as a number,
  not silently turned into `false`/`true`.
- BLOB values, unsafe 64-bit integers and any non-scalar value are refused with
  an explicit error. They are never base64-coerced or passed through as a
  partial record.

## Keys, filters, sorting and paging

Supported filters are `==`, `!=`, `<`, `<=`, `>`, `>=` on allowlisted fields or
`DOCUMENT_ID`. `in`/`not-in`, array/membership operators, offsets, inclusive/end
cursors, projections, joins, aggregation and raw SQL/TugQL are explicitly
unsupported and fail before any request.

Ordered paging is a deterministic SQL keyset:

- the configured unique key is always the final tie-breaker;
- a `queryWithSignal`/native page without an explicit order uses that key as
  its honest deterministic order, so the issued cursor is always a usable
  continuation (the legacy `LibSQLDatabase.query()` keeps its documented
  open-position behaviour and returns no cursor for an unordered query);
- nullable order values are handled by the keyset predicate itself
  (`NULLS FIRST` for ascending SQLite order, `NULLS LAST` for descending), not
  silently coerced;
- no page can contain duplicate record keys; a duplicate is refused;
- every non-empty page carries a cursor, including a short page. Only an empty
  page ends a stream (sticky EOF). A server or proxy that quietly caps rows
  below the requested `LIMIT` therefore cannot truncate a consumer's stream.
- the semantic `limit` is the caller's. Safety limits (`maxQueryPages`,
  `maxRows`/`maxQueryLimit`, byte and key budgets) fail explicitly; they are
  never presented as end-of-data.

Two cursor families exist deliberately:

| Method | Cursor | Binding |
| --- | --- | --- |
| `LibSQLDatabase.query()` (legacy) | open position values (`[sortValue, key]`) | none, for compatibility |
| `LibSQLDatabase.queryWithSignal()` | opaque `nls1_…` single-use handle | endpoint, table, key, filters, order, page size, credential scope |
| `NativeLibSQLDatabase.query()`/`queryWithSignal()` | opaque `nls1_…` single-use handle | same, plus native key type |

An opaque handle is kept in adapter memory; the token carries no row values. It
is refused when malformed, foreign, replayed, used after a query/order/page-size
change, or replayed under another credential scope. If `identityScope` is set,
the scope is that stable value. Otherwise it is a digest of the headers actually
sent, so rotating a bearer token retires outstanding cursors. Set
`identityScope` for long-running browser sessions with rotating tokens.

`getMany` uses a bounded worker pool (`maxParallelReads`), never one unbounded
`Promise.all`, and fails the whole batch if cumulative decoded bytes exceed
`maxGetManyBytes`.

## Bounded schema discovery

`discover(signal?)` performs at most two bounded pipeline requests:

1. `pragma_table_list` for the primary schema, capped at `maxTables + 1` so a
   truncated inventory is explicit;
2. one `pragma_table_xinfo` plus one `pragma_index_list`/`pragma_index_info`
   statement per described table/view, capped by `maxMetadataStatements` and
   `maxMetadataBytes`.

It reports fields, declared type text, SQLite affinity, nullability, primary-key
position, the `hidden` flag, defaults, and a uniqueness proof:

- `declared-primary-key`: a single non-null primary key. The SQLite
  `INTEGER PRIMARY KEY` rowid alias is claimed only when SQLite itself created
  no `pk` index for it; `INTEGER PRIMARY KEY DESC`, WITHOUT ROWID keys and
  non-INTEGER keys never inherit that non-null rowid claim;
- `unique-index`: a complete, non-partial, single-column `UNIQUE` index on a
  non-null column;
- `configured-contract`: metadata has no usable single-column non-null key
  (common for views) but the caller explicitly sets `uniqueKey: true`;
- `not-unique`: composite or nullable-key declarations are reported as not
  queryable, never guessed into one ID;
- `unavailable`: a refused or truncated metadata statement.

`status: "unavailable"` (401/403, malformed, unsupported, oversized) is
deliberately different from `status: "available"` with `tableCount: 0` (an
actually empty database). Truncated table/field lists and omitted tables are
reported as truncated, never as an empty DB.

A field cap makes the uniqueness proof unavailable. A configured contract can
still make the table queryable, which is an explicit caller assertion, not a
metadata claim. An explicit table key type that contradicts the declared
affinity is reported as non-queryable and is also refused at query time.

## Budgets

Every operation has an end-to-end deadline and caller cancellation through
`createAbortScope`; the caller signal covers header resolution, fetch, response
body decoding, and batch/page work. The defaults are conservative and
configurable:

| Budget | Default |
| --- | --- |
| `timeoutMs` | 30 s |
| `maxRequestBytes` / `maxResponseBytes` | 1 MiB each |
| `maxGetManyKeys` / `maxParallelReads` | 100 / 8 |
| `maxGetManyBytes` | 1 MiB cumulative |
| `maxRows` (managed) / `maxQueryLimit` (native) | 1000 / 100 |
| `maxQueryPages` | 10 000 |
| `maxCursorBytes` (legacy values and opaque-cursor keyset positions) | 8 192 |
| `maxIssuedCursors` / `maxConservedCursors` | 1000 / 1000 |
| `maxMetadataTables` / `maxMetadataFieldsPerTable` | 100 / 256 |
| `maxMetadataStatements` / `maxMetadataBytes` | 512 / 1 MiB |

Unsafe integers, blobs, body sizes, row counts and cancelled work fail with
redacted errors. `redirect: "error"` is always set; an HTTP error exposes only
the status, and an in-band statement error exposes only a bounded machine code.
Headers are resolved per request and kept in memory only; no credential is
stored by the adapter or accepted in `serverUrl`, a query string, a cursor or an
error message.

## HTTPS and loopback

HTTPS is required. Plain HTTP is accepted only for `localhost`, `127.0.0.1` or
`[::1]` **and only with `allowInsecureLoopbackHttp: true`**, which exists for
disposable local tests. Credentials, paths, queries and fragments are refused in
`serverUrl`.

## Browser use and the local/hosted distinction

The adapter is browser-safe (no Node built-ins, no SDK), but browser deployment
is still a security decision. The adapter sends only header-provided
credentials. Use a narrow, short-lived reader token from a broker; never ship an
admin, long-lived write, service-role or customer-managed encryption key.

The pinned local fixture's own source (`libsql-server` at
`d6c75af6353bb1c34985399608e37cd272a35aa1`, `http/user/mod.rs`) configures
`cors::Any` for origin, methods and headers. The real Chromium suite therefore
proves an actual cross-origin fetch with an actual `Authorization` header; it
does **not** assert an exact-origin libSQL policy, because the pinned server does
not implement one. A reverse proxy that rejects an origin is proxy policy, not
libSQL policy. Hosted Turso CORS, token issuance, quotas and tenancy are outside
this package and are not tested here.

The fixture generates an ephemeral Ed25519 key pair, passes the public key via
`SQLD_AUTH_JWT_KEY_FILE`, and uses `{"a":"ro","exp":…}` for the reader. The
pinned validation leaves an omitted `a` as **write**, so the fixture always
states the permission explicitly and uses a separate `a: "rw"` token only for
external seeding. A real reader write probe is asserted to fail with HTTP 403,
separately from the native facade's own no-I/O mutation refusal.

## Verification

- `pnpm --filter @dal-go/dalgo2libsql check`: lint, unit tests, production build
  and strict example/typecheck. No network or Docker.
- `pnpm --filter @dal-go/dalgo2libsql test:real`: builds the workspace
  dependency outputs first (so it works from a clean checkout), then starts its
  own commit-pinned libSQL container on a random loopback port with ephemeral
  keys, seeds via the writer token, proves the reader write probe is 403, runs
  the adapter against real Hrana, and removes **and verifies** its own container
  plus the exact anonymous data volumes recorded from that container before
  deletion. A remaining owned resource fails the suite.
- `pnpm --filter @dal-go/dalgo2libsql test:browser`: the same fixture plus a
  real static page in Chromium. The page bundles the adapter, uses the browser's
  own `fetch`, and reads across a genuinely different origin. No libSQL response
  is routed, mocked or replaced, and no manual `Origin` header is used as proof.
- The repository's packed and source-only Git-subdirectory consumer gates also
  install this package, typecheck its modern public imports, assert one
  `@dalgo/core` identity and reject a legacy `@dal-go/dalgo` dependency.

The real fixture pins
`ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67`
(ARM64 manifest `sha256:f5fef78e7e927dcad04da5a95cd07b589c1bc6ef174ece71f02582cfbcbbe2a0`).
It is commit-pinned libSQL server 0.24.33, not the latest stable release tag and
not hosted Turso.

## Intentional limits

- No raw SQL, arbitrary Hrana batches/batons, SQL/TugQL escape hatch, session
  state, subscription, join, grouping, aggregation, full-text or timeseries
  execution.
- No offsets, inclusive/end cursors, membership/array filters, projections
  outside the explicit mapping, nested or collection-group queries.
- No BLOB, JSON-object or unsafe 64-bit integer values.
- `runReadwriteTransaction` is unsupported: every operation closes its pipeline,
  and serialized baton affinity, rollback and replay semantics are not proven.
- A nullable order column is paginated honestly; a nullable **key** is not
  invented into a unique ID. Use an explicit `uniqueKey: true` contract only
  when the caller has independently established uniqueness.

## Official protocol references

- [libSQL Hrana over HTTP v3 specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md)
- [Turso SQL over HTTP protocol, v3](https://github.com/tursodatabase/turso/blob/main/serverless/PROTOCOL.md)
- [libSQL project distinction from Turso Database](https://github.com/tursodatabase/libsql)

## License

MIT

# DALgo adapter for PostgREST

`@dalgo/dalgo2postgrest` is a deliberately bounded, dependency-free TypeScript
adapter from [`@dalgo/core`](https://github.com/dal-go/dalgo-js) to exposed
PostgREST tables or updatable views. It uses the platform `fetch` API only. It
does not call PostgreSQL directly, an administration endpoint, RPC, or resource
embedding. A read-only discovery surface uses the OpenAPI document PostgREST
already serves for the request role.

## Security and browser boundary

Pass an HTTPS `baseUrl` without credentials and a `headers` provider. HTTPS is
the default and the only option for a hosted origin. Plain HTTP is accepted
only for `localhost`, `127.0.0.1` or `[::1]`, and only with the explicit
`allowInsecureLoopbackHttp: true` development option.

The header provider runs for every HTTP request, allowing the application to
obtain a fresh, narrowly scoped Bearer token or cookie from its own
authenticated token broker. The adapter neither retains nor logs those values.
Never put database credentials or access tokens in a URL, source control,
analytics, browser storage, or an error report. Do not install a service-role
or other administration key in a browser.

Supabase is PostgREST. A browser example uses its publishable/anon `apikey`
plus a **least-privilege user bearer** from the application's own token broker:

```ts
const db = new PostgrestDatabase({
  baseUrl: "https://project.supabase.co/rest/v1",
  headers: async () => ({
    apikey: publicAnonKey, // publishable key, not a service-role key
    authorization: `Bearer ${await getFreshUserAccessToken()}`,
  }),
});
```

PostgREST authenticates the JWT and performs authorization in the database.
Configure token audience, role grants, row-level security, CORS
origin/method/header allowlists, cookie policy, and proxy boundaries for the
deployment. Direct browser access is an application decision; this package
cannot make an overly broad CORS policy or a token with the wrong audience safe.
The package source is browser-safe and imports no Node built-in.

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
"@dalgo/dalgo2postgrest": "github:dal-go/dalgo-http-adapters#<merged-sha>&path:/packages/postgrest"
```

```yaml
# pnpm-workspace.yaml: pnpm blocks build scripts until each exact package is approved
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/99165e9e1a39c32abee2b39d6395677843bc3559': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/adapter-runtime': true
  '@dalgo/dalgo2postgrest@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/postgrest': true
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
`pnpm --filter @dalgo/dalgo2postgrest check` run the workspace gate.

## Minimal setup

```ts
import { collection } from "@dalgo/core";
import { PostgrestDatabase } from "@dalgo/dalgo2postgrest";

const db = new PostgrestDatabase({
  baseUrl: "https://api.example.com/rest/v1",
  headers: async () => ({ authorization: `Bearer ${await getFreshPostgrestToken()}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
```

The type-checked version is [examples/basic.ts](examples/basic.ts). This maps
the top-level DALgo collection `items` to the exposed `items` relation and its
DALgo key ID to the relation's `id` column. Use `relationName` and `idColumn`
when the schema uses different names. The relation must have a primary key or
unique constraint suitable for PostgREST upsert, and the supplied identity must
have only the needed database permissions.

Use `schema` (or its `profile` alias) to select a PostgREST profile explicitly.
The adapter sends `Accept-Profile` on reads and `Content-Profile` on writes.
Profile selection never changes the configured `idColumn` or `relationName`
mapping, and no profile is guessed from OpenAPI metadata.

## Discovery and connection preflight

`discover()` reads the root OpenAPI document with the same refreshed headers and
caller cancellation as every other request. It returns only what the document
actually declares, bounded by relation count, fields per relation, document
bytes and local `$ref` depth. Remote `$ref` documents are never fetched.

```ts
import { POSTGREST_READ_CAPABILITIES, PostgrestDatabase } from "@dalgo/dalgo2postgrest";

const db = new PostgrestDatabase({ baseUrl, headers });
const status = await db.testConnection(controller.signal);

if (status.ok) {
  const discovery = await db.discover(controller.signal);
  for (const relation of discovery.relations) {
    console.log(relation.name, relation.fields, relation.primaryKey, relation.adapterQueryable);
  }
}

const discoveryCapability = POSTGREST_READ_CAPABILITIES.query.discovery;
```

`discover()` never returns an empty relation list as if it were proof of an
empty database. A denied identity, a disabled/missing OpenAPI endpoint, a
malformed document, and a role with no visible relations are reported as
`status: "unavailable"` with an explicit `reason` (`unauthorized`, `forbidden`,
`metadata-disabled`, `metadata-malformed`, `request-failed`, or
`no-relations`). `testConnection()` maps that to a UI-safe status and does not
echo a response body, header, token, or transport error.

Field types, formats, array item types, enums and primary-key markers appear
only where the OpenAPI document declares them. A field whose type is expressed
by an unresolvable/remote `$ref` is marked `typeStatus: "unavailable"`. The
configured `idColumn` is shown per relation as `idColumn`, and
`adapterQueryable` says whether this adapter can address the relation with the
configured mapping. This is read-only discovery, not an administration API.

Primary-key markers are collected from the complete declared property set, not
from the bounded `fields` list, so a truncated field projection cannot turn a
composite key into a false single-column key. `idColumn.uniqueStatus` separates
three cases: `declared-primary-key` (the complete declared key is exactly that
one column), `configured-contract` (the role's metadata declares no key, so the
adapter relies on the caller's configured uniqueness contract), and
`not-unique` (a different or composite key is declared, so the configured
column alone cannot address one row, a stable keyset boundary, or a per-row
write). `adapterQueryable` is `false` for `not-unique`; `readable` is separate
provider authorization and never proves uniqueness or pagination stability.

## Supported DALgo surface

| DALgo operation | PostgREST mapping |
| --- | --- |
| `get` | Bounded `GET /relation?id=eq.value&limit=1`; an empty result is a missing snapshot. |
| `getMany` | Ordered, bounded, bounded-parallel point reads. |
| `insert` | `POST /relation` with an adapter-owned ID column; HTTP 409 becomes `AlreadyExistsError`. |
| `set` | Single-row `PUT /relation?id=eq.value` with the complete payload; exactly one returned row is required. |
| `update` | `PATCH /relation?id=eq.value` with strict `max-affected=1`; an empty returned representation becomes `NotFoundError`. |
| `delete` | `DELETE /relation?id=eq.value` with strict `max-affected=1`; an empty returned representation is an idempotent missing delete. |
| `query` | Legacy direct top-level relation `GET` with PostgREST filters, ordering, bounded `limit`, and `offset`; DALgo cursors are still refused. |
| `queryWithSignal` | The same query with caller cancellation, one end-to-end deadline, and optional opaque keyset cursor continuation. |

The adapter-owned ID column is removed before codec decoding. Consequently,
codec-encoded record data must not contain that column. Query records construct
top-level DALgo keys from its value. This is the **native-rows** storage mode:
the adapter reads existing relations and never rewrites them into a DALgo
envelope. Numeric, `null`, boolean and string values remain as PostgREST
returned them; no projection is silently applied.

## Cursor pagination

`queryWithSignal()` returns `nextCursor` for every non-empty page, including a
page shorter than the requested limit. A short page is not proof of
end-of-data: PostgREST's `db-max-rows` (or a proxy) can cap every response below
the requested `limit`. Pass the token back as `startAfter(...)` until a request
returns an empty page. The cursor is opaque base64url and binds:
endpoint, DALgo collection and exposed relation, configured profile and
`idColumn`, filters, effective order, `select=*`, page size, and an optional
non-secret `identityScope`. A cursor from another endpoint, relation, query,
order, page size or identity scope is rejected with `PostgrestCursorError`
(which is also an `UnsupportedError`) before HTTP.

```ts
const pageSize = 25; // adapter page, not a semantic total
let cursor: string | undefined;
do {
  const builder = items.query().where("done", "==", false).orderBy("priority").limit(pageSize);
  const page = await db.queryWithSignal(
    cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
    controller.signal,
  );
  render(page.records);
  cursor = page.nextCursor?.values[0] as string | undefined;
} while (cursor !== undefined);
```

The effective order always ends in the configured primary key, so a stable page
has a deterministic tie-breaker even when the user order is not unique. The
adapter uses keyset continuation (`or=(...)`), not a full scan and not
`Prefer: count=exact`. Every non-empty page, short or full, may advertise a
possible next page; the follow-up request that finds no rows ends pagination
honestly with `{ records: [] }` and no cursor. A consumer that needs a bounded
total stops after its own budget or the empty page.

Legacy `query()` keeps its one-request `limit`/`offset` contract and never
returns a cursor; a short legacy page is returned as-is.

Two limits are intentionally different:

- **Adapter page limit**: `maxQueryLimit` (default 100, hard maximum 1,000) is
  the largest number of rows in one provider request/page.
- **DataTug logical total/query limit**: a consumer/UI concern. The adapter does
  not compute, cache, infer or guarantee a semantic total. Use explicit
  continuation until the empty page, or the consumer's own bounded total.

Offsets remain available for both legacy `query()` and `queryWithSignal()` and
are bounded by `maxQueryOffset`. Cursor and offset cannot be combined. Cursor
pages are bounded by `maxQueryPages`; a cursor that exceeds that bound is
refused explicitly rather than silently restarting. Cursor metadata is bounded
by `maxCursorBytes`.

## Cancellation and capability admission

```ts
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { POSTGREST_READ_CAPABILITIES, PostgrestDatabase } from "@dalgo/dalgo2postgrest";
import { collection } from "@dalgo/core";

const capabilities = POSTGREST_READ_CAPABILITIES;
const built = collection<{ done: boolean }>("items").query().orderBy("done").limit(25).build();
if (capabilities.query.sort.status === "unsupported" && built.orders.length > 0) {
  throw new Error("PostgREST does not support ordering");
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

The caller signal covers header acquisition, `fetch`, response-body reading and
cursor preparation. The adapter combines it with the configured `timeoutMs`
(15 seconds by default, maximum 120) as one end-to-end deadline. A pre-aborted
signal does no header or HTTP work; a late response body is cancelled and a late
result is never returned. `queryWithSignal` rejects with `QueryCancelledError`
for caller abort/deadline and with the existing redacted
`PostgrestRequestError` for header/fetch/body transport failures. Deliberate
query/unsupported errors are raised before any request and keep their messages.
Legacy `query` keeps its interface and success behaviour.

### Capability rows

| Feature | Status | Bound / reason |
| --- | --- | --- |
| read/get, read/getMany | native | `getMany` max 100 keys, 8 parallel reads by default |
| projection | unsupported | core `StructuredQuery` has no projection; `select=*` is always used and no field is dropped |
| filter | native | simple column identifiers or `DOCUMENT_ID`; all DALgo operators; null only for `==`/`!=` |
| sort | native | `asc`/`desc` on simple column identifiers; `queryWithSignal` adds the primary-key tie-breaker |
| pagination | native | bounded `limit`/`offset`; opaque keyset cursor in `queryWithSignal`; legacy `query` refuses cursors |
| joins, aggregation, grouping, subquery, fulltext, timeseries | unsupported | refused before HTTP |
| native query | unsupported | no raw PostgREST parameters, embedding or RPC |
| discovery | native | read-only bounded OpenAPI; role visibility and denied/disabled metadata are explicit |
| bounds | enforced | query limit 100/1000, offset 100k/10M, pages 10k/1M, cursor 8KiB/64KiB, request/response 1 MiB/16 MiB, discovery 512KiB/16MiB, 100/10k relations, 200/10k fields, depth 4/16 |

The exported constant is `POSTGREST_READ_CAPABILITIES`; `storage` is
`"native-rows"` and `bounds` contains the constructor default and hard maximum
for each numeric limit, including the PostgREST-specific discovery and cursor
bounds.

## Intentional limitations

- DALgo callback transactions are rejected. PostgREST executes each HTTP
  request in its own database transaction, so this package cannot honestly
  provide an atomic, retryable callback across requests.
- Nested DALgo keys, nested-collection queries, and collection-group queries
  are rejected. A relation is one top-level DALgo collection, not a hierarchy.
- Projection cannot be expressed through the current core `StructuredQuery`;
  the adapter does not pretend it is supported. Discovery exposes field
  metadata, while row reads always select `*`.
- Supported filters are equality/inequality, comparisons, `in`, `not-in`, and
  PostgreSQL-array containment/overlap; relation and field names are limited to
  simple SQL identifiers. No resource embedding, JSON paths, full-text search,
  aggregates, RPC, or server management API is exposed. A string used with a
  single-value operator (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`) is sent raw,
  because PostgREST compares that operand literally and would include the
  double quotes otherwise. Strings in a membership list (`in`, `not-in`) or an
  array literal (`cs`, `ov`) are quoted and escaped, which is the documented
  reserved-character context.
- Reserved PostgREST control parameters (`select`, `columns`, `on_conflict`,
  `order`, `limit`, `offset`, `and`, `or`) are quoted when they are used as
  filter keys, order fields, or the configured `idColumn`, using PostgREST's
  documented identifier quoting. Appending them unquoted would let PostgREST
  consume the predicate as its own control and silently drop it. Names that
  merely resemble a control (`order_id`, `limiters`, `ordinary`) stay unquoted
  and keep working.
- JSON numbers are checked against the raw response text before `JSON.parse`.
  A number literal is accepted only when the decimal value it denotes is the
  exact decimal value the adapter would serialize back. A high-precision
  decimal such as `0.10000000000000001`, an exponent token that underflows to
  zero (`1e-400`) or overflows to a non-finite value (`1e400`), `-0`, and any
  integer (including an integer-valued decimal or exponent) outside the
  lossless JavaScript safe range are refused with a redacted error before any
  record or cursor is emitted. Canonical decimals such as `0.1`,
  `0.30000000000000004` or `1.0`/`1e0` remain supported because their
  serialized literal preserves the same decimal value. Outgoing filter,
  record and cursor values are checked the same way. This prevents an ID such
  as `9007199254740993` from becoming `9007199254740992`, and a keyset boundary
  such as `0.10000000000000001` from being sent as `0.1`, which could repeat
  the same actual numeric row.
- `set` is full replacement, not merge-upsert: the supplied DALgo value is the
  complete replacement record (apart from the adapter-owned ID). Fields omitted
  from it are not sent for merge. PostgREST must expose a relation for which its
  documented single-row `PUT` semantics are available.
- `update` and `delete` ask PostgREST for `handling=strict, max-affected=1`
  and verify returned cardinality. `set` verifies one returned `PUT` row;
  PostgREST documents `max-affected` for PATCH and DELETE, not PUT.
- PostgREST errors may contain database details and row values. Response bodies
  are cancelled and discarded for non-2xx replies; `PostgrestHttpError` exposes
  only the HTTP status. Header-provider, fetch, redirect, timeout, body-stream,
  and JSON failures become a generic `PostgrestRequestError`, never their
  original text. Inserts request `return=minimal` and cancel any unexpected
  response body; keyed writes read a bounded representation to prove their
  cardinality. Cancellation is best-effort and never awaited, so a hostile or
  broken stream cannot outlive the request deadline.
- Cursor pagination assumes the configured primary-key column is non-null and
  unique. Discovery reports whether that is declared (`declared-primary-key`)
  or relies on the configured contract (`configured-contract`). When metadata
  declares a different or composite key, `uniqueStatus` is `not-unique` and
  `adapterQueryable` is false: the adapter does not promise a unique key or
  stable cursor boundary. A relation without a declared key can still be read
  by key and offset, but that is the caller's uniqueness contract.
- Discovery reflects the OpenAPI document for the current role at the time of
  the request. It can lag a schema-cache reload, and it is not a grant of read
  access to every advertised relation.

## Official PostgREST references

- [Tables and Views](https://docs.postgrest.org/en/stable/references/api/tables_views.html)
- [Pagination and Count](https://docs.postgrest.org/en/stable/references/api/pagination_count.html)
- [OpenAPI](https://docs.postgrest.org/en/stable/references/api/openapi.html)
- [Prefer Header](https://docs.postgrest.org/en/stable/references/api/preferences.html)
- [Schemas](https://docs.postgrest.org/en/stable/references/api/schemas.html)
- [Authentication](https://docs.postgrest.org/en/stable/references/auth.html)
- [Errors](https://docs.postgrest.org/en/stable/references/errors.html)

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks of the minimal example. The unit suite injects `fetch`
for protocol/error/bound coverage. `test/node-http-transport.test.ts` is a Node
HTTP contract test only: Node does not enforce browser CORS and the test sets
`Origin` manually, so it does not prove browser behaviour.

`pnpm test:browser` owns a second disposable Compose project named
`datatug-postgrest-ts-r2-<run>` and a unique loopback static origin. It first
builds the workspace dependency outputs (`@dalgo/adapter-runtime` among them),
so it works from a clean source checkout, then builds the fixture page with
esbuild, launches real headless Chromium through Playwright, and has the
browser bundle use the real `PostgrestDatabase` and
global `fetch` against that real PostgREST service. The service allows exactly
the static page origin. The suite proves successful discovery, native rows and
multi-page continuation across server-capped short pages, a redacted bad
credential, an actual browser CORS refusal from a different origin, and caller
abort. It does not intercept any PostgREST response. It removes only its own
Compose project and fixture directory.

`pnpm test:real` owns one disposable Docker Compose project named
`datatug-postgrest-ts-<run>`, uses cached `postgrest/postgrest:v16.5` and
`postgres:17` images, random loopback host ports, a synthetic JWT role, a
read-only role, native seeded rows, `db-max-rows=2` below the requested page
size, and exact-origin CORS. It runs the real PostgREST discovery, short-page
cursor journey, changed/foreign cursor, bad-auth, read-only denial, no-relations
and controlled-header tests, then removes only its own project and temporary
files. Neither real-service suite proves a hosted Supabase deployment, its RLS
policies, a gateway, or DataTug's actual connection form and UI journey; those
remain separate acceptance gates for the owning application.

`pnpm check:packed-consumer` (repository root) additionally packs the published
artifacts into a fresh directory outside the repository, installs only those
tarballs plus the exact modern `@dalgo/core` commit, and type-checks and runs the
packed declarations with no `@dal-go/dalgo` package available.

## License

MIT

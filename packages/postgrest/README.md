# DALgo adapter for PostgREST

`@dal-go/dalgo2postgrest` is a deliberately bounded, dependency-free TypeScript
adapter from [`@dalgo/core`](https://github.com/dal-go/dalgo-js) to exposed
PostgREST tables or updatable views. It uses the platform `fetch` API only and
does not call PostgreSQL, PostgREST administration, OpenAPI, or RPC endpoints.

## Security and browser boundary

Pass an HTTPS `baseUrl` without credentials and a `headers` provider. The
provider runs for every HTTP request, allowing the application to obtain a
fresh, narrowly scoped Bearer token or cookie from its own authenticated token
broker. The adapter neither retains nor logs those values. Never put database
credentials or access tokens in a URL, source control, analytics, browser
storage, or an error report.

PostgREST authenticates a JWT supplied as `Authorization: Bearer <jwt>` and
performs authorization in the database. Configure token audience, role grants,
row-level security, CORS origin/method/header allowlists, cookie policy, and
proxy boundaries for the deployment. Direct browser access is an application
decision; this package cannot make an overly broad CORS policy or a token with
the wrong audience safe.

The package source is browser-safe and imports no Node built-in. A real browser
journey, deployed PostgREST CORS policy and the DataTug web UI are separate
verification gates and are not claimed by the package tests.

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
"@dal-go/dalgo2postgrest": "github:dal-go/dalgo-http-adapters#<merged-sha>&path:/packages/postgrest"
```

```yaml
# pnpm-workspace.yaml: pnpm blocks build scripts until each exact package is approved
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/99165e9e1a39c32abee2b39d6395677843bc3559': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/adapter-runtime': true
  '@dal-go/dalgo2postgrest@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<merged-sha>#path:/packages/postgrest': true
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
`pnpm --filter @dal-go/dalgo2postgrest check` run the workspace gate.

## Minimal setup

```ts
import { collection } from "@dalgo/core";
import { PostgrestDatabase } from "@dal-go/dalgo2postgrest";

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

## Supported DALgo surface

| DALgo operation | PostgREST mapping |
| --- | --- |
| `get` | Bounded `GET /relation?id=eq.value&limit=1`; an empty result is a missing snapshot. |
| `getMany` | Ordered, bounded, bounded-parallel point reads. |
| `insert` | `POST /relation` with an adapter-owned ID column; HTTP 409 becomes `AlreadyExistsError`. |
| `set` | Single-row `PUT /relation?id=eq.value` with the complete payload; exactly one returned row is required. |
| `update` | `PATCH /relation?id=eq.value` with strict `max-affected=1`; an empty returned representation becomes `NotFoundError`. |
| `delete` | `DELETE /relation?id=eq.value` with strict `max-affected=1`; an empty returned representation is an idempotent missing delete. |
| `query` | Direct top-level relation `GET` with PostgREST filters, ordering, bounded `limit`, and `offset`. |
| `queryWithSignal` | The same query with caller cancellation and one end-to-end deadline. |

The adapter-owned ID column is removed before codec decoding. Consequently,
codec-encoded record data must not contain that column. Query records construct
top-level DALgo keys from its value. This is the **native-rows** storage mode:
the adapter reads existing relations and never rewrites them into a DALgo
envelope.

## Cancellation and capability admission

```ts
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { POSTGREST_READ_CAPABILITIES, PostgrestDatabase } from "@dal-go/dalgo2postgrest";
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

The caller signal covers header acquisition, `fetch` and response-body reading.
The adapter combines it with the configured `timeoutMs` (15 seconds by default,
maximum 120) as one end-to-end deadline. A pre-aborted signal does no header or
HTTP work; a late response body is cancelled and a late result is never returned.
`queryWithSignal` rejects with `QueryCancelledError` for caller abort/deadline and
with the existing redacted `PostgrestRequestError` for header/fetch/body
transport failures. Deliberate query/unsupported errors are raised before any
request and keep their messages. Legacy `query` keeps its interface and success
behaviour.

### Capability rows

| Feature | Status | Bound / reason |
| --- | --- | --- |
| read/get, read/getMany | native | `getMany` max 100 keys, 8 parallel reads by default |
| projection | unsupported | `select=*` only |
| filter | native | simple column identifiers or `DOCUMENT_ID`; all DALgo operators; null only for `==`/`!=` |
| sort | native | `asc`/`desc` on simple column identifiers |
| pagination | native | `limit` and `offset`; DALgo query cursors are refused |
| joins, aggregation, grouping, subquery, fulltext, timeseries | unsupported | refused before HTTP |
| native query | unsupported | no raw PostgREST query parameters |
| discovery | unsupported | no OpenAPI/schema/relation discovery |
| bounds | enforced | `maxQueryLimit` 100/1000, request/response 1 MiB/16 MiB |

The exported constant is `POSTGREST_READ_CAPABILITIES`; `storage` is
`"native-rows"` and `bounds` contains the constructor default and hard maximum
for each numeric limit.

## Intentional limitations

- DALgo callback transactions are rejected. PostgREST executes each HTTP
  request in its own database transaction, so this package cannot honestly
  provide an atomic, retryable callback across requests.
- Nested DALgo keys, nested-collection queries, and collection-group queries
  are rejected. A relation is one top-level DALgo collection, not a hierarchy.
- DALgo query cursors are rejected; use explicit, bounded offset pagination or
  model keyset filtering in a PostgREST-specific repository layer. `limit`
  defaults to the configurable maximum of 100 and cannot exceed it.
- Supported filters are equality/inequality, comparisons, `in`, `not-in`, and
  PostgreSQL-array containment/overlap; relation and field names are limited to
  simple SQL identifiers. No resource embedding, JSON paths, full-text search,
  aggregates, RPC, or server management API is exposed.
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
  broken stream cannot outlive the request deadline. JSON request/response bodies are limited to 1 MiB by
  default, `getMany` to 100 keys and 8 concurrent requests, queries to 100
  rows, and one end-to-end request deadline of 15 seconds (all configurable within hard caps).
- The HTTP-contract tests inject `fetch`; they do not exercise a live
  PostgREST server, deployed CORS policy, JWT verifier, row-level security,
  table/view privileges, or schema cache.

## Official PostgREST references

- [Tables and Views](https://docs.postgrest.org/en/stable/references/api/tables_views.html)
- [Pagination and Count](https://docs.postgrest.org/en/stable/references/api/pagination_count.html)
- [Prefer Header](https://docs.postgrest.org/en/stable/references/api/preferences.html)
- [Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)
- [Authentication](https://docs.postgrest.org/en/stable/references/auth.html)
- [Errors](https://docs.postgrest.org/en/stable/references/errors.html)

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks of the minimal example. Tests inject `fetch` and
in-memory streams; no network PostgREST instance is contacted. They cover caller
abort before headers, while headers are pending, in flight, and while the body is
hanging, the deadline in the same phases, late-response cleanup, no later page
request, redaction, bounds, oversized query-page rejection before decoding, and
legacy query behaviour. `pnpm check:packed-consumer` additionally packs the
published artifacts into a fresh directory outside the repository, installs
only those tarballs plus the exact modern `@dalgo/core` commit, and type-checks
and runs the packed declarations with no `@dal-go/dalgo` package available. A
real PostgREST instance, CORS/RLS configuration and the DataTug UI remain
separate gates.

The package manifest, exports, `prepack`, `publishConfig` and changeset are ready
for the repository's Changesets pattern, but no npm publication or DataTug UI
integration is claimed. Remaining owner gates include adding this package to the
release workflow, npm bootstrap/trusted publishing, an `.changeset` version PR,
and a real application consumer installation.

## License

MIT

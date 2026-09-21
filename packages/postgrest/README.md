# DALgo adapter for PostgREST

`@dal-go/dalgo2postgrest` is a deliberately bounded, dependency-free TypeScript
adapter from [`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) to exposed
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

## Install

This package is developed in this workspace and is not yet published to npm.
From the repository root, run `pnpm install --frozen-lockfile` and
`pnpm --filter @dal-go/dalgo2postgrest build`.

## Minimal setup

```ts
import { collection } from "@dal-go/dalgo";
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

The adapter-owned ID column is removed before codec decoding. Consequently,
codec-encoded record data must not contain that column. Query records construct
top-level DALgo keys from its value.

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
  cardinality. JSON request/response bodies are limited to 1 MiB by
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
build, and type checks of the minimal example. No network PostgREST instance is
contacted.

## License

MIT

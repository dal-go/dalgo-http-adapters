# DALgo adapter for Google Cloud Datastore

`@dal-go/dalgo2datastore` is a bounded, dependency-free TypeScript adapter for
the Google Cloud Datastore v1 REST data plane, including Firestore in Datastore
mode. It calls `lookup`, `commit`, and `runQuery` through platform `fetch`; it
does not use the administration API, a service-account key, or a vendor SDK.

## Browser security boundary

This is **HTTP-capable**, not browser-ready by default. Google accepts OAuth 2
access tokens for the Datastore scope, but browser use requires an intentional
OAuth design, enabled CORS for the deployed path, and least-privilege IAM.
Pass an `accessToken` function which obtains a short-lived, audience-appropriate
token from your authenticated backend/token broker for every request. The
adapter does not retain or log tokens.

Do not put service-account JSON, private keys, long-lived user tokens, or
database credentials in browser code, URLs, storage, source control, analytics,
or error reports. A service account is a server-only credential. A token broker
must authenticate the user, authorize the requested Datastore access, scope and
expire the token, and enforce CORS/origin policy; this package cannot make an
over-broad IAM grant or CORS rule safe.

## Install and setup

The package is developed in this workspace and is not yet published to npm.

```ts
import { collection } from "@dal-go/dalgo";
import { DatastoreDatabase } from "@dal-go/dalgo2datastore";

const db = new DatastoreDatabase({
  projectId: "my-project",
  namespaceId: "tenant-a", // optional
  accessToken: async () => getFreshDatastoreAccessToken(),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
```

The type-checked version is [examples/basic.ts](examples/basic.ts). A DALgo
collection maps to a Datastore kind, and a DALgo key maps to a complete Datastore
key path: parent DALgo keys become ancestor path elements. String IDs map to
Datastore `name`; positive safe-integer IDs map to `id`. The configured project,
database (default `(default)`), and namespace apply to every operation.

## Supported DALgo surface

| DALgo operation | Datastore mapping |
| --- | --- |
| `get` / `getMany` | One bounded `projects:lookup`; results are reordered to the requested key order. |
| `insert` | Non-transactional `commit` with an `insert` mutation; HTTP 409 becomes `AlreadyExistsError`. |
| `set` | Non-transactional `commit` with a full-entity `upsert` mutation. |
| `update` | Non-transactional `commit` with a full-entity `update` mutation; HTTP 404 becomes `NotFoundError`. |
| `delete` | Non-transactional `commit` with a delete mutation. |
| `query` | `runQuery` for one kind, bounded filters/orders/offset, and adapter-generated `startAfter` cursor pagination. |

Record data must codec-encode to plain JSON objects. JSON strings, booleans,
nulls, finite numbers, arrays, and objects map recursively to Datastore values.
Safe integer numbers use `integerValue`; other finite numbers use `doubleValue`.
On reads, integer values outside the JavaScript safe-integer range are rejected
instead of silently losing precision. Datastore timestamp, blob, GeoPoint, key,
meaning, and exclude-from-indexes values are intentionally not represented by
this generic JSON mapping.

## Intentional limitations and semantic mismatches

- Callback transactions are rejected. Although the REST API supports explicit
  transactions, a generic callback requires retry and read/write lifetime
  semantics which this package does not claim until it can preserve them.
- Query aggregation, projections, collection groups, realtime/streaming,
  inclusive/end cursors, externally constructed cursors, and array filters
  composition are rejected. Use a provider-specific repository only where its
  semantics are consciously defined.
- Queries support equality, inequality, range, `in`, and `not-in` property
  filters (1–10 values for the latter two), plus `__key__` through `DOCUMENT_ID`.
  Datastore index requirements, consistency behavior, query restrictions, and
  IAM are server concerns and are not hidden by this adapter.
- `set` and `update` send a complete entity. DALgo `UpdateData` is therefore
  replacement-shaped here; it is not a field-mask patch. Datastore commit mode
  is `NON_TRANSACTIONAL`, so multi-request read-modify-write is not atomic.
- Request and response JSON default to 1 MiB; lookups to 1,000 keys; queries to
  1,000 records; and every request (token acquisition, transport, and response
  body) to a 15 second deadline. HTTP failures expose only status; provider
  error bodies are cancelled and discarded. Token, fetch, redirect, timeout,
  body, and malformed-response failures become a redacted `DatastoreRequestError`.
- Tests use a deterministic injected HTTP mock. They do not validate live IAM,
  OAuth grants, CORS, indexes, quotas, Firestore-mode configuration, or Google
  production behavior.

## Official references

- [Datastore v1 REST overview](https://cloud.google.com/datastore/docs/reference/rest)
- [`projects.lookup`](https://cloud.google.com/datastore/docs/reference/rest/v1/projects/lookup)
- [`projects.commit`](https://cloud.google.com/datastore/docs/reference/rest/v1/projects/commit)
- [`projects.runQuery`](https://cloud.google.com/datastore/docs/reference/rest/v1/projects/runQuery)
- [Entity and value wire types](https://cloud.google.com/datastore/docs/reference/rest/v1/Entity)
- [Firestore in Datastore mode](https://cloud.google.com/firestore/docs/firestore-or-datastore)
- [Authenticate for REST](https://cloud.google.com/docs/authentication/rest)

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and the minimal example type check. It contacts no Datastore instance.

## License

MIT

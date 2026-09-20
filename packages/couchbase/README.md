# DALgo adapter for Couchbase Capella Data API

`@dal-go/dalgo2couchbase` is a deliberately bounded TypeScript adapter from [`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) to the Couchbase Capella Data API and Cloud Native Gateway Data API. It uses only documented Data API document endpoints and SQL++ Query Service passthrough; it never uses management REST or creates Couchbase resources.

## Security and browser boundary

The Data API supports CORS, but authenticates every request. Capella documents HTTP Basic authentication with cluster access credentials. **Do not give those credentials to an untrusted browser.** This library requires a per-request `authorization` provider for a complete Authorization header; it intentionally has no username/password option and never logs an authorization value, URL, document key, SQL statement, or server error body.

For browser use, call a trusted backend or identity-aware proxy that enforces user authorization and returns a narrowly scoped, short-lived credential or proxies the request. Configure CORS and network exposure at the gateway/Capella boundary. A public Data API endpoint is not made safe merely by calling it from browser code.

See Couchbase's [Data API overview](https://docs.couchbase.com/cloud-native-gateway/current/data-api/data-API-overview.html), [Capella Data API guide](https://docs.couchbase.com/cloud/data-api-guide/data-api-intro.html), and [CORS guidance](https://docs.couchbase.com/cloud-native-gateway/current/data-api/exposing-data-api.html).

## Install

This package is developed in the repository workspace and is not yet published
to npm. From the repository root, install dependencies and select it by package
name:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dal-go/dalgo2couchbase build
```

## Collection mapping and document layout

Every DALgo collection path maps explicitly to one existing Couchbase bucket, scope, and collection. The mapping is never inferred. The adapter stores a small envelope so SQL++ results retain DALgo key type:

| Couchbase document part | Value |
| --- | --- |
| document key | Deterministic base64url JSON encoding of the DALgo string or numeric ID |
| `__dalgo_id` | Original DALgo ID |
| `data` | Codec-encoded DALgo document object |

The envelope is adapter-owned. Do not mix arbitrary application documents into a mapped collection. Each mapped collection needs indexes for its SQL++ filters and ordering.

## Minimal setup

```ts
import { collection } from "@dal-go/dalgo";
import { CouchbaseDataApiDatabase } from "@dal-go/dalgo2couchbase";

const db = new CouchbaseDataApiDatabase({
  endpoint: "https://<cluster>.data.cloud.couchbase.com",
  authorization: async () => (await fetch("/api/couchbase-authorization")).text(),
  collections: { items: { bucket: "app", scope: "_default", collection: "items" } },
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
```

The complete, type-checked example is [examples/basic.ts](examples/basic.ts). The authorization endpoint must be authenticated and trusted; do not save its result in browser storage, URLs, analytics, source control, or logs.

## Supported DALgo surface

| DALgo operation | Data API mapping |
| --- | --- |
| `get` / `getMany` | `GET /v1/buckets/{bucket}/scopes/{scope}/collections/{collection}/documents/{key}`; input order preserved |
| `insert` | `POST` to document URL; HTTP 409 maps to `AlreadyExistsError` |
| `set` | unconditional `PUT` upsert |
| `delete` | `DELETE`; a missing document is accepted idempotently |
| `query` | bounded parameterized SQL++ through `POST /_p/query/query/service`, restricted to one mapped collection |
| `setIfMatch` / `deleteIfMatch` | Data API `If-Match` / ETag CAS preconditions, exposed as extensions |

`get` exposes ETag as `metadata.etag`. `setIfMatch` and `deleteIfMatch` turn a CAS mismatch (HTTP 409) into `CouchbaseCasMismatchError`.

## Intentional limitations

- `update` and callback transactions are rejected. Transparent read-modify-write loses CAS safety, and the Data API cannot preserve DALgo callback transaction retry semantics.
- Collection-group queries, cursors, offsets, ranges, `in`/array filters, nested fields, aggregates, joins, and query result streaming are rejected. Structured queries support equality/inequality filters and safe single-field ordering only.
- `limit` caps a single query response; no opaque continuation is invented. Add a supported explicit order and application-level keyset design before relying on multi-page traversal.
- The adapter bounds timeout (1–120 seconds), request JSON (up to 16 MiB), response bodies (up to 16 MiB), parallel point reads, query limit, and SQL statement size. It never retries writes.
- It does not configure CORS, credentials, RBAC, networking, indexes, TLS client certificates, rate limits, or bucket/scope/collection lifecycle. Query access needs Query Service permissions and appropriate indexes.

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, the declaration build, and a type check of the example. Tests inject `fetch` and do not contact a Couchbase cluster; they are not live Capella/CNG acceptance coverage.

## License

MIT

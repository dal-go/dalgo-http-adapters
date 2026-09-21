# DALgo adapter for Azure Table Storage

`@dal-go/dalgo2azure-table` maps DALgo TypeScript records to the Azure Table
Storage REST data plane. It targets existing tables and never calls Azure's
management API.

## Browser and credential boundary

This is **HTTP-capable**, not intrinsically browser-ready. Browser use requires
an Azure Storage CORS rule for the exact application origin and a trusted,
authenticated broker that supplies a short-lived, least-privilege OAuth bearer
token (or a same-origin proxy that holds any SAS). The adapter accepts only a
per-request `authorization` header provider: it intentionally does not accept
account keys, implement Shared Key signing, persist credentials, or put SAS,
tokens, or secrets in query strings, errors, logs, or analytics.

Account keys are server-only. A SAS is a URL credential, so passing one to this
browser adapter would violate that boundary; keep it at a proxy or have the
broker exchange browser identity for a bearer token. CORS and browser-safe
authentication are deployment responsibilities.

## Layout

Each top-level DALgo collection maps to one existing Azure table and one fixed
physical `PartitionKey`. The default table mapping is the collection name, and
the default partition is likewise the collection name. Table names must meet
Azure's 3-63 alphanumeric naming rule, so applications commonly supply a
`tableName` mapper such as `() => "Records"`.

| Azure entity property | Value |
| --- | --- |
| `PartitionKey` | Configured string mapping for the DALgo collection. |
| `RowKey` | Reversible base64url JSON encoding of the DALgo string/safe-integer ID. |
| Other properties | Codec-encoded DALgo scalar fields. |

Azure Table properties are deliberately bounded to strings, booleans, and
finite JavaScript numbers with simple property names. Nested objects, arrays,
nulls, dates, binary values, and 64-bit integers are rejected instead of
silently changing their semantics. `PartitionKey`, `RowKey`, `Timestamp`, and
OData metadata are adapter-owned.

## Minimal setup

```ts
import { collection } from "@dal-go/dalgo";
import { AzureTableDatabase } from "@dal-go/dalgo2azure-table";

const database = new AzureTableDatabase({
  endpoint: "https://example.table.core.windows.net",
  tableName: () => "Records",
  authorization: async () => (await fetch("/api/azure-table-token")).text(),
});

const items = collection<{ done: boolean }>("items");
await database.insert(items.key("milk"), { done: false });
```

The complete type-checked example is [examples/basic.ts](examples/basic.ts).

## Supported DALgo surface

| DALgo operation | Azure Table mapping |
| --- | --- |
| `get` / `getMany` | Point entity `GET`; `getMany` preserves input order with bounded concurrency. |
| `insert` | Entity `POST`; HTTP 409 becomes `AlreadyExistsError`. |
| `set` | Documented Insert-or-Replace `PUT`. |
| `update` | Entity `MERGE` with `If-Match: *`; a missing entity becomes `NotFoundError`. |
| `delete` | Entity `DELETE` with `If-Match: *`; a missing entity is accepted. |
| `query` | Bounded OData `$filter` and `$top` within the configured `PartitionKey`. |
| pagination | Azure continuation headers become an adapter-bound DALgo `startAfter` cursor. |

Point reads and query records expose Azure's ETag as `metadata.etag` when the
service returns it. For concurrency-sensitive writes, use the explicit
`setIfMatch`, `updateIfMatch`, or `deleteIfMatch` methods with that ETag.
Standard DALgo write methods cannot carry an ETag, so they intentionally use
the documented wildcard/no-precondition behavior described above.

## Intentional limitations

- Callback transactions are rejected: Azure entity-group transactions are
  limited to a single physical `PartitionKey` and cannot preserve DALgo's
  callback/retry semantics. This package does not fake a cross-partition
  transaction.
- Collection groups, nested keys, aggregation, realtime/streaming, offsets,
  arbitrary ordering, inclusive/end cursors, projections, array filters and
  membership filters are unsupported. Table Storage's natural order is physical
  `PartitionKey` then encoded `RowKey`, which is not a DALgo document-ID order.
- Queries support at most 15 comparisons (the adapter reserves one for the
  fixed partition), string/boolean/finite-number scalar comparisons, and a
  service page at most 1,000 entities. Azure can return fewer records than
  `$top`; continue with the opaque cursor.
- The adapter applies a 15-second timeout and 1 MiB request/response limits by
  default. HTTP error bodies and provider/transport errors are redacted.
  A timed-out mutation may still have completed server-side, as Azure documents.

## Official sources

- [Azure Table Storage REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/table-service-rest-api)
- [Query Entities](https://learn.microsoft.com/en-us/rest/api/storageservices/query-entities)
- [Querying tables and entities](https://learn.microsoft.com/en-us/rest/api/storageservices/querying-tables-and-entities)
- [Insert Entity](https://learn.microsoft.com/en-us/rest/api/storageservices/insert-entity)
- [Insert and update entities](https://learn.microsoft.com/en-us/rest/api/storageservices/inserting-and-updating-entities)
- [Query timeout and pagination](https://learn.microsoft.com/en-us/rest/api/storageservices/query-timeout-and-pagination)

## Verification

`pnpm check` runs linting, deterministic HTTP-contract tests, declaration
generation, and the example type check. Tests inject `fetch`; they do not use
an Azure account or verify a deployed CORS/token-broker configuration.

# @dal-go/dalgo2pinecone

`@dal-go/dalgo2pinecone` maps the semantically safe subset of DALgo to an individual Pinecone index's HTTP data-plane API using only `fetch`.

```ts
const database = new PineconeDatabase({
  baseUrl: "https://your-index-host",
  collections: {
    products: { namespace: "products", vectorForWrite: (metadata) => embed(metadata.title) },
  },
  headers: () => ({ "Api-Key": tokenFromTrustedBroker() }),
});
```

Use the unique index host supplied by Pinecone, not the control-plane API host. Every DALgo collection has an explicit, distinct Pinecone namespace mapping, preventing collection/ID collisions in a shared index. DALgo record data is stored in Pinecone vector `metadata`; `vectorForWrite` is required because Pinecone upsert requires a vector. `set` uses Pinecone upsert, so it intentionally replaces the metadata and vector for that ID.

## Supported surface

- `get`, bounded `getMany`, `set`, and idempotent `delete`
- `vectorSearch(query, vector)` maps a bounded top-level DALgo query's supported metadata filters (`==`, `!=`, numeric comparisons, `in`, and `not-in`) to Pinecone metadata filters.

Pinecone's official [Fetch vectors](https://docs.pinecone.io/reference/api/latest/data-plane/fetch), [Upsert vectors](https://docs.pinecone.io/reference/api/latest/data-plane/upsert), [Delete vectors](https://docs.pinecone.io/reference/api/latest/data-plane/delete), and [Query vectors](https://docs.pinecone.io/reference/api/latest/data-plane/query) endpoints are the data-plane operations used here. Pinecone documents the unique index host requirement in [Target an index](https://docs.pinecone.io/guides/manage-data/target-an-index). Every request carries the current stable `X-Pinecone-Api-Version: 2026-07` data-plane header.

## Deliberate limitations

DALgo `StructuredQuery` has no vector, so `query` is rejected rather than silently making a non-vector Pinecone request. Call `vectorSearch` explicitly. Pinecone does not provide conditional create/update or DALgo multi-document transactions, so `insert`, `update`, and `runReadwriteTransaction` are rejected before any request. Collection groups, nested keys, DALgo ordering/cursors/offsets, document-ID filtering, array filters, aggregation, and streaming/realtime are also unsupported.

Pinecone vector values are not exposed as DALgo document fields. This adapter deliberately requests only metadata for reads; vectors inserted outside the adapter without object metadata are rejected rather than decoded ambiguously. Vector IDs use Pinecone's documented 1-512-character U+0001-U+007F range. A one-record `set` requires Pinecone to acknowledge exactly one upserted record.

Requests require HTTPS except loopback development, reject redirects, bound request/response sizes and the full request deadline, and redact provider responses, URLs, and configured headers from errors. Pinecone's `Api-Key` is a server credential: browser code would expose it. CORS and browser authentication must be confirmed for the particular Pinecone deployment; use this adapter in a trusted server or worker with a short-lived, scoped brokered credential unless the index is intentionally public and CORS-enabled.

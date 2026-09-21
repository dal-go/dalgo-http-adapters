# @dal-go/dalgo2qdrant

`@dal-go/dalgo2qdrant` maps the semantically safe subset of DALgo to Qdrant's REST API using only `fetch`.

```ts
const database = new QdrantDatabase({
  baseUrl: "https://qdrant.example",
  collections: {
    products: {
      collection: "product-embeddings-v1",
      vectorForWrite: (payload) => embed(payload.title),
    },
  },
  headers: () => ({ "api-key": tokenFromServerBroker() }),
});
```

Each DALgo collection has an explicit Qdrant collection mapping. `set` and `insert` encode a DALgo document as a Qdrant payload and require `vectorForWrite`, because Qdrant point upserts require a vector. Point IDs preserve DALgo string and non-negative safe-integer IDs.

## Supported surface

- `get`, `getMany`, `set`, `insert`, `update`, and idempotent `delete`
- Bounded top-level collection queries with equality, membership, array membership, numeric ranges, `DOCUMENT_ID` equality/membership, `limit`, and `offset`
- `vectorSearch(query, vector)` for vector similarity. It is deliberately separate because DALgo `StructuredQuery` has no vector input.

Qdrant's [query endpoint](https://api.qdrant.tech/api-reference/search/query-points) is used for filtered reads and vector search; [upsert](https://api.qdrant.tech/api-reference/points/upsert-points), [set payload](https://api.qdrant.tech/api-reference/points/set-payload), and [delete](https://api.qdrant.tech/api-reference/points/delete-points) are used for writes.

## Deliberate limitations

Qdrant has no DALgo-equivalent transactions, aggregations, generic payload ordering, cursors, collection-group/nested queries, or semantically reliable negative/null filters, so the adapter rejects them. `insert` and `update` preflight a point to produce DALgo conflict/not-found errors; Qdrant has no conditional upsert or transaction, so concurrent writers can still race. Do not use these operations when atomic create/update semantics are required.

Errors expose only the HTTP status, never response bodies, URLs with credentials, or configured headers. Request and response sizes are bounded; redirects are rejected. `baseUrl` must be HTTPS except loopback development, and credentials belong in injected headers, not URLs.

Browser use is normally unsafe: a Qdrant API key would be exposed to users and Qdrant CORS policy may prevent the request. Use this adapter in a trusted server or worker and inject a short-lived, scoped header from a server-side broker. A browser client is appropriate only for an intentionally public, CORS-enabled endpoint with no secret header.

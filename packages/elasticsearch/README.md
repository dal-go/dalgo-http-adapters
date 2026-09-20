# DALgo for Elasticsearch

`@dal-go/dalgo2elasticsearch` maps DALgo records to Elasticsearch documents through Elasticsearch's HTTP REST API. A top-level DALgo collection is one Elasticsearch index and the DALgo key ID is the Elasticsearch `_id`.

## Status and safety

This adapter is **HTTP-capable**, not generally browser-ready. Elastic's official JavaScript client explicitly does not support browser environments because exposing a cluster can create serious security risk. The adapter uses standard `fetch`, so it can run wherever an operator has deliberately configured CORS and narrowly scoped, short-lived credentials, but the normal deployment is behind a trusted application proxy. Never ship a cluster-wide API key or basic-auth password in browser code.

Supported:

- realtime point reads and `_mget`;
- direct `insert`, `set`, shallow `update`, and idempotent `delete` methods;
- structured filters, ordering, offset/limit, and exclusive `startAfter` paging;
- per-value DALgo codecs and refreshable authentication headers.

Explicit limitations:

- DALgo read/write callback transactions are rejected: Elasticsearch has optimistic concurrency controls but no equivalent atomic multi-document transaction.
- Nested keys and collection-group queries are rejected. Elasticsearch indices are flat document containers.
- `startAt`, `endAt`, and `endBefore` are rejected. `startAfter` requires explicit orders, cannot be combined with a nonzero offset, and maps to `search_after`.
- Ordering by DALgo's document-ID sentinel is rejected because Elasticsearch restricts sorting on `_id`. Query pagination inherits Elasticsearch consistency and sort-stability behavior; use a unique, doc-valued mapped tiebreak field.
- DALgo equality and array operators map to `term`/`terms`, so indexed field mappings determine exact behavior. Use `keyword` fields for exact string comparisons.
- `update` uses Elasticsearch's shallow partial-document merge. It does not interpret Firestore-style dotted field paths.
- Search is near-real-time even though point reads are realtime. A successful write may not be immediately visible to a query until refresh.
- Index names must be lowercase safe literal names; wildcard/multi-index collection names are rejected.
- Successful reads require Elasticsearch `_source` to be enabled. Missing source data is rejected rather than misreported as a missing record.
- Production base URLs must use HTTPS, cannot embed credentials/query/fragment values, and redirects are rejected. Plain HTTP is accepted only for loopback development.

## Install

```bash
pnpm add @dal-go/dalgo github:dal-go/dalgo2elasticsearch-js
```

When installing unreleased Git revisions with pnpm's dependency build policy enabled, authorize only the exact reviewed DALgo and adapter revisions in your workspace's `allowBuilds` configuration. Do not enable dependency scripts globally.

## Example

```ts
import { collection } from "@dal-go/dalgo";
import { ElasticsearchDatabase } from "@dal-go/dalgo2elasticsearch";

const products = collection<{ name: string; price: number }>("products");
const db = new ElasticsearchDatabase({
  baseUrl: "https://your-deployment.example",
  headers: async () => ({ Authorization: `Bearer ${await obtainShortLivedToken()}` }),
});

await db.insert(products.key("p1"), { name: "Tea", price: 12 });
const page = await db.query(products.query().where("price", ">=", 10).orderBy("price").limit(20).build());
```

See [`examples/basic.ts`](examples/basic.ts). The tests use an injected `fetch` implementation and do not require a live Elasticsearch cluster.

## Official API references

- [Elasticsearch REST APIs](https://www.elastic.co/docs/reference/elasticsearch/rest-apis)
- [Get document](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-get)
- [Index document](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-index)
- [Search](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search)
- [Official JavaScript client browser warning](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/installation#_browser)

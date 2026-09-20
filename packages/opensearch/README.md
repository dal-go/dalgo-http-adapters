# DALgo for OpenSearch

`@dal-go/dalgo2opensearch` maps DALgo records to OpenSearch documents through the provider-neutral OpenSearch REST data APIs. A top-level DALgo collection is one OpenSearch index and the DALgo key ID is the document `_id`.

## Status and safety

This adapter is **server/runtime HTTP-capable**, not browser-ready. It deliberately contains no cloud credential provider, AWS SDK, or browser credential flow. `fetch` and the optional headers supplier are transport hooks for an application that has already made a safe authentication decision. The normal deployment is a trusted server, worker, or backend-for-frontend. Do not ship OpenSearch credentials, cluster-wide API keys, or AWS credentials in browser code.

Supported:

- realtime point reads and `_mget`;
- direct `insert`, `set`, shallow `update`, and idempotent `delete` methods;
- structured filters, ordering, offset/limit, and exclusive `startAfter` paging;
- per-value DALgo codecs and refreshable, caller-provided authentication headers.

Explicit limitations:

- DALgo read/write callback transactions are rejected: OpenSearch has optimistic concurrency controls but no equivalent atomic multi-document transaction.
- Nested keys and collection-group queries are rejected. OpenSearch indexes are flat document containers.
- DALgo key IDs and `DOCUMENT_ID` filter values must be strings. Numeric IDs are rejected before a request is made, so an OpenSearch `_id` can never round-trip back as a different DALgo key type.
- This adapter targets direct, literal index names only; aliases, wildcard indexes, and multi-index search are unsupported. Point and multi-get responses are checked against the requested `_index` and `_id`.
- `startAt`, `endAt`, and `endBefore` are rejected. `startAfter` requires explicit orders, cannot be combined with a nonzero offset, and maps to `search_after`.
- Ordering by DALgo's document-ID sentinel is rejected because OpenSearch restricts sorting on `_id`. Query pagination inherits OpenSearch consistency and sort-stability behavior; use a unique, doc-valued mapped tiebreak field.
- DALgo equality and array operators map to `term`/`terms`, so indexed field mappings determine exact behavior. Use `keyword` fields for exact string comparisons.
- `== null` maps to a missing-field query and `!= null` maps to an exists query. Empty `in` and `array-contains-any` filters map to `match_none`.
- `update` uses OpenSearch's shallow partial-document merge. It does not interpret Firestore-style dotted field paths.
- Search is near-real-time even though point reads are realtime. A successful write may not be immediately visible to a query until refresh.
- Index names must be lowercase safe literal names; wildcard/multi-index collection names are rejected.
- Successful reads require OpenSearch `_source` to be enabled. Missing source data is rejected rather than misreported as a missing record.
- Production base URLs must use HTTPS, cannot embed credentials/query/fragment values, and redirects are rejected. Plain HTTP is accepted only for loopback development.
- Queries always send `size`: `maxQueryLimit` defaults to 1,000 and requests above it are rejected. `timeoutMs`, `maxRequestBytes`, and `maxResponseBytes` default to 30 seconds, 1 MiB, and 1 MiB. Bodies are bounded before/while streaming and server error bodies are never exposed through `OpenSearchHttpError`.

### AWS OpenSearch Service

AWS support is intentionally not bundled. AWS-managed domains that use IAM require request-level Signature Version 4, and OpenSearch Serverless requires SigV4 with the service name `aoss` (not `es`) plus a signed SHA-256 payload header. A simple Authorization-header supplier cannot safely implement that protocol because the signature covers the actual HTTP method, URL, headers, and body. Use an injected signing `fetch` implementation only in a trusted server runtime, or route through a trusted backend/proxy. This package does not claim direct browser support: CORS, network policies, and credential exposure must be designed by the host application.

## Install

```bash
pnpm add @dal-go/dalgo github:dal-go/dalgo2opensearch-js
```

When installing unreleased Git revisions with pnpm's dependency build policy enabled, authorize only the exact reviewed DALgo and adapter revisions in your workspace's `allowBuilds` configuration. Do not enable dependency scripts globally.

## Example

```ts
import { collection } from "@dal-go/dalgo";
import { OpenSearchDatabase } from "@dal-go/dalgo2opensearch";

const products = collection<{ name: string; price: number }>("products");
const db = new OpenSearchDatabase({
  baseUrl: "https://search.example.com",
  headers: async () => ({ Authorization: `Bearer ${await obtainShortLivedToken()}` }),
});

await db.insert(products.key("p1"), { name: "Tea", price: 12 });
const page = await db.query(products.query().where("price", ">=", 10).orderBy("price").limit(20).build());
```

See [`examples/basic.ts`](examples/basic.ts). The tests use an injected `fetch` implementation and do not require a live OpenSearch cluster.

## Official API references

- [OpenSearch REST API reference](https://docs.opensearch.org/latest/api-reference/)
- [OpenSearch document APIs](https://docs.opensearch.org/latest/api-reference/document-apis/index/)
- [OpenSearch search APIs](https://docs.opensearch.org/latest/api-reference/search-apis/)
- [AWS: making and signing OpenSearch Service requests](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/managedomains-signing-service-requests.html)
- [AWS: OpenSearch Serverless SigV4 clients](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-clients.html)

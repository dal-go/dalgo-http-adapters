# DALgo adapter for Amazon Neptune openCypher HTTPS

`@dal-go/dalgo2neptune` maps an allowlisted set of top-level DALgo collections
to Amazon Neptune node labels through Neptune Database's real `/openCypher`
HTTPS data plane. It sends `POST application/x-www-form-urlencoded` requests
with parameterized openCypher and never exposes an arbitrary-query escape hatch.

Each DALgo string key is mapped to Neptune's globally unique custom node ID:
`<idPrefix><key>`. The default `idPrefix` is `<collection>:`. This makes
`insert` atomic: Neptune rejects a repeated custom ID with
`DuplicateDataException`. It requires Neptune Database engine 1.2.0.2 or newer.

## Qualification

| Capability | Result |
| --- | --- |
| HTTP data plane | Yes — Neptune Database exposes `/openCypher` over HTTPS. |
| Read / insert / set / update / delete | Yes, for configured node-label collections and string keys. |
| Query / filter | Scalar equality/comparison/membership, sorting, offset, limit, and value cursors. |
| Aggregation | openCypher supports it; DALgo currently has no aggregation contract. |
| Transactions | Not implemented: the HTTPS surface has only per-request autocommit transactions. |
| Realtime / streaming | Not implemented. |
| Browser use | HTTP-capable, not browser-ready. Neptune endpoints are VPC-scoped and IAM uses SigV4. |
| Official JS SDK | Yes, AWS SDK for JavaScript can call the Neptune Data API; this adapter targets the documented direct HTTPS endpoint. |
| Server credentials | Normally yes. Do not expose long-lived AWS access keys or broad IAM permissions in browser code. |

AWS documents the openCypher endpoint as a VPC-reachable HTTPS API supporting
reads and updates, its form-encoded parameterized requests, and JSON `results`
responses. IAM-enabled clusters require every request to be SigV4 signed.
Neptune's docs also require in-VPC network access for the endpoint. Sources:
[openCypher HTTPS endpoint](https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-opencypher-queries.html),
[parameterized queries](https://docs.aws.amazon.com/neptune/latest/userguide/opencypher-parameterized-queries.html),
[custom IDs](https://docs.aws.amazon.com/neptune/latest/userguide/openCypher-Extensions.html), and
[IAM authentication](https://docs.aws.amazon.com/neptune/latest/userguide/iam-auth-connecting.html).

## Configure

```ts
import { collection } from "@dal-go/dalgo";
import { NeptuneDatabase } from "@dal-go/dalgo2neptune";

interface Item { title: string; done: boolean; }

const db = new NeptuneDatabase({
  baseUrl: "https://cluster-id.cluster-abc.us-east-1.neptune.amazonaws.com:8182",
  collections: {
    // DALgo items.key("milk") is the Neptune node with ~id "items:milk".
    items: { label: "Item" },
  },
  // A wrapper must sign the final URL, headers, and encoded body with SigV4.
  fetch: signedFetch,
});

declare const signedFetch: typeof fetch;

const items = collection<Item>("items");
await db.set(items.key("milk"), { title: "Milk", done: false });
```

`collections` is an allowlist. Labels and property paths must be simple
identifiers. Values are parameters, never interpolated into openCypher.
The adapter accepts only non-empty string DALgo key IDs because Neptune custom
node IDs are strings. Its scalar-property mapping accepts non-null finite
strings, numbers, and booleans; arrays, nested objects, and null are rejected
rather than silently adopting Neptune's graph/property semantics.

## Limits and security

- No nested collections, collection-group queries, graph relationships,
  traversals, array-property filters, aggregation, streaming, or callback
  transactions. The adapter maps records to isolated nodes only.
- `set` uses `MERGE` and full property replacement. `update` uses `SET n +=`.
  `delete` refuses to detach relationships, so linked-node deletion fails rather
  than silently deleting graph edges.
- The adapter uses an absolute 30-second deadline by default (maximum 60
  seconds), rejects redirects, streams and bounds each response to 1 MiB by
  default (maximum 10 MiB), validates response structure, and does not put
  server response text in thrown HTTP errors. Invalid JSON after an HTTP 200 is
  still treated as a failed query.
- Queries are never unbounded: `maxRows` defaults to 1,000 (maximum 10,000).
  The adapter asks Neptune for one extra sentinel row, returns at most
  `maxRows` (or the query limit), and provides a cursor only when that sentinel
  proves another page exists.
- Direct browser use is generally impractical: Neptune Database is normally
  private within a VPC, it does not provide a browser-oriented CORS/auth flow,
  and IAM authentication requires per-request SigV4. Prefer a narrowly scoped
  backend or a broker that issues least-privilege, short-lived credentials.
- If using IAM, authorize only the required `neptune-db:ReadDataViaQuery`,
  `WriteDataViaQuery`, and `DeleteDataViaQuery` actions and use the
  `neptune-db:QueryLanguage` condition where suitable. A client-supplied
  `fetch` wrapper receives the final URL, headers, and form-encoded body, so it
  can perform SigV4 signing after the adapter has constructed the request.
  `headers` is only for additional static or rotating headers; it cannot safely
  sign a request without its final payload.

## Verification

`pnpm check` runs ESLint, mocked HTTPS contract tests, and a TypeScript build.
It does not contact a live Neptune cluster.

## License

MIT

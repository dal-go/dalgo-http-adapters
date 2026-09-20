# DALgo adapter for Neo4j Query API

`@dal-go/dalgo2neo4j` implements the [`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js)
database contracts over Neo4j's HTTP Query API v2. It represents one approved
top-level DALgo collection as one configured node label; each record is a node
whose configured ID property is the DALgo key ID.

The adapter sends plain JSON, parameterized Cypher only. It does not expose an
arbitrary-Cypher escape hatch: relationships, graph traversals, parent keys,
and collection-group queries are deliberately outside this DALgo mapping.

## Qualification

| Capability | Result |
| --- | --- |
| HTTP data plane | Yes — Query API v2 executes Cypher over HTTP(S) |
| CRUD / filter query | Yes, for configured node-label collections |
| Aggregation | Neo4j supports Cypher aggregation, but DALgo currently has no aggregation contract |
| Transactions | Explicit Query API transactions are supported only when configured for Aura or a single-instance server |
| Realtime / streaming | Not implemented by this adapter |
| Browser use | HTTP-capable, not browser-ready by default: CORS, authentication, and least-privilege authorization are deployment responsibilities |
| Official JS SDK | Yes (`neo4j-driver` via Bolt/WebSocket); this package intentionally implements the HTTP Query API instead |
| Server credentials | Basic or bearer authentication is normally server-sensitive; never embed a database password or broad bearer token in browser code |

Neo4j documents that the Query API returns `202` for application errors and
places statement errors in the response body. It also documents that explicit
transactions are only available on Aura and single-instance self-managed
servers; a self-managed cluster needs sticky routing. Sources:
[Query API](https://neo4j.com/docs/query-api/current/),
[querying](https://neo4j.com/docs/query-api/current/query/), and
[transactions](https://neo4j.com/docs/query-api/current/transactions/).

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2neo4j-js
```

The repositories currently build as `@dal-go/dalgo` and
`@dal-go/dalgo2neo4j`; no npm package has been published yet.

## Configure a collection mapping

```ts
import { collection } from "@dal-go/dalgo";
import { Neo4jDatabase } from "@dal-go/dalgo2neo4j";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

const db = new Neo4jDatabase({
  baseUrl: "https://example.databases.neo4j.io",
  database: "neo4j",
  collections: {
    items: { label: "Item", idProperty: "id" },
  },
  // Called for every request, so a caller can rotate a short-lived token.
  headers: async () => ({ authorization: `Bearer ${await getAccessToken()}` }),
  timeoutMs: 30_000,
});

const items = collection<Item>("items");
await db.set(items.key("milk"), { id: "milk", title: "Milk", done: false });
const page = await db.query(
  items.query().where("done", "==", false).orderBy("title").limit(25).build(),
);
```

`collections` is an allowlist. Labels, ID properties, and user query fields
must be simple identifiers. The adapter quotes approved identifiers and sends
all data values as Cypher parameters. Configure a Neo4j uniqueness constraint
for each `(label, idProperty)` pair. Without it, concurrent `set` or `insert`
operations cannot provide DALgo's one-key/one-record invariant.

The adapter adds the configured ID property as the final sort field and returns
that complete cursor in `nextCursor`. Cursor values must be non-null JSON
values. It supports equality, comparison, membership, and array filters, sort,
limit, offset, and value cursors. Nested property paths and graph semantics are
rejected rather than guessed. Null filter values, and non-array (or null-containing)
`in`, `not-in`, and `array-contains-any` values are rejected: Cypher null and
missing-property truth tables do not faithfully preserve DALgo filter semantics.

## Transactions

Explicit transactions are opt-in because topology matters:

```ts
const db = new Neo4jDatabase({
  // …baseUrl, database, collections, headers…
  transactionDeployment: "aura", // or "single-instance"
});

await db.runReadwriteTransaction(async (tx) => {
  await tx.update(items.key("milk"), { done: true });
});
```

For Aura, the adapter captures the server's `neo4j-cluster-affinity` header and
replays it on every statement, commit, and rollback. Your browser CORS policy
must expose that header. For a self-managed cluster, do **not** set this option
unless your infrastructure provides the required sticky routing; the adapter
will otherwise reject the callback transaction. The server may expire inactive
transactions (Neo4j documents a 60-second default), so callbacks should remain
short and await each operation.

## Security and operational limits

- HTTPS is required except for a loopback development server. Credentials,
  query parameters, fragments, and base paths in `baseUrl` are rejected.
- Fetch redirects are rejected; API errors retain only Neo4j's error code, not
  a server message or request secrets. Requests have a 30-second default,
  configurable but bounded to 60 seconds.
- A direct browser deployment must enable a narrow CORS policy, use an
  authorization method appropriate to the user, and restrict Neo4j privileges
  to the mapped labels. A browser-facing proxy is often the safer design.
- The adapter uses plain JSON; non-JSON values such as `Date`, `BigInt`, binary,
  temporal, and spatial values require an application codec that converts them
  to JSON-safe values.
- `update` maps to `SET n += $patch`; in Cypher a null patch value removes that
  property. It refuses changes to the immutable DALgo ID property.
- `delete` is intentionally not `DETACH DELETE`: a node with relationships
  fails instead of silently deleting graph edges.

## Verification

`pnpm check` runs ESLint, mocked HTTP contract tests, and a TypeScript build.
No live Neo4j service is contacted by this repository's automated tests.

## License

MIT

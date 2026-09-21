# DALgo adapter for libSQL HTTP

`@dal-go/dalgo2libsql` maps bounded, top-level DALgo collections to explicit
SQLite/libSQL table projections through the JSON Hrana **v3**
`POST /v3/pipeline` protocol. It uses only `fetch`; there are no runtime
dependencies and no Turso account, SDK, URL scheme, or hosted-product API in
the adapter.

libSQL and Turso are related but distinct projects. This package implements the
published SQL-over-HTTP wire protocol, so it can target any compatible server
at a credential-free HTTPS origin. A Turso deployment is one possible server,
not a prerequisite or a promise about Turso provisioning, replicas, sync,
plans, tenancy, CORS, or token issuance.

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2libsql-js
```

The package has not been published to npm yet.

## Configure an explicit projection

```ts
import { collection } from "@dal-go/dalgo";
import { LibSQLDatabase } from "@dal-go/dalgo2libsql";

const db = new LibSQLDatabase({
  serverUrl: "https://db.example.com",
  headers: () => ({ authorization: `Bearer ${shortLivedToken()}` }),
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      keyColumn: { column: "id", nullable: false },
      columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
    },
  },
});
const items = collection<{ title: string; rank: number }>("items");
await db.set(items.key("one"), { title: "Milk", rank: 10 });
```

Identifiers come only from the validated configuration and are quoted. Values
are Hrana positional arguments: strings are `text`, integral numbers and
booleans are SQLite integers, finite fractional numbers are `float`, and null
is `null`. Do not interpolate values into SQL. A DALgo codec may translate an
application document to/from the declared top-level scalar column projection.

## Supported DALgo surface

- `get`, bounded `getMany`, and bounded structured top-level collection queries
  with AND scalar filters, ordering, and non-null `startAfter` cursors. Ordered
  paging appends the key as a deterministic tie-breaker.
- `insert`, `set`, top-level `update`, and `delete` only when the table mapping
  explicitly sets `uniqueKey: true`, meaning the configured key column has a
  database UNIQUE or PRIMARY KEY constraint. Insert uses `INSERT`; set uses a
  single-statement SQLite `ON CONFLICT(key) DO UPDATE` upsert; both must affect
  exactly one record. Update and delete
  bind the key and values. Insert/set require data to exactly match the declared
  column projection; update accepts a non-empty declared subset.
- A new pipeline uses `baton: null`, executes one statement, then closes the
  stream in that same request. Results and response bodies are bounded. HTTP
  status errors omit the response body; in-band failures expose only a bounded
  machine code, never server error text, headers, tokens, or SQL.

## Intentional limits

This adapter rejects nested and collection-group keys, offsets, inclusive/end
cursors, membership/array filters, non-scalar mapped values, unsafe 64-bit
integers, and projections outside the declared mapping. It does not support
blobs, arbitrary JSON columns, aggregation, subscriptions, cursor streaming,
or session state. A codec is the supported route when an application document
needs a JSON column or other conversion.

`runReadwriteTransaction` is deliberately unsupported. The protocol can retain
a stream using a baton, but this adapter ends every operation with `close`; a
DALgo callback transaction would need serialized baton affinity, explicit
rollback, timeout recovery, and replay rules that this package does not yet
prove. Do not infer transaction support from individual atomic SQL statements.

## Browser and authentication limits

The package is HTTP-capable, not browser-ready by default. Browser use requires
the server to permit the exact origin and requested headers through CORS, and a
narrow, short-lived token broker. Never ship an admin, long-lived, shared-write,
or customer-managed encryption key in browser code. `headers` is called per
request and may inject `Authorization: Bearer …` or another deployment-specific
header; headers are never accepted in `serverUrl`, query parameters, errors,
or adapter logs. Authentication, CORS, rate limits, and server policy are
deployment concerns outside this package.

## Verification

`pnpm check` runs mocked protocol tests, lint, and the production TypeScript
build. The package TypeScript configuration also typechecks the example. No
test contacts a live server, provisions a database, issues a token, or proves a
browser CORS policy.

## Official protocol references

- [libSQL Hrana over HTTP v3 specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md)
- [Turso SQL over HTTP protocol, v3](https://github.com/tursodatabase/turso/blob/main/serverless/PROTOCOL.md)
- [libSQL project distinction from Turso Database](https://github.com/tursodatabase/libsql)

## License

MIT

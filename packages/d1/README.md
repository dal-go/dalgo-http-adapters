# Cloudflare D1 adapter for DALgo

`@dalgo/d1` provides a read-only DALgo `QueryExecutor` and `ReadSession` for a
Cloudflare Worker D1 binding, plus an HTTP client and a Worker request handler
for browser or server use. The adapter compiles structured leaf queries to
SQLite SQL with bound values. Table names and fields must come from an explicit
schema map. Callers cannot submit SQL.

## Install

The `@dalgo/core` peer is not published to npm. Its immutable source commit is
`b863f32d2e92a0784e9633aa0eaa14d2d5528336`; the codeload archive contains
source but no built `dist` files. Prepare the package with the TypeScript
compiler, then pack and install the built artifact:

```sh
curl -fL https://codeload.github.com/dal-go/dalgo-js/tar.gz/b863f32d2e92a0784e9633aa0eaa14d2d5528336 -o dalgo-js.tar.gz
mkdir dalgo-js
tar -xzf dalgo-js.tar.gz -C dalgo-js --strip-components=1
pnpm --dir dalgo-js install --frozen-lockfile --ignore-scripts
pnpm --dir dalgo-js exec tsc -p tsconfig.build.json
pnpm --dir dalgo-js pack

# After the D1 0.2.0 GitHub release is available, run from your application directory.
pnpm add https://github.com/dal-go/dalgo-http-adapters/releases/download/d1-v0.2.0/dalgo-d1-0.2.0.tgz ./dalgo-js/dalgo-core-0.2.0.tgz
```

Do not add the raw GitHub or codeload source as a runtime dependency: the
archive needs this build step to create the files exposed by `@dalgo/core`.
Direct Git installs can also fail during npm 10's automatic `prepare` step;
building and packing the pinned source explicitly avoids that lifecycle path.
The D1 release URL above becomes usable only after the `d1-v0.2.0` GitHub
release has been created.

## Worker binding

```ts
import { D1QueryDatabase } from "@dalgo/d1";

const db = new D1QueryDatabase(env.NORTHWIND, {
  tables: {
    Customers: {
      table: "Customers",
      primaryKey: ["CustomerID"],
      columns: {
        CustomerID: { column: "CustomerID" },
        CompanyName: { column: "CompanyName" },
        Country: { column: "Country" },
      },
    },
  },
});
const page = await db.query({
  source: { kind: "collection", name: "Customers" },
  filters: [{ field: "Country", operator: "==", value: "UK" }],
  orders: [{ field: "CompanyName", direction: "asc" }],
  limit: 25,
});
```

`get`, bounded `getMany`, and `query` are supported. A composite key uses a
JSON-array string id in primary-key order. Keyless views may be queried and
listed; their synthetic result keys are only row positions and cannot be used
with `get`.

## Browser or server HTTP access

Use the same schema on the Worker and client. The handler accepts only
`POST /v1/query` and serves `GET /v1/metadata`; it can restrict browser origins
and pin deployment schema and seed versions.

```ts
import { createD1ReadHandler, D1HttpDatabase } from "@dalgo/d1";

const tables = {
  Customers: {
    table: "Customers",
    primaryKey: ["CustomerID"],
    columns: {
      CustomerID: { column: "CustomerID" },
      CompanyName: { column: "CompanyName" },
      Country: { column: "Country" },
    },
  },
};
const handle = createD1ReadHandler(env.NORTHWIND, {
  tables,
  schemaVersion: "northwind-v1",
  seedVersion: "northwind-2026-10-05",
  allowedOrigins: ["https://example.com"],
});
export default { fetch: handle };

const browserDb = new D1HttpDatabase({
  baseUrl: "https://api.example.com",
  tables,
  expectedSchemaVersion: "northwind-v1",
  expectedSeedVersion: "northwind-2026-10-05",
});
```

`baseUrl` may include a mounted prefix such as
`https://api.example.com/northwind/d1`. Set `signal` on the client options to
abort its pending HTTP requests; each request also has a bounded timeout.

If the deployment's version markers differ from the client pins, requests fail
with HTTP 409. Clients may fetch metadata without pins first; when a version
header is supplied, the Worker validates it. The successful leaf protocol is versioned and includes the
selected columns and primary-key fields. BLOB values use a tagged base64 object;
the Worker binding's numeric byte arrays are normalized to `Uint8Array` by the
native adapter and encoded as bytes in HTTP responses. Dates remain the strings
stored by SQLite.

## Query and consistency limits

- Queries cover top-level collections with AND filters (`==`, `!=`, comparisons,
  `in`, and `not-in`), ordering, limit, and offset. Null equality uses `IS NULL`.
- Caller-provided identifiers, unsupported filter operators, cursors, nested
  collections, writes, and callback transactions are rejected.
- Unbounded scans page in primary-key order up to `maxScanRows` (10,000 by
  default), then fail if more rows exist. `scanPages` is available for DALgo's
  streaming joined-query executor. Pages do not claim a multi-request snapshot;
  concurrent writes can affect later pages.
- D1 calls use prepared statements and `.all()` only. The adapter never calls
  `.exec()` for caller queries and does not expose D1 write helpers.
- HTTP request and response bodies, timeouts, query page size, scan rows, and
  `getMany` size are bounded. The Worker must still enforce deployment access
  policy, rate limits, and the exact CORS origins it needs.

## Checks

`pnpm check` runs the package tests, lint, TypeScript build, and example typecheck.
Tests use an in-memory D1 binding fixture and make no Cloudflare account calls.

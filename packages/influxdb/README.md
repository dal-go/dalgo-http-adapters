# DALgo adapter for InfluxDB 3 HTTP SQL

`@dal-go/dalgo2influxdb` is a DALgo TypeScript adapter for the official
InfluxDB **3** HTTP `POST /api/v3/query_sql` endpoint. It intentionally targets
InfluxDB 3 SQL tables and does **not** claim compatibility with InfluxDB 2
Flux/buckets, the v1 API, or arbitrary InfluxQL workloads.

It is **HTTP-capable**, not browser-ready by default. The data plane is HTTPS,
but a browser deployment needs a CORS policy on the exact InfluxDB endpoint and
a narrowly scoped, short-lived database token broker. Never bundle an admin,
long-lived, or shared write token in browser code. The adapter accepts a token
provider and puts the token only in the `Authorization: Bearer` header; it
never accepts credentials in a URL.

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2influxdb-js
```

The package has not been published to npm yet.

## Configure an explicit table projection

Every DALgo collection maps to a configured InfluxDB 3 table, one key column,
and an explicit set of fields. Generated SQL gets identifiers solely from that
validated configuration; application values are named SQL parameters.

```ts
import { collection } from "@dal-go/dalgo";
import { InfluxDB3Database } from "@dal-go/dalgo2influxdb";

interface Reading { room: string; temperature: number; time: string; }

const db = new InfluxDB3Database({
  database: "sensors",
  serverUrl: "https://influx.example.com",
  accessToken: () => currentShortLivedInfluxToken(),
  tables: {
    readings: {
      table: "readings",
      keyColumn: { column: "reading_id", nullable: false },
      columns: {
        room: { column: "room", nullable: false },
        temperature: { column: "temperature", nullable: false },
        time: { column: "time", nullable: false },
      },
    },
  },
});

const readings = collection<Reading>("readings");
const page = await db.query(
  readings.query().where("room", "==", "kitchen").orderBy("time", "desc").limit(25).build(),
);
```

`serverUrl` must be a credential-free HTTPS origin. `http://localhost` and
loopback are allowed only for development. Each fetch uses `redirect: "error"`,
a local deadline, header-only bearer authentication, and bounded JSON or write
payloads. HTTP error bodies are intentionally not read or exposed.

## Supported DALgo surface

- Top-level collection point reads and `getMany` (one bounded parameterized
  point query per key), structured AND filters, ordering, limits, and
  non-null `startAfter` cursor pagination.
- Scalar `null`, boolean, finite-number, and string parameters in `WHERE`, the
  parameter position documented by InfluxDB 3 SQL.
- The current v3 JSON row-array response (`[{"column": value}]`) is the primary
  result contract. The adapter also accepts the generated reference's
  `results → series → columns / values` envelope as a compatibility shape;
  both must exactly match the generated projection. Mapped values must be
  scalar; use a DALgo codec if application data needs conversion.
- DALgo IDs and the configured key column are strings end-to-end. Numeric IDs,
  numeric key results, and non-string key cursor positions reject to avoid
  changing an ID's type on a round trip.
- Ordered queries append the key as a deterministic tie-breaker. Returned
  cursors include all ordered values plus that key. Every ordered cursor column
  must be configured with `nullable: false`; this prevents null-ordering gaps.
- `appendLineProtocol(lines, precision)` is a **separate** native v3
  `/api/v3/write_lp` helper. It writes complete line-protocol points and is not
  DALgo record storage or CRUD.

## Deliberately unsupported semantics

InfluxDB points are identified by table, tag set, and timestamp, and write
behavior does not provide DALgo’s atomic single-record identity or replacement
contract. Therefore `insert`, `set`, `update`, `delete`, and callback
transactions reject before making an HTTP request. Use `appendLineProtocol`
only when append/upsert-at-a-point time-series semantics are what the
application needs.

The adapter also rejects nested and collection-group keys, offsets,
inclusive/end cursors, array and membership query operators, mappings outside
the declared projection, null cursors, and response shapes that do not exactly
match the generated projection. It does not implement aggregation, realtime
subscriptions, or JSONL streaming, even though InfluxDB offers query formats
that can stream; DALgo’s current `QueryPage` contract does not expose a safe
streaming cursor lifecycle.

## Version and product limitations

This package supports InfluxDB 3 Core/Enterprise/Cloud installations exposing
the v3 SQL and line-protocol endpoints. InfluxDB 2’s Flux/bucket model is a
different API and data model, so it needs a separate adapter if DALgo semantics
can be proven for a chosen mapping. CORS, token issuance, tenant permissions,
rate limits, and browser restrictions are deployment-specific and are not
proved by these tests.

## Verification

`pnpm check` runs deterministic mocked HTTP contract tests, lint, and a
TypeScript build. It does not contact a live InfluxDB server, issue a token, or
prove CORS configuration. `pnpm pack --dry-run` verifies the package surface.

## Official InfluxData references

- [InfluxDB v3 HTTP SQL query API](https://docs.influxdata.com/influxdb3/core/query-data/execute-queries/influxdb-v3-api/)
- [InfluxDB 3 SQL parameterized queries](https://docs.influxdata.com/influxdb3/core/query-data/sql/parameterized-queries/)
- [InfluxDB 3 API authentication](https://docs.influxdata.com/influxdb3/core/api/authentication/)
- [InfluxDB 3 `write_lp` API](https://docs.influxdata.com/influxdb3/core/api/write-data/)
- [InfluxDB line protocol](https://docs.influxdata.com/influxdb3/core/reference/line-protocol/)

## License

MIT

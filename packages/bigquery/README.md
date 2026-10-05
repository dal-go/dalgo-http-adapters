# DALgo BigQuery package

The maintained package is `@dalgo/bigquery`. Its new `/analytical` export is a
pure, browser-compatible foundation for the accepted dual-runtime A0 contract.
The ordinary package export retains the legacy DALgo record adapter described
below. This foundation tranche does not implement the complete A0 adapter.

## Analytical foundation

```ts
import {
  decodeRows, hashPayload, normalizeScalar, operationDeadline,
} from "@dalgo/bigquery/analytical";

const cell = normalizeScalar({ type: "INT64" }, "9223372036854775807");
// { type: "INT64", value: "9223372036854775807" }

const rows = decodeRows(
  new TextEncoder().encode('[{"f":[{"v":null}]}]'),
  [{ type: "STRING", mode: "NULLABLE" }],
);
```

`parseJSON` accepts bounded UTF-8 bytes, preserves JSON number lexemes in
`JsonNumber`, rejects duplicate properties, trailing content, invalid UTF-8,
unpaired surrogates and depth above 32. The maximum input is 10 MiB; callers
must separately bound decompressed reads before constructing that buffer.
Direct scalar strings also reject unpaired UTF-16 surrogates. Warehouse
integer/decimal values remain strings, BOOL becomes boolean, finite FLOAT64
uses ECMAScript NumberToString, and SQL NULL remains distinct from JSON text
`"null"`. TIMESTAMP uses signed epoch microseconds in this foundation contract.
Cells are limited to 1 MiB and decoded pages to 1,000 rows and 128 fields.

`canonicalJSON` emits RFC8785 bytes for adapter-owned payloads whose JSON
number tokens are exact safe integers. `hashPayload` uses browser Web Crypto
and the explicit `ReadPlan`, `SourceProfile`, `Observation` and `Approval`
projections in the frozen manifest. Only declared top-level exclusions are
omitted; nested properties called `digest` remain bound. Unicode is never
normalized and keys sort by UTF-16 code units, including integer-like names.

`operationDeadline` computes the earlier of the original execution deadline,
caller deadline and per-HTTP limit. Explicit status/cancel control operations
may use a fresh limit of at most 15 seconds, while exhausted cumulative bytes
still reject. This pure helper never creates or persists a run, dispatches an
HTTP request, resets counters, reconciles billing or releases reservations.

The byte-identical 70-case corpus is vendored from immutable Go driver commit
`d0784c45e698069a3b69198b172d91b754cf7671`; revision 2 manifest SHA-256 is
`90c6ee03076ccf2d90148def6cafea5488046fff7f55e49880f67070cf4f7ffe`.
`testdata/contract/origin.json` records provenance. Production tests execute
every case, verify all file hashes, and compare exact bytes/digests/results.

Remaining required tranches include raw bounded authenticated HTTP, full
request/state corpus, pure compiler and native metadata eligibility, approval,
atomic trusted ledger, single capped submission, same-job page/resume,
schema precision, complete persistent deadline/counter and billing attacks,
GIS/browser flow, CLI/local server, canonical source profile and rights
admission, and both operator-authorized live journeys. The analytical module
has no runtime core import. The ordinary adapter still uses the legacy
`@dal-go/dalgo` peer; migration and compatibility against exact `@dalgo/core`
commits `1534acd4d0e4a104c58eba09fb9c25619efc8f24` and
`04a7f1293ad57a50a282ecc13314ce7b1488211e` remain required. Pure helper parity
does not establish that compatibility. Package publication still requires
root-controlled shared release wiring and permission/provenance gates.

## Legacy DALgo record adapter

The ordinary `@dalgo/bigquery` export implements the read and structured-query portions of
[`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) through BigQuery's
official REST `jobs.query` and `jobs.getQueryResults` endpoints. It uses plain
`fetch`, not a server SDK.

BigQuery is an analytical warehouse, not a browser-first transactional record
database. This package is therefore **HTTP-capable**, rather than
browser-ready: browser use requires an application-issued, short-lived OAuth
token, CORS verification for the exact deployment, least-privilege IAM, and a
strict `maximumBytesBilled` cap. Do not ship service-account JSON, refresh
tokens, or broad project credentials to the browser.

## Install

```sh
# Build packages/bigquery from the maintained dalgo-http-adapters repository.
```

This revision does not claim an npm release. The legacy core dependency remains
the explicit `@dal-go/dalgo` version in this package's manifest.

## Configure an explicit record projection

Each DALgo collection maps to one table, a key column, and every DALgo data
field it may read or write. The mapping bounds generated SQL to known
identifiers, keeps table names out of application input, and makes parameter
types explicit.

```ts
import { collection } from "@dal-go/dalgo";
import { BigQueryDatabase } from "@dalgo/bigquery";

interface Item {
  title: string;
  done: boolean;
  rank: string;
}

const db = new BigQueryDatabase({
  projectId: "example-project",
  location: "EU",
  maximumBytesBilled: "10000000",
  maxRows: 500,
  accessToken: () => currentGoogleAccessToken(),
  tables: {
    items: {
      datasetId: "app_data",
      tableId: "items",
      keyColumn: { column: "id", type: "STRING", nullable: false },
      columns: {
        title: { column: "title", type: "STRING" },
        done: { column: "done", type: "BOOL" },
        rank: { column: "rank", type: "INT64", nullable: false },
      },
    },
  },
});

const items = collection<Item>("items");
const first = await db.query(
  items.query().where("done", "==", false).orderBy("rank").limit(25).build(),
);
```

`accessToken` is called for every HTTP request, including polling and result
pages, so callers can rotate access tokens. The adapter only accepts the
Google HTTPS endpoint, uses `redirect: "error"`, omits response bodies from
HTTP errors, and bounds each operation with timeouts, result page size, and
`maxRows`.

## Semantics and supported surface

- Top-level collection point reads, ordered `getMany`, structured AND filters,
  ordering, limits, and non-null `startAfter` value cursors.
- GoogleSQL **named query parameters** for every runtime value. Identifiers
  come only from validated configuration.
- BigQuery query jobs are polled with `getQueryResults`; multi-page results are
  fetched internally up to the requested, bounded DALgo page.
- BigQuery REST JSON wire values are preserved before a DALgo codec runs. In
  particular, `INT64`, `NUMERIC`, and `BIGNUMERIC` commonly arrive as strings.
  Supply a codec when application types need conversion.
- BigQuery REST wire values are normalized only when a returned cursor becomes
  a typed query parameter (for example `"false"` is accepted for `BOOL` and a
  finite decimal string for `FLOAT64`). Record data itself remains wire-faithful.

The following deliberately reject rather than approximate a different
semantic:

- `insert`, `set`, `update`, and `delete`: BigQuery does not atomically enforce
  a unique key for ordinary tables, so the adapter cannot prove DALgo
  one-record create, replacement, update, or delete semantics. They reject
  before submitting any DML job.
- callback transactions, collection-group/nested collections, offsets,
  inclusive/end cursors, repeated-column filters, null cursor values, and
  unmapped/nested fields.

The adapter appends the mapped key column as an ascending deterministic
tie-breaker to ordered queries. Its returned `nextCursor` therefore contains
the explicit order values **plus** that key value; pass all of them to
`startAfter`. Every field in a paginated order, including the key tie-breaker,
must be configured with `nullable: false`; this prevents SQL NULL sort rules
from skipping or duplicating records.

These legacy value cursors compile and submit another query. They are not A0
same-job cursors and cannot substitute for approved job paging or Resume.

## BigQuery security and cost caveats

The REST API accepts OAuth scopes such as `bigquery` or `cloud-platform`, but
permissions are additionally evaluated against the SQL and referenced data.
Use a narrow, expiring token broker or a server-side proxy for browser apps;
the official Node.js client is not a browser credential model. Browser CORS,
organization policy, IAM, dataset location, query quotas, and billing must be
verified in the target project.

Set `maximumBytesBilled` in production. This adapter does not run a dry run
before every query because a dry run and execution are separate jobs and can
double request/authorization overhead; it lets BigQuery reject a query that
would exceed the configured billing limit.

The adapter also sends BigQuery `jobTimeoutMs` as a best-effort server-side
limit. Its local deadline aborts client requests and stops polling, but it does
**not** call `jobs.cancel`; a submitted query can therefore continue running
and incur charges after the caller gives up. Use a conservative billing cap and
monitor/cancel jobs operationally when that risk is unacceptable.

## Verification

`pnpm check` runs deterministic mocked REST contract tests, ESLint, and a
TypeScript build. It does not use a live BigQuery project, make billable
queries, or prove a particular browser's CORS/IAM configuration.

## Official API references

- [jobs.query](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query)
- [jobs.getQueryResults](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults)
- [Parameterized queries](https://cloud.google.com/bigquery/docs/parameterized-queries)
- [BigQuery authentication](https://cloud.google.com/bigquery/docs/authentication)

## License

MIT

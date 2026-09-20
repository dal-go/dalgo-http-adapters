# DALgo adapter for BigQuery REST

`@dal-go/dalgo2bigquery` implements the read and structured-query portions of
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
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2bigquery-js
```

The package has not been published to npm yet.

## Configure an explicit record projection

Each DALgo collection maps to one table, a key column, and every DALgo data
field it may read or write. The mapping bounds generated SQL to known
identifiers, keeps table names out of application input, and makes parameter
types explicit.

```ts
import { collection } from "@dal-go/dalgo";
import { BigQueryDatabase } from "@dal-go/dalgo2bigquery";

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

# DALgo BigQuery package

The maintained package is `@dalgo/bigquery`. Its new `/analytical` export is a
browser-compatible analytical protocol for the accepted dual-runtime A0 contract.
The ordinary package export retains the legacy DALgo record adapter described
below. The analytical entry does not import a DALgo runtime; consumer integration
and release acceptance remain separate required gates.

## Analytical execution

`BigQueryAnalyticalClient` requires reviewed source profiles, a protected `prepare`
callback, a trusted identity provider and durable session storage. The callback
must re-run the consumer's ordinary read-policy preparation and return its
canonical query and policy-context digest on every operation. Caller-edited
configuration, a raw SQL string or an OAuth token decoded by the caller cannot
substitute for these trusted integrations.

```ts
import { BigQueryAnalyticalClient, IndexedDBLedger } from "@dalgo/bigquery/analytical";

const client = await BigQueryAnalyticalClient.create({
  profiles: reviewedSourceProfiles,
  prepare: prepareProtectedRead,
  provider: verifiedExecutionIdentity,
  ledger: new IndexedDBLedger("explicit-shared-budget-session"),
});
const preview = await client.preview({
  jobProject: selectedJobProject,
  principal: verifiedPrincipal,
  maximumBytesBilled: "10000000",
  sessionBudgetBytes: "30000000",
});
// Present the exact estimate, source/job project, principal, cap and bounds.
const approval = await client.approve(preview, explicitlyApprovedDigest);
const run = await client.execute(approval);
const page = await run.nextPage();
```

The compiler accepts only explicit scalar projections, bounded AND/OR predicates,
comparisons, null checks, IN arrays, scalar order and an explicit limit. Native
TABLE metadata and reviewed execution-affecting configuration are checked before
Preview and again before dispatch. An approved run repeats policy, metadata and
dry-run checks and makes one capped `jobs.query` submission without POST retries.
Missing job identity after an ambiguous attempt retains the full cap reservation.
A known job is persisted before cell validation can fail.

The fixed Google HTTPS transport rejects redirects and bounds decompressed body
chunks before the lossless parser runs. It charges retries, malformed responses
and control responses to the same cumulative byte counter. Injected providers,
policy preparation and transports are bounded even if they ignore abort signals.
The identity provider must attest a Google subject verified with the exact
short-lived access token, or an explicitly configured operator workload subject.
It must report expiry and current read/cancel grants. Tokens stay in memory and
are excluded from persisted previews, receipts, cursors and ledger state.

`IndexedDBLedger` serializes durable updates and uses Web Locks for per-run
exclusion across clients/tabs sharing the explicitly chosen session name. The
session budget is shared by stable subject and job project; changing identity
generation cannot renew it. `MemoryLedger` is for deterministic tests only;
there is no automatic memory fallback. Consumers must preserve the durable
session instead of choosing another database name to continue a stopped run.

A run supports either `nextPage()` or `nextRow()`. Returned immutable pages carry
schema, exact typed cells, a receipt and an opaque same-job cursor. `close()`
stops local delivery without claiming remote cancellation. Resume requires the
trusted persisted cursor, refetches the same partial page, verifies its digest
and skips the delivered offset; a boundary cursor fetches the next token. The
original deadline, response/row/page counters and reservation persist.

`rebind(receipt, cursor)` is an explicit reconnect action for a known job. It
verifies the same stable subject with a new access generation and unchanged
protected read policy, then atomically replaces the trusted cursor reference.
It preserves original approval/principal provenance and makes no BigQuery
request. It never renews a deadline, counter or budget. Expired runs can regain
bounded `status(receipt)` and `cancel(receipt)` access; Resume still rejects
before result dispatch. `cancel` requires the broader explicitly granted scope;
its acknowledgement remains `cancel_requested` until authoritative status.
Warnings are distinct from terminal `errorResult`, and provider reason `stopped`
does not establish confirmed cancellation. Billing reconciles a reservation
only from authoritative terminal billed bytes; absent billing retains the cap.

Metadata rechecks cannot remove the residual race in which the named source is
replaced between observation and submission. Receipts expose that limitation.

## Lossless values and digest foundation

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

Remaining required gates include the independently reviewed frozen HTTP/state
corpus and Go/JS production report parity, protected DALgo consumer integration,
legacy/core migration, actual GIS/browser and CLI/local-server acceptance,
canonical source/rights admission, and both operator-authorized live journeys.
The analytical module has no runtime core import. The ordinary adapter still
uses the legacy `@dal-go/dalgo` peer; compatibility against exact `@dalgo/core`
commits `1534acd4d0e4a104c58eba09fb9c25619efc8f24` and
`04a7f1293ad57a50a282ecc13314ce7b1488211e` remains required. Analytical protocol
checks do not establish that compatibility. Package publication still requires
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

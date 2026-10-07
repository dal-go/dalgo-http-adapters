# DALgo BigQuery package

The maintained package is `@dalgo/bigquery`. Its new `/analytical` export is a
browser-compatible analytical protocol for the accepted dual-runtime A0 contract.
The ordinary package export retains the legacy DALgo record adapter described
below. The analytical entry does not import a DALgo runtime; consumer integration
and release acceptance remain separate required gates.

## Metadata-only browser discovery

`BigQueryMetadataClient` in `/analytical` makes only bounded `datasets.get` and
`tables.get` requests against a trusted consumer's closed source allowlist. It
has no job, dry-run, row, query approval, cost-admission or persistence method.
Every successful result remains `inactive`, with `queryAdmission: "blocked"`
and `costAdmission: "not-granted"`. Billing, execution-project permissions and
source rights remain unverified; provider retention is not authorized.

```ts
import { BigQueryMetadataClient } from "@dalgo/bigquery/analytical";

const metadata = new BigQueryMetadataClient({
  sources: reviewedMetadataLocators,
  provider: verifiedGoogleIdentity,
  authorizeMetadata: prepareCurrentOwnerMetadataConsent,
  currentMetadataBinding: readCurrentJointMetadataBinding,
});
const observed = await metadata.discover(selectedAllowlistedSourceId, { signal });
// Metadata evidence only. Do not activate the source or submit a query.
```

The protected `authorizeMetadata(source, signal)` integration must return the
current application owner's explicit metadata consent, its stable consent ID,
exact allowlisted source, verified Google principal including token generation,
and selected future job project. This is trusted owner-scoped application state,
not caller JSON or an OAuth token. Google consent and application-owner consent
are separate requirements. The mandatory synchronous
`currentMetadataBinding(source)` callback returns one **current joint snapshot**
`{ consent, read, expiresAt }`, or `undefined` when revoked. It must read protected
current application-owner/consent/source/project state together with the current
verified Google subject/generation/grant/expiry; cached preparation results, caller
JSON and an async callback do not satisfy this contract. Invalidate this binding
**before** owner/sign-out/consent/project/source/account/grant changes or token
connect/disconnect/rotation begin; publish a new binding only after verification
and explicit current-owner metadata consent. No token belongs in this snapshot.

Async preparation/identity checks alone leave a race. The client compares the
joint synchronous snapshot immediately at every physical GET/retry dispatch,
after all async checks, and at public result delivery after async work and cleanup.
No await separates the guard from these boundaries. Current read grant and expiry
are checked too. Missing, malformed, asynchronous or changed bindings refuse
requests/delivery with sanitized errors. Reordering separate async checks cannot
substitute for this guard. Workload identities are excluded from this browser
slice. Use the existing GIS identity provider and user-triggered read-only consent
described below; no silent refresh is added. Actual consumer implementation of
this protected joint state is a required integration/review gate, not provided by
this metadata-only package.

The selected job project is recorded only as unverified future context; it is
never substituted for the source project or sent as a quota/billing project.
Only fixed Google HTTPS metadata URLs are constructed. Tokens stay in transient
Authorization headers; URLs, results and sanitized errors exclude them. The
consumer must not log tokens/headers or persist metadata/source bodies. Requests
omit credentials, refuse redirects, and use `cache: "no-store"`. One discovery
per client runs at a time, with finite wall/HTTP deadlines and shared response
byte limits (including failed/retried reads); injected integrations that ignore
abort are still bounded. No background reads or automatic storage are created.

Dataset requests use the `METADATA` view, excluding ACL information. Table
requests use `STORAGE_STATS` because `BASIC` omits `lastModifiedTime`. The result
is explicitly a partial metadata projection: exact resource references,
location, etag and last-modified time when supplied, native schema (including
nested/repeated fields and native descriptor properties), and partition/clustering
configuration. Unknown execution types/configuration may be observed but are
never admitted. JSON number lexemes remain `JsonNumber.text` values. Schema
shape/reference conflicts and malformed wire evidence are refused. Observation
time and last-modified time do not establish row coverage, freshness, uniqueness,
semantic compatibility, rights or execution eligibility.

Google documents [GIS REST/CORS access](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[metadata-only tables.get](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tables/get)
and [datasets.get permissions/views](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/datasets/get).
This supports the direct-browser design; deployed OAuth client/origin, CORS,
owner-consent and live metadata acceptance remain required and unverified here.
WDI remains inactive: no observation table, live schema or location is invented.

[Public datasets](https://docs.cloud.google.com/bigquery/public-data) distinguish
source storage from execution-project query charges. Free quota is not cost
admission. Future queries need separate source-rights and provider-retention
authorization plus reviewed project/location, dry-run/cap approval and same-job
receipts. [Cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs)
and [cached results](https://docs.cloud.google.com/bigquery/docs/cached-results)
confirm that `LIMIT` is not a general scan cap and `useQueryCache: false` does not
prevent provider result-table materialization. Client no-store/RAM limits cannot
clear that retention gate.

Package installation/release compatibility is also pending. The ordinary export
still peers on legacy `@dal-go/dalgo`; this slice changes no dependencies. As of
6 October 2026, npm `@dalgo/core` is 0.1.0 while its source manifest is 0.5.0,
and the legacy peer is unpublished. Repository tests use the existing exact Git
development pins, not proof of published/current-core consumer compatibility.
The analytical entry has no DALgo runtime import, but this does not clear package
publication or consumer adoption gates.

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

The ledger retains source/schema, approved user query parameters, job receipts,
page tokens, counters and page-content hashes for protected same-job Resume.
It never stores returned result cells, rows, raw response bodies or OAuth tokens.
Closing a run also clears its internal in-memory row buffer; the consumer owns
any cells it has already received. No source snapshots or retained result cache
are created by this module.

`GoogleTokenIdentityProvider` verifies a real GIS callback's grants and token
expiry, fetches fixed Google discovery metadata, then calls its pinned UserInfo
endpoint with the same access token used by the BigQuery transport. It requires
`openid` and BigQuery read-only (or explicitly consented cancellation) scope,
binds the returned stable `sub`, and permits missing email. Every connect attempt
clears the old authorization and every successful token change gets a new
principal generation. `authorize` never prompts or silently refreshes.

Use `googleAuthorizationScopes()` in a separate GIS `initTokenClient`, then call
`provider.connect(response)` from its callback. Trigger `requestAccessToken()`
from a user gesture. The returned connection summary contains no token and can
be shown separately from the Firebase/DataTug identity. Call `disconnect()` on
app sign-out, execution-account change and local disconnect; it clears the token
and aborts a pending identity lookup without revoking other Google grants.
Cancellation consent uses `googleAuthorizationScopes({ cancellation: true })`;
it grants the broader BigQuery scope and requires an explicit product action.
OAuth client setup and deployed-origin/CORS acceptance remain required.

Google's [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
defines user-triggered consent and expiry recovery; its [discovery document](https://accounts.google.com/.well-known/openid-configuration)
pins the UserInfo endpoint used here.

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

Canonical TIMESTAMP values remain signed epoch microseconds. REST scalar and
IN-array parameters convert at serialization to exact UTC calendar text with all
six fractional digits using integer arithmetic. Negative instants and the full
year 0001–9999 range preserve precision. Synthetic request vectors live at
`packages/bigquery/testdata/requests/timestamp-parameters-r1.json`; the Go serializer
must consume and verify these vectors before cross-runtime request parity is
claimed. This additive request fixture is separate from the frozen Go scalar
corpus below and does not close the shared raw HTTP/state acceptance gate.

Metadata refuses conflicting current/deprecated partition-filter flags. Result
delivery uses the stricter approved query LIMIT and row bound, and rejects
contradictory row counts, `totalRows` and continuation metadata. Partial-page
Resume counts only undelivered rows and preserves reservations on validation
failure; no response contradiction can authorize additional delivery or a rerun.

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

The immutable 168-case revision-3 corpus is vendored from Go driver commit
`b051a8cd34e9e1e51540d3598bc6d54714da52fc`, tree
`6a7f20a6fe827ba1cc362e38f876cf6b8e060c7b`; manifest SHA-256 is
`094b5caa11df6eb0ddef6498394b0c529464ee6ad01c75611a7a3cdb22ad64c1`.
All original 70 case bytes are unchanged. `testdata/contract/origin.json`
records provenance. The production runner executes the 93 canonical/scalar/row/
hash cases and 75 raw HTTP/state cases, including complete request bodies,
headers, one-byte response schedules, reconnect, counters and absolute deadlines.
Fixture HTTP runs inject fetch and never contact BigQuery.

Set `BIGQUERY_CONTRACT_REPORT` to a private output file for the unmodified HTTP
report and `BIGQUERY_PARITY_REPORT` for the complete corpus result index. Set
`BIGQUERY_GO_CONTRACT_REPORT` to the Go `TestSharedCorpus` HTTP report to compare
all report fields exactly. Only the immutable scenario's explicit Go/JS exposed
byte counter difference on rejected decompressed overflow is admitted; no
counter is clamped or dropped. Independent review of the exact candidate and
both production reports is still required for joint runtime acceptance.

Remaining gates include independent joint review, supplemental timestamp REST
fixture verification by Go, protected DALgo consumer integration, legacy/core
migration, actual GIS/browser and CLI/local-server acceptance, canonical
source/rights admission, and both operator-authorized live journeys.
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


## Protected fixture metadata consumer

`MetadataFixtureHarness` composes `GoogleTokenIdentityProvider` and
`BigQueryMetadataClient` with private current owner, Google subject/generation,
metadata consent, exact source and selected project state. Its constructor
requires explicit `identityFetch` and `metadataFetch` fixture callbacks; there
is no configured live mode. Call `setOwner`, `select`, `connect` from the trusted
fixture application, then explicitly call `consentToMetadata`. Token connection
does not grant application metadata consent. Do not expose these trusted state
methods as caller-JSON commands or construct protected state from URL parameters.

Sign-out (`setOwner(undefined)`), disconnect, source/project changes, denied
consent and token rotations invalidate the joint snapshot synchronously before
asynchronous work. Consent must be granted again after changes. Discovery uses
only the allowlisted dataset METADATA and exact table STORAGE_STATS GETs and
rechecks current state before physical dispatch and delivery. The harness also
rechecks after asynchronous projection hashing and retains the original
operation deadline. Tokens remain in provider memory; no ledger or browser
storage is created, and the returned fixture projection excludes owner,
consent, Google subject/generation, email, job project, raw bodies and rows.

`projectFixtureMetadata` emits only `synthetic-fixture` provenance in the exact
`ovdb-bigquery-observation/draft-1` envelope accepted by the registry at
`253e419214da22a1bcc2b5e78577bb2d46323074`. It preserves native types, field order
and normalized modes, recursively copies only name/type/mode/nested fields,
and enforces 8 schema levels, 500 total fields and 65,536 public bytes. Optional
native descriptors and security/free-text/configuration properties are excluded.
The vendored shared golden's raw SHA-256 is
`2dcf87f754c51b7c655a42ff73d27f0e7b0fab79e9d229db06656203d8e63117`.
Publication rights/provider authenticity require a later independent operator
review; synthetic output cannot activate any source or clear query, cost,
rights, billing or retention gates. Neither helper offers jobs, dry runs,
tables.list, result rows, snapshots, exports or DataTug UI.

This package-local candidate leaves manifest/version/changeset/lockfile/release
changes with root and the release owner. It does not establish npm publication,
current-core compatibility or a live deployed-origin OAuth/CORS journey.

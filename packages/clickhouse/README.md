# DALgo ClickHouse ordinal HTTP executor

`@dalgo/dalgo2clickhouse` exposes `NativeClickHouseDatabase`, a read-only
anonymous result executor. `ClickHouseDatabase` aliases that same native class.
It implements the additive `OrdinalQueryExecutor` from `@dalgo/adapter-runtime`,
with ordered columns and cells, including duplicate labels and rows. It has no
record keys, point reads, append/CRUD methods or callback transactions, and
cannot be substituted for the keyed core `Database` contract.

The historical private `@dal-go/dalgo2clickhouse` keyed/append prototype stays
in internal source/tests. The canonical entry excludes it. Public builds clean
dist and compile only native entry dependencies, preventing stale keyed files
from entering tarballs. Publication requires the coordinated Changesets release
and external npm bootstrap/trusted-publisher setup. No registry publication or
real-server/browser qualification is claimed here. The required
`clickhouse-real-and-browser` CI job must pass before landing.

## Use

The public floor is `@dalgo/core >=0.8.1 <0.9.0` and
`@dalgo/adapter-runtime >=0.2.0 <1.0.0`. After coordinated publication:

```sh
pnpm add @dalgo/core@^0.8.1 @dalgo/adapter-runtime@^0.2.0 @dalgo/dalgo2clickhouse
```

```ts
import { NativeClickHouseDatabase, isOrdinalQueryExecutor } from "@dalgo/dalgo2clickhouse";

const adapter = new NativeClickHouseDatabase({
  serverUrl: "https://clickhouse.example",
  tables: { events: { database: "analytics", table: "events", columns: { id: "id", amount: "amount" } } },
  headers: async () => obtainShortLivedReadOnlyHeaders(),
});
const result = await adapter.queryOrdinal({
  kind: "structured",
  query: {
    source: { kind: "collection", name: "events" },
    filters: [{ field: "id", operator: "==", value: 7 }], orders: [], limit: 10,
  },
  columns: [{ expression: { kind: "field", field: { source: "events", field: "id" } }, as: "native id" }],
}, controller.signal);
if (isOrdinalQueryExecutor(adapter)) renderOrdinalResult(result);
```

[examples/native.ts](examples/native.ts) uses the actual released DALgo TugQL
projection/filter model with typed named parameters. Factories return this
optional executor; consumers detect `isOrdinalQueryExecutor` and render cells
by ordinal, preserving the existing keyed `QueryPage.records` API separately.

Native SQL requires the separate `allowNativeSql: true` option. SQL stays
unchanged; real `{name:Type}` bindings use parameters such as:

```ts
{ name: "id", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } }
```

Structured table/field grants do not restrict explicitly enabled native SQL;
its scope is the credential's server grants. Server readonly=1, narrow SELECT
grants, denied dangerous table functions and immutable resource ceilings remain
authoritative. No SQL sanitizer is used as authorization. Browser credentials
must be deliberately scoped and supplied per request; never embed broad or
long-lived server credentials in an application bundle.

## Exact values and supported shapes

Integers use decimal strings in `{kind:"integer",value}`; decimals retain
`{kind:"decimal",unscaled,scale}`. Null stays null. Dates retain epoch days;
datetimes retain exact integer ticks, scale and declared timezone, without
JavaScript Date coercion. Arrays retain typed values and maps retain entry
pairs, including repeated keys. Supported results are String, Bool, signed/
unsigned 8–256-bit integers, Float32/64, Decimal families, Date/Date32,
DateTime/DateTime64, Nullable, LowCardinality, Array and Map. Unknown types,
FixedString/binary strings, UUID, enums, tuples, JSON/Dynamic/Variant and
aggregate states fail closed, even on empty results. Invalid UTF-8, unknown
binary type encodings and nonfinite floats are refused.

Bindings support explicit scalar types, Nullable and arrays. Temporal bindings
use explicit text parsed by the declared server type. Map and exact temporal
wrapper bindings are refused. Unsafe numeric literals are refused; use exact
typed parameters for large integers and decimals.

Structured requests reuse released `ParsedTugQLQuery` and `QueryColumn`:
one collection or one joined-tugql relation without joins; explicit field,
literal or named-parameter projections/aliases; comparison/membership, nested
AND/OR and null tests; field ordering and a bounded limit. Physical fields are
qualified with their real table so output aliases cannot capture WHERE/ORDER
fields. Identical projections may repeat a label; different expressions sharing
one label are refused. Alias backslashes/controls are refused; literal backticks
are preserved. Unknown tables/fields, wildcard projections, document IDs,
collection groups, codecs, joins, arithmetic, aggregation, recursive queries,
nonzero offsets and cursors are refused. StructuredQuery null equality uses
IS NULL; joined comparisons retain SQL three-valued semantics, with explicit
null tests available.

## HTTP, cancellation and bounds

The adapter selects RowBinaryWithNamesAndTypes via X-ClickHouse-Format and
leaves SQL unchanged. Readers must support this override and text type headers.
Browser CORS must permit POST and authentication/format headers and expose
X-ClickHouse-Format, X-ClickHouse-Exception-Code and X-ClickHouse-Exception-Tag.
Missing/invalid nonce tags fail closed. Before decode, the final 16 KiB are
checked for the exact response-nonce exception prefix, including truncated or
malformed frames. Ordinary error-looking data and other-nonce frames remain
valid binary data. HTTP200 or buffering alone cannot establish success.
Available upstream 26.10.2 source corroborates framing; exact 26.10.3.7 behavior
is a separate real CI gate.

Requests use readonly=1, bounded execution time/result rows/bytes and throw
overflow. Incompatible locked server settings fail explicitly; never relax a
reader to readonly=2. The fixture uses bounded CHANGEABLE_IN_READONLY settings
with immutable ceilings. Client bounds cover request/response bytes, rows,
columns, total nested values, parameter counts, depth and AST visits. Origins
are credential-free HTTPS, with explicit loopback HTTP for development.
Cookies are omitted, redirects refused, and header providers accept only auth
headers. HTTP param_* values can appear in proxy logs; avoid secrets in values.

Caller abort/deadline covers header acquisition, fetch and body reads. Abort
also attempts a separately bounded KILL for its generated own query ID.
`serverCancellation` reports `best-effort-kill-query`; only external server
observation proves termination. Server deadlines remain necessary when a
network failure prevents cancellation. Errors redact SQL, values, credentials
and provider messages. `code:"framing"` carries only actual format, tag length,
prefix presence, body/frame byte counts and complete-body state. Generic
decoder or transport failures cannot satisfy the framing proof.

## Real account-free CI proof

The required Ubuntu 24.04 job builds the public entry, installs Chromium and
generates a fresh masked Node-only admin secret. One owned Docker fixture runs
with 2 GiB RAM, no swap, 2 CPU and 128 PIDs, using:

```text
clickhouse/clickhouse-server:26.10.3.7@sha256:739e099abd1157390960a59e4532d21781d8fde57e6e4151cb920ea02c30b1ce
```

`test/fixtures/upstream` contains byte-verified schema/access config and license
from public SDK commit 99a44064132e, with provenance. Its 96-worker global pool and
11-entry read-only/resource profile stay intact. Separate CORS and users.d
auth overlays require the fresh secret for default admin; Chromium never gets
that secret. Authoritative before/after metadata and SHOW CREATE assert every
original value, constraint, assignment and identity. Only incremental
max_block_size=1 CONST may be added; later runners revalidate it unchanged.

The Linux-only `scripts/check-real-fixture.sh` waits for final server PID and
initialized rows, then runs Node 20, Node 24 and Chromium sequentially. Each
checks actual SELECT version(), exact values, duplicate labels/rows, alias
capture/round-trip/injection refusal, actual lateHTTP200 framing, server
write/settings/out-of-scope refusal, and system.processes cancellation from
1 to 0. Chromium uses the actual compiled public entry over exact-origin CORS,
refuses a second origin, and proves omitted credentials cannot reach admin.
Both runtimes preserve duplicate map keys and separately refuse disabled
native SQL. There are no routed/mocked browser requests.

For an approved Linux run, set CLICKHOUSE_NODE20 to Node 20.0.0,
CLICKHOUSE_PROOF_DIR to a private artifact directory and
CLICKHOUSE_FIXTURE_ADMIN_PASSWORD to a fresh 43–128-character base64url secret;
invoke the shell script after building and installing Chromium. It sets the
exact CLICKHOUSE_TEST_URL and CLICKHOUSE_FIXTURE_IMAGE for the real runners.
Bounded redacted receipts include framing/profile proof, OOM/PID counters,
actual container caps and verified cleanup. Missing proofs, assertions,
resource denials and cleanup failures fail CI. Local unit/type/build receipts
remain distinct from real-server/browser receipts.

Official references: [HTTP and CORS](https://clickhouse.com/docs/concepts/features/interfaces/http),
[RowBinary header format](https://clickhouse.com/docs/reference/formats/RowBinary/RowBinaryWithNamesAndTypes),
[read-only settings](https://clickhouse.com/docs/concepts/features/configuration/settings/permissions-for-queries).

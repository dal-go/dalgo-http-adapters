# DuckDB ordinal executors

Source implementation; not yet published or accepted as a complete Go/CLI +
TypeScript/web delivery. Standalone Chromium/WASM validation passed with registered
Parquet, exact integers/decimals/booleans/nulls, locked security settings, bounded
results, cancellation after query dispatch, worker cleanup and reopen. This does
not establish independently observed native computation before cancellation.
App integration, released clean consumers and Go CLI/Parquet requalification
remain separate gates. The required runtime ordinal declarations are pending
`@dalgo/adapter-runtime` 0.2.0; published 0.1.2 lacks those declarations.

Importing the package root loads neither DuckDB engine. Import the selected
runtime entry only when the user chooses DuckDB:

```ts
const { NodeDuckDBDatabase } = await import('@dalgo/dalgo2duckdb/node');
const db = new NodeDuckDBDatabase({
  databasePath: '/fixtures/existing.duckdb',
  parquetPaths: ['/fixtures/example.parquet'],
  maxRows: 1000,
});
const result = await db.queryOrdinal({
  kind: 'native', sql: 'SELECT * FROM fixture ORDER BY id LIMIT 100',
}, abortController.signal);
```

Node uses the pinned official `@duckdb/node-api@1.4.5-r.1` LTS release. Existing
files open with `access_mode=READ_ONLY`; an omitted path creates a disposable
memory database. Each call owns its connection and instance, uses one thread,
128 MiB engine memory by default (32–512 MiB), no temporary-disk budget,
`enable_external_access=false`, exact file grants, disabled automatic extension
installation/loading and locked configuration. Explicit local `.parquet` paths
are the only external data grants. The bundled Parquet extension is loaded
before configuration locks. Extensions are never fetched from the network.
Node native addons belong in a trusted server and must never enter a browser
bundle. The host is responsible for authorization and resolving approved files;
do not accept end-user database paths or path grants directly.

```ts
const { BrowserDuckDBDatabase } = await import('@dalgo/dalgo2duckdb/browser');
const db = new BrowserDuckDBDatabase({
  bundle: {
    mainModule: '/assets/duckdb/duckdb-mvp.wasm',
    mainWorker: '/assets/duckdb/duckdb-browser-mvp.worker.js',
  },
  parquetFiles: { 'example.parquet': uploadedBytes },
  parquetExtensionRepository: '/assets/duckdb/extensions',
});
const result = await db.queryOrdinal({
  kind: 'native', sql: "SELECT * FROM read_parquet('example.parquet') LIMIT 100",
}, abortController.signal);
```

The WASM entry pins `@duckdb/duckdb-wasm@1.32.0`; the actual worker reports core
DuckDB v1.4.3. The application self-hosts matching immutable WASM/worker assets
and the matching signed core Parquet extension. Construction records URLs and copies at most 16 MiB of
explicit Parquet buffers by default; queries create an isolated single-thread
worker, lazy-load the engine, register those buffers, preload only Parquet through
the trusted mirror, then lock configuration and enter a read-only transaction.
Only same-origin assets and simple `.parquet` buffer names are
accepted. Direct remote URL/OPFS SQL reads are disabled. A host may fetch/upload
bytes using its own authorization/origin/size policy before passing them here.
On abort/deadline the dedicated worker is terminated. No browser worker or WASM
asset is fetched on Home/Login merely by importing the package root.

`parquetExtensionRepository` is mandatory when `parquetFiles` is nonempty and
must be an app-owned same-origin repository URL without credentials, query or
fragment. Mirror the official extension for the exact engine version/platform;
the fixture's v1.4.3 MVP binary is served under
`<repository>/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm`. Parquet is separate
from the npm engine assets. Official WASM `LOAD` fetches and verifies the signed
extension during trusted bootstrap; no user query runs at that stage. Automatic
installation/loading and community extensions are disabled, and unsigned
extensions remain disabled. External access is disabled after preload, with only
the registered buffer paths allowed, before configuration locks and user SQL.
Engine-only SQL without supplied Parquet buffers does not require a mirror.
See the official [WASM extension contract](https://duckdb.org/docs/1.4/clients/wasm/extensions)
and [self-hosted deployment guidance](https://duckdb.org/docs/1.4/clients/wasm/deploying_duckdb_wasm).

Both runtimes implement the existing `OrdinalQueryExecutor` contract from
`@dalgo/adapter-runtime`, with positional rows and no invented record keys.
Native SELECT subqueries are wrapped with a hard limit plus one overflow row;
exceeding the limit rejects the whole result instead of silently truncating.
The source query must supply its own `ORDER BY` and native paging expression
when ordering/paging matters. There is no implicit stable cursor or offset.
An outer subquery can cause DuckDB to disambiguate duplicate output labels;
column positions remain authoritative. Returned values are bounded by row,
column, serialized-byte, request-byte and wall-clock limits. These are not a
provider cost estimate, process memory limit or guarantee about bytes scanned;
run the engine in the host's bounded worker/container too.

SQL is restricted to a single comment-free SELECT-subquery expression; `;`,
`--` and block-comment delimiters are rejected even inside literals. This is a
wrapper-integrity restriction, not an authorization sanitizer. The engine's
read-only transaction and locked external-access settings enforce the actual
boundary. All user parameters, structured TugQL and write/transaction APIs are
currently refused explicitly. Native error/SQL/file/caller-reason contents are
redacted; errors expose only a stable code. Caller versus deadline cancellation
uses the shared `QueryCancelledError` contract. Node interruption is best effort;
handles close only after outstanding native work settles.

Node retains exact `BIGINT`/`HUGEINT`, decimal scale, supported dates and timestamp
ticks. Browser retains exact Arrow 64-bit integers and signed decimal128 values.
The async Arrow schema is opened before metadata is read; record batches remain
streamed, with metadata bounds checked before iteration and reader cleanup on
success, overflow or failure.
The browser requests standard Arrow output (`arrowLosslessConversion=false`)
while explicitly disabling JavaScript bigint, decimal and timestamp casts. The
[pinned v1.4.3 exporter](https://github.com/duckdb/duckdb/blob/v1.4.3/src/common/arrow/arrow_converter.cpp)
exports BOOLEAN as canonical Arrow Bool in this mode; Int64/Uint64 and the
supported Decimal128 layout are independent of that option. This avoids the
noncanonical bool8 storage observed in the pinned WASM build; its underlying
exporter/compiler cause is unverified. There is no negative-integer compatibility
mapping. Optional typed `arrow.bool8` values accept only the canonical `0`/`1`
subset and preserve their extension metadata; ordinary negative Int8 stays numeric.

Standard Arrow output is not a claim of complete DuckDB logical-type fidelity.
For example, the exporter can represent signed HUGEINT as Decimal128(38,0) and
UUID as text; those representations do not qualify complete native HUGEINT/UUID
APIs. Opaque UHUGEINT and nested values are refused rather than coerced.
Unsupported nested/binary/interval and browser temporal values reject the whole
query rather than coercing to strings or lossy doubles. Parquet itself can
contain such types; select/cast an explicitly supported projection when needed.

Focused tests: `npm run check`, `npm run build`, `npm run test:real` (Node fixture).
Only run these in the coordinator-admitted capped Linux check slot. Mock tests
alone do not prove a real Node/WASM engine, browser UI, clean npm consumer, Go
consumer or release.

API/security references used while implementing:

- https://github.com/duckdb/duckdb-node-neo (official Node Neo API)
- https://duckdb.org/docs/clients/wasm/data_ingestion (registered WASM files)
- https://shell.duckdb.org/docs/classes/index.AsyncDuckDBConnection.html
- https://duckdb.org/docs/1.4/configuration/overview (external access/path grants;
  the pinned engine configuration still requires an actual runtime check)


The standalone browser fixture uses pinned Playwright 1.64.1 and esbuild 0.28.2.
`test/fixtures/wasm-artifact.json` pins the exact 1.32.0 MVP engine, worker and
browser-module SHA-256 values from the verified package-lock installation, plus
the separately staged signed Parquet extension's decoded bytes and SHA-256.
The wrapper package version is distinct from the DuckDB core version: the
fixture records the latter through the actual worker's `getVersion()` result.
`DALGO_PLAYWRIGHT_DIR` may point to the coordinator's existing cached Playwright
workspace; it never installs or downloads a browser. When
`DUCKDB_NPM_LOCKFILE` names the staged npm lockfile, its exact version/integrity
must match too. The fixture validates lazy root imports, actual Chromium/WASM
Parquet execution, exact integers/decimals, bounds/refusals, cancellation after
query dispatch and worker cleanup. Its evidence qualifies this standalone
adapter fixture, not a DataTug UI, shared Query Editor, hosted service or npm
release. The private controller is maintained outside the published source repository.
`DUCKDB_PARQUET_EXTENSION` must name the staged decoded signed extension binary;
the fixture verifies its exact manifest hash before serving it from owned
loopback. The accepted fixture runs with external networking disabled.

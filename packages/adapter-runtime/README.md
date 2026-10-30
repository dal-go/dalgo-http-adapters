# DALgo adapter runtime contracts

`@dalgo/adapter-runtime` is the small browser-safe shared surface used by DALgo
TypeScript adapters that expose caller cancellation and honest capability
descriptors. It contains no generic HTTP client, signing abstraction,
credential store, retry framework or core-interface replacement.

It depends on `@dalgo/core` for types only. Its own JavaScript imports no Node
built-in and no DOM polyfill.

## Install

The ordinal declarations require the released `@dalgo/core` `0.8.1` query
model (commit `52a466927b154aff019b5e13fdec66acfe24f609`). Earlier runtime
releases supported core `0.7.4`; this source revision raises that minimum:

```jsonc
// package.json, pnpm 11 subdirectory dependency before npm publication
"@dalgo/core": "github:dal-go/dalgo-js#52a466927b154aff019b5e13fdec66acfe24f609",
"@dalgo/adapter-runtime": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/adapter-runtime"
```

```yaml
# pnpm-workspace.yaml: GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/52a466927b154aff019b5e13fdec66acfe24f609': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/adapter-runtime': true
```

The peer range is `@dalgo/core >=0.8.1 <0.9.0`. This source is not published to
npm by this change; see the distribution gates at the end.

## Cancellable query contract

```ts
import { isCancellableQueryExecutor, type CancellableQueryExecutor } from "@dalgo/adapter-runtime";

if (isCancellableQueryExecutor(database)) {
  const page = await database.queryWithSignal(query, controller.signal);
}
```

`CancellableQueryExecutor.queryWithSignal(query, signal)` is additive. The core
`QueryExecutor.query(query)` interface and its existing behaviour are unchanged,
so a consumer can keep using `query` when it has no cancellation signal.

The contract is:

- The caller signal covers header acquisition, the HTTP request and response
  body consumption, combined with the adapter's one configured end-to-end
  deadline.
- A pre-aborted signal performs no header, network or body work.
- A caller abort or deadline rejects promptly with `QueryCancelledError`; a late
  response is cleaned up and never returned as a page.
- `QueryCancelledError.reason` distinguishes `"caller"` from `"deadline"`.
  Neither the message nor a cause includes the caller's abort reason, header
  values or transport text.
- Deliberate configuration and unsupported-query errors keep their precise
  type and message. They are not converted into cancellation or transport
  errors.
- Adapter-owned bounds diagnostics with fixed messages (for example a response
  exceeding `maxResponseBytes`) remain visible. Arbitrary transport failures,
  including external `RangeError`s, are redacted even when they share that
  error class.
- Cancellation never waits for a hostile `cancel()` promise.

Adapters use the shared helpers rather than duplicating the race:

- `createAbortScope(callerSignal, timeoutMs)` combines the signals and owns the
  timer/listener cleanup.
- `raceAbort(promise, signal, createError)` rejects on abort and keeps a handler
  on the late promise.
- `cancelQuietly(resource)` starts cancellation without awaiting it.

## Capability descriptors

The descriptor types describe what an adapter actually does. Consumers must
read the descriptor for the adapter in use and must not infer capabilities from
an engine name.

```ts
type CapabilityStatus = "native" | "bounded-client" | "configured" | "unsupported";

interface AdapterReadCapabilities {
  adapter: string;
  storage: "managed-envelope" | "native-rows";
  read: ReadCapabilities;
  query: ReadQueryCapabilities; // projection, filter, sort, pagination, joins,
                                // aggregation, grouping, subquery, fulltext,
                                // timeseries, native, discovery
  bounds: QueryCapabilityBounds;
}
```

Each capability row is explicit. There is no implied support when a row is
absent. Bounds carry both the constructor default and the hard maximum enforced
by the adapter.

The two current reference adapters export their own constants:

- `COUCHDB_READ_CAPABILITIES` from `@dalgo/dalgo2couchdb`
- `POSTGREST_READ_CAPABILITIES` from `@dalgo/dalgo2postgrest`

A small consumer-side admission check looks like this:

```ts
if (capabilities.query.sort.status === "unsupported" && built.orders.length > 0) {
  throw new Error("this adapter does not support ordering");
}
```

## Conformance fixture

[`fixtures/conformance.json`](fixtures/conformance.json) is a tiny,
provider-neutral contract fixture for cancellation phases, page/cursor shape,
JSON value preservation, and refusal expectations. It is reusable by forthcoming
Go adapters and is not proof that any adapter, provider or service exists. It is
intentionally not a TypeScript-only test transcript.

## Verification

```sh
pnpm --filter @dalgo/adapter-runtime run check
```

This runs ESLint, deterministic Vitest tests, the declaration build, the
DOM-only browser type fixture (`types: []`, no Node ambient types) and an
esbuild browser bundle check for this package and both reference adapters. It
proves no Node built-in is bundled. Tests use in-memory timers, streams and
signals; they do not contact a database or a web browser.

## Distribution gates

The manifest, exports, `prepack`, changeset and `publishConfig` are ready for the
repository's Changesets pattern, but this change does not publish anything.
Remaining owner gates are:

- adding the package to the release workflow's explicit package loop and
  trusted-publishing configuration;
- the first npm bootstrap (or a deliberate decision to keep first-wave
  consumption on pinned GitHub subdirectory dependencies);
- updating `docs/RELEASING.md` and the root support catalogue;
- a real application consumer installation and a real DataTug web-UI journey.
  The packed-declaration consumer check proves only the packed type surface, not
  either of those deployments.

## License

MIT

## Anonymous ordinal SQL results

`OrdinalQueryExecutor` is an optional additive surface for SQL adapters whose
rows have no durable record identity. `isOrdinalQueryExecutor(value)` narrows it.
Core `Database`, `QueryPage.records` and `ExistingRecord.key` remain unchanged.

```ts
if (isOrdinalQueryExecutor(adapter)) {
  const result = await adapter.queryOrdinal({ kind: "native", sql: "SELECT 1" }, signal);
  // Render result.columns[index] with result.rows[rowIndex][index].
}
```

A result contains ordered `{name,nativeType}` columns and equally wide rows.
Labels and rows may repeat; no label-keyed object or synthetic record key is
introduced. JSON-safe `OrdinalValue` wrappers preserve exact integers, unscaled
decimals plus scale, epoch days, timestamp ticks plus scale/timezone, arrays,
and ordered map entry pairs including duplicate keys. Numbers represent only
finite provider floating-point values.

Structured requests use the released DALgo `ParsedTugQLQuery` model:
`{kind:"structured",query,columns?,parameters?}`. `columns` supplies explicit
core `QueryColumn` projections for legacy `StructuredQuery`; joined TugQL
already has projections. Providers must state their supported subset and
refuse unsupported expressions before I/O. Named `OrdinalParameter` values
carry an explicit native type so an exact SQL integer/decimal never passes
through an unsafe JavaScript numeric literal.

An abort signal covers the complete operation. Prompt local cancellation is
separate from server cancellation: provider-specific real tests must observe
server work ending before claiming that the server stopped.

# DALgo adapter runtime contracts

`@dalgo/adapter-runtime` is the small browser-safe shared surface used by DALgo
TypeScript adapters that expose caller cancellation and honest capability
descriptors. It contains no generic HTTP client, signing abstraction,
credential store, retry framework or core-interface replacement.

It depends on `@dalgo/core` for types only. Its own JavaScript imports no Node
built-in and no DOM polyfill.

## Install

The package is peer-compatible with the `@dalgo/core` identity pinned by the
DataTug web UI (`0.7.4`, commit
`99165e9e1a39c32abee2b39d6395677843bc3559`), and with the current `0.8.x`
line:

```jsonc
// package.json, pnpm 11 subdirectory dependency before npm publication
"@dalgo/core": "github:dal-go/dalgo-js#99165e9e1a39c32abee2b39d6395677843bc3559",
"@dalgo/adapter-runtime": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/adapter-runtime"
```

```yaml
# pnpm-workspace.yaml: GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/99165e9e1a39c32abee2b39d6395677843bc3559': true
  '@dalgo/adapter-runtime@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/adapter-runtime': true
```

The advisory peer range is `@dalgo/core >=0.7.4 <0.9.0`. It is not published to
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

- `COUCHDB_READ_CAPABILITIES` from `@dal-go/dalgo2couchdb`
- `POSTGREST_READ_CAPABILITIES` from `@dal-go/dalgo2postgrest`

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
- consumer installation and a real DataTug web-UI journey. Neither is claimed
  here.

## License

MIT

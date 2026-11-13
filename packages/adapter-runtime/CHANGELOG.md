# @dalgo/adapter-runtime

## 0.2.0

### Minor Changes

- 7d4cac1: Add an optional anonymous ordinal query contract and the canonical read-only ClickHouse HTTP executor with exact numeric and temporal values, preserving keyed core Database compatibility. Require released @dalgo/core 0.8.1 or newer within 0.8.x for the public ParsedTugQLQuery declaration. The public ClickHouse entry contains only the native ordinal executor; the historical private keyed/append prototype is excluded.

## 0.1.2

### Patch Changes

- df4e5f2: Prepare a fresh coordinated release after correcting the four unpublished native adapter package names to the `@dalgo` npm scope. Include the shared adapter runtime, Firestore and OVDB in normal version-change publication so the complete prepared compatibility batch can be released through the reviewed version pull request.

## 0.1.1

### Patch Changes

- ab69892: Add `@dalgo/adapter-runtime`, a browser-safe shared contract for DALgo
  TypeScript adapters: the optional `CancellableQueryExecutor.queryWithSignal`
  surface, redacted caller-abort/deadline handling, targeted abort/listener/timer
  helpers, and explicit read/query capability descriptor types. The package also
  ships a provider-neutral JSON conformance fixture. This is its first release
  preparation; npm publication remains a separate owner gate.

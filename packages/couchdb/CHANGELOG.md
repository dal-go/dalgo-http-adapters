# @dalgo/dalgo2couchdb

## 0.2.1

### Patch Changes

- df4e5f2: Prepare a fresh coordinated release after correcting the four unpublished native adapter package names to the `@dalgo` npm scope. Include the shared adapter runtime, Firestore and OVDB in normal version-change publication so the complete prepared compatibility batch can be released through the reviewed version pull request.

## 0.2.0

### Minor Changes

- ab69892: Align the adapter with the modern `@dalgo/core` identity and add
  `queryWithSignal(query, signal)`: caller cancellation now propagates through
  header acquisition, fetch and response-body reads, combined with one end-to-end
  deadline, with redacted caller-abort/deadline/transport errors and late-response
  cleanup. Arbitrary transport `RangeError`s are redacted while adapter-owned
  bounds diagnostics remain visible. Responses with more rows than the requested
  query bound are rejected before decoding. Export honest managed-envelope
  read/query capability constants. The existing `query` interface and success
  behaviour are unchanged. Prepare the manifest for Changesets distribution
  without publishing.
- a3a9be8: Add an explicit read-only native application-document mode through
  `NativeCouchDbDatabase` and `NATIVE_COUCHDB_READ_CAPABILITIES`. One configured
  CouchDB database maps to one configured logical collection; existing documents
  keep their string `_id` as the DALgo key and their `_id`/`_rev` fields, without a
  `__dalgo_*` or `data` envelope. `get`, fail-fast `getMany`/`getManyWithSignal`,
  bounded Mango `query`/`queryWithSignal`, optional explicit projections,
  configured-index-only ordering with an `_id` tie-break, opaque single-use
  adapter-issued pagination handles with bounded in-memory query/credential/
  bookmark binding, and bounded connection/index/field discovery are supported.
  `maxGetManyBytes` bounds cumulative batch retention, and raw-wire unsafe integers
  are refused instead of being silently rounded. Every mutation entry point
  refuses before HTTP. The existing managed `CouchDbDatabase` default API,
  behavior and tests are preserved apart from the shared numeric refusal.

### Patch Changes

- ef28cc4: Build `@dalgo/adapter-runtime` from the same commit inside `prepack`. A pnpm
  `github:` subdirectory dependency is prepared in its own fetched workspace copy,
  where the workspace-linked runtime had no `dist` yet, so installing either
  adapter from a Git subdirectory failed with `TS2307: Cannot find module
  '@dalgo/adapter-runtime'`. Packed tarball installs are unchanged; `prepack` now
  matches the existing `sqlite-wasm`/`d1` dependency-build order and the new
  `check:git-subdir-consumer` gate installs, type-checks and dynamically imports
  both adapters from a Git fetch.

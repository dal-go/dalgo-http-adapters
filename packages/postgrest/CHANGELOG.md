# @dalgo/dalgo2postgrest

## 0.2.1

### Patch Changes

- df4e5f2: Prepare a fresh coordinated release after correcting the four unpublished native adapter package names to the `@dalgo` npm scope. Include the shared adapter runtime, Firestore and OVDB in normal version-change publication so the complete prepared compatibility batch can be released through the reviewed version pull request.

## 0.2.0

### Minor Changes

- ab69892: Align the adapter with the modern `@dalgo/core` identity and add
  `queryWithSignal(query, signal)`: caller cancellation now propagates through
  header acquisition, fetch and response-body reads, combined with one end-to-end
  deadline, with redacted caller-abort/deadline/transport errors and late-response
  cleanup. Responses with more rows than the requested query bound are rejected
  before decoding. Export honest native-rows read/query capability constants. The
  existing `query` interface and success behaviour are unchanged. Prepare the
  manifest for Changesets distribution without publishing.
- 36f72de: Add account-free native PostgREST discovery and cursor paging: bounded
  read-only OpenAPI metadata for exposed relations, declared field types and
  declared primary keys; `testConnection`/`discover` with caller cancellation;
  opaque query-bound keyset cursors in `queryWithSignal` with a deterministic
  primary-key tie-breaker and explicit rejection of foreign or changed queries;
  explicit schema/profile selection; an opt-in loopback HTTP development option;
  and PostgREST-specific configured bounds. Legacy `query()` keeps its offset
  contract and still refuses DALgo cursors. Projection remains explicitly
  unsupported because the current core `StructuredQuery` cannot express it.
  
  Cursor continuation is returned for every non-empty page (including a short
  page caused by `db-max-rows`) and ends only on an empty page. Lossless JSON
  number checks refuse unsafe integers and any decimal or exponent literal whose
  exact value would change when serialized back through JavaScript, before a
  record or cursor is emitted. Filters on PostgREST control parameter names are
  quoted at the URL key using the documented identifier quoting, so the
  predicate is preserved; control-named configured ID columns also work through
  quoted point reads. Discovery
  reports the complete declared primary key independently of the field budget
  and separates `idColumn.uniqueStatus` from `readable`. A real Chromium ->
  disposable PostgREST Playwright suite covers CORS, headers, native rows,
  multi-page short pages, bad credentials and caller abort.

### Patch Changes

- ef28cc4: Build `@dalgo/adapter-runtime` from the same commit inside `prepack`. A pnpm
  `github:` subdirectory dependency is prepared in its own fetched workspace copy,
  where the workspace-linked runtime had no `dist` yet, so installing either
  adapter from a Git subdirectory failed with `TS2307: Cannot find module
  '@dalgo/adapter-runtime'`. Packed tarball installs are unchanged; `prepack` now
  matches the existing `sqlite-wasm`/`d1` dependency-build order and the new
  `check:git-subdir-consumer` gate installs, type-checks and dynamically imports
  both adapters from a Git fetch.

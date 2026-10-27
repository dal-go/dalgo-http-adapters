---
"@dal-go/dalgo2libsql": minor
---

Migrate `@dal-go/dalgo2libsql` from the legacy `@dal-go/dalgo` package name to
the exact modern `@dalgo/core` 0.7.4 snapshot
`99165e9e1a39c32abee2b39d6395677843bc3559`, share
`@dalgo/adapter-runtime`, and keep the installed package name. The managed
`LibSQLDatabase` keeps its configured native-table CRUD and open position-value
cursor contract, now with bounded `getMany`, cancellation, integer/REAL keys and
the modern public `Database`/`WriteSession` identity.

Add `NativeLibSQLDatabase`, an explicit read-only allowlist over existing
tables/views with no `__dalgo_*`/`data` envelope: native string, safe-integer
and REAL IDs are preserved in `Key.id` and `metadata.id`, non-key fields stay
typed, and every mutation entry point refuses before I/O. BLOB values, unsafe
64-bit integers, numeric-string/text coercions and non-scalars are refused
explicitly.

Add caller cancellation through `queryWithSignal`, `getManyWithSignal` and
optional signals on reads/discovery, sharing one `createAbortScope` deadline
through header resolution, fetch, body decoding and page/batch work. Add hard
request/response/row/byte/page/cursor/metadata/parallel-read budgets; `getMany`
now uses a bounded fail-fast worker pool rather than unbounded `Promise.all`.

Add adapter-issued, single-use opaque keyset cursors bound to the endpoint,
table, key, filters, order, page size and credential scope, with malformed,
foreign, replay and changed-query refusal. Every non-empty page (including a
short one) continues; only an empty page is sticky EOF. Legacy `query` keeps its
open cursor positions. Add null-aware native keyset paging for nullable order
columns with a unique-key tie-breaker.

Add bounded read-only schema discovery over `pragma_table_list`,
`pragma_table_xinfo` and the index pragmas: fields, declared types/affinity,
nullability, primary keys, single-column unique-index proof, views and explicit
configured contracts. Unavailable/truncated metadata is distinct from an empty
database, and discovery never expands the query allowlist. Composite or
nullable keys, key-type contradictions and truncated metadata are reported as
non-queryable rather than guessed.

Require explicit `allowInsecureLoopbackHttp: true` for loopback HTTP. Keep
credentials header-only and memory-only, `redirect: "error"`, and redacted HTTP,
statement, request and cursor errors.

Verification adds account-free real and Chromium suites against the
commit-pinned `ghcr.io/tursodatabase/libsql-server:d6c75af` fixture with
ephemeral Ed25519 keys, an explicit `a: "ro"` reader token, a separate writer
token only for seeding and a real reader write probe. The packed and
source-only Git-subdirectory consumer gates now install and typecheck libSQL
public declarations, assert one `@dalgo/core` identity and reject any legacy
`@dal-go/dalgo` dependency. The fixture is local Hrana proof, not proof of hosted
Turso CORS, provisioning or production policy.

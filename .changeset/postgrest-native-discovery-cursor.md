---
"@dal-go/dalgo2postgrest": minor
---

Add account-free native PostgREST discovery and cursor paging: bounded
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
number checks refuse unsafe integers before emitting records or cursors.
Filters on reserved PostgREST query fields are refused before HTTP. Discovery
reports the complete declared primary key independently of the field budget
and separates `idColumn.uniqueStatus` from `readable`. A real Chromium ->
disposable PostgREST Playwright suite covers CORS, headers, native rows,
multi-page short pages, bad credentials and caller abort.

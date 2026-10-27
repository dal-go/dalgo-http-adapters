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

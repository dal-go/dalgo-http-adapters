---
"@dal-go/dalgo2couchdb": minor
---

Add an explicit read-only native application-document mode through
`NativeCouchDbDatabase` and `NATIVE_COUCHDB_READ_CAPABILITIES`. One configured
CouchDB database maps to one configured logical collection; existing documents
keep their string `_id` as the DALgo key and their `_id`/`_rev` fields, without a
`__dalgo_*` or `data` envelope. `get`, `getMany`, bounded Mango
`query`/`queryWithSignal`, optional explicit projections, configured-index-only
ordering with an `_id` tie-break, query/resource/instance/credential-bound
bookmark cursors, and bounded connection/index/field discovery are supported.
Every mutation entry point refuses before HTTP. The existing managed
`CouchDbDatabase` default API, behavior and tests are preserved.

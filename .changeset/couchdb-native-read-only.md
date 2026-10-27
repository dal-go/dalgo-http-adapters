---
"@dal-go/dalgo2couchdb": minor
---

Add an explicit read-only native application-document mode through
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

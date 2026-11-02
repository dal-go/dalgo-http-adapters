---
"@dalgo/dalgo2couchdb": minor
---

Bound existing native and managed reads from preflight and header acquisition
through decoding and final delivery with one monotonic deadline and caller
cancellation. Add point-read signal methods and managed batch signal support,
share aggregate batch byte budgets while preserving first safe failures, and
clean up late or unused bodies without waiting for hostile cancellation.
Preserve native ID/revision/index/discovery and managed MVCC behavior, validate
whole query pages before codecs, and scope opaque managed bookmarks to their
instance/query/page size. Qualify the canonical core 0.8.1 and public runtime
0.1.2 peer contract; this source change does not publish the package or qualify
hosted/browser/App behavior.

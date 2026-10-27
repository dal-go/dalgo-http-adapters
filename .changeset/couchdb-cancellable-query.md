---
"@dal-go/dalgo2couchdb": minor
---

Align the adapter with the modern `@dalgo/core` identity and add
`queryWithSignal(query, signal)`: caller cancellation now propagates through
header acquisition, fetch and response-body reads, combined with one end-to-end
deadline, with redacted caller-abort/deadline/transport errors and late-response
cleanup. Arbitrary transport `RangeError`s are redacted while adapter-owned
bounds diagnostics remain visible. Responses with more rows than the requested
query bound are rejected before decoding. Export honest managed-envelope
read/query capability constants. The existing `query` interface and success
behaviour are unchanged. Prepare the manifest for Changesets distribution
without publishing.

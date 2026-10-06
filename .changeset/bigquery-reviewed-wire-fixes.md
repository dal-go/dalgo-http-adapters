---
"@dalgo/bigquery": patch
---

Fix exact TIMESTAMP scalar/IN REST encoding, reject conflicting partition-filter
metadata, and enforce the approved LIMIT and totalRows invariants across page and
partial-page resume delivery. Preserve exact internal values and unresolved cost
reservations. Go request-vector validation remains a separate acceptance gate.

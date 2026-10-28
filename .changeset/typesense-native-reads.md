---
"@dal-go/dalgo2typesense": minor
---

Add `@dal-go/dalgo2typesense`, a bounded read-only native Typesense adapter for
the modern `@dalgo/core` contracts. It reads existing documents (string ids,
numerals, arrays and nulls preserved), supports an exact positive structured
query subset with a full-prefix verifier, typed native search/facets, exact-id
point and batch reads, opaque query-bound cursors, explicit metadata and
cancellable bounded HTTP. Negative structured predicates and unsupported shapes
are refused before I/O; native search keeps documented Typesense semantics.

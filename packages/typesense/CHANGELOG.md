# @dalgo/dalgo2typesense

## 0.2.0

### Minor Changes

- 41dc376: Add `@dalgo/dalgo2typesense`, a bounded read-only native Typesense adapter for
  the modern `@dalgo/core` contracts. It reads existing documents (string ids,
  numerals, arrays, explicit nulls and honest absences preserved), supports an
  exact positive structured query subset with a full-prefix verifier, typed native
  search/facets, exact-id point and batch reads, opaque query-bound cursors,
  explicit metadata and cancellable bounded HTTP. One per-physical-request header
  callback covers search and metadata; a pure `documents:search` credential is
  never upgraded to an admin or separate metadata fallback. Native full-text
  rankings are exposed as exact decimal strings rather than rounded numbers.
  Negative structured predicates and unsupported shapes are refused before I/O;
  native search keeps documented Typesense semantics.

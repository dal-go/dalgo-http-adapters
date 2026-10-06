# @dalgo/bigquery

## 0.2.0

### Minor Changes

- 21501c2: Add the core-free analytical client with guarded scalar SQL, reviewed native
  metadata checks, bounded lossless HTTP, one-shot approvals and durable shared
  budget/deadline ledgers. Submit one capped job without POST replay; preserve
  immutable receipts and same-job page/row cursors through Resume, explicit
  same-subject reconnect, status and truthful cancellation. Preserve the legacy
  record adapter; dual-core migration, frozen cross-runtime HTTP/state acceptance,
  consumer browser/CLI/live journeys and governed release wiring remain required.
- 31f65a8: Name the maintained package `@dalgo/bigquery` and add a core-free analytical
  foundation export with bounded lossless JSON parsing, exact typed scalar rows,
  named RFC8785 digest payloads and original-deadline bounds. Preserve the legacy
  record adapter behavior; the approval, transport, trusted ledger, job paging,
  dual-core migration and browser acceptance gates remain required before an A0
  adapter release can be claimed.
- ed37e3d: Add memory-only Google token authorization with fixed trusted discovery and
  same-token UserInfo subject verification. Refuse partial scopes, stale or
  expired authorization and unsafe identity responses; clear authorization on
  disconnect and advance principal generation after reconnection. Keep result
  rows and OAuth tokens out of the durable job ledger and clear closed row buffers.
  Deployed GIS, core compatibility, release wiring and live acceptance remain gates.

### Patch Changes

- d91f1fc: Fix exact TIMESTAMP scalar/IN REST encoding, reject conflicting partition-filter
  metadata, and enforce the approved LIMIT and totalRows invariants across page and
  partial-page resume delivery. Preserve exact internal values and unresolved cost
  reservations. Go request-vector validation remains a separate acceptance gate.

---
"@dalgo/bigquery": minor
---

Add memory-only Google token authorization with fixed trusted discovery and
same-token UserInfo subject verification. Refuse partial scopes, stale or
expired authorization and unsafe identity responses; clear authorization on
disconnect and advance principal generation after reconnection. Keep result
rows and OAuth tokens out of the durable job ledger and clear closed row buffers.
Deployed GIS, core compatibility, release wiring and live acceptance remain gates.

---
"@dalgo/bigquery": patch
---

Reject analytical row and page delivery when cancellation or the original deadline wins during durable ledger completion. Preserve acknowledged cursors, transport charges and the existing job when recovering an undelivered result. Release late injected fetch response bodies without waiting on cleanup.

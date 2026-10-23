---
"@dalgo/bigquery": patch
---

Also accept `@dalgo/core` 0.8: the peer is now `^0.1.0 || ^0.6.0 || ^0.8.0`. The release matrix tests every packed artifact against registry core 0.1.0, 0.6.0 and 0.8.0, and proves BigQuery shares one strict core instance with `@dalgo/http` on core 0.8 and with `@dalgo/ovdb` on core 0.6.

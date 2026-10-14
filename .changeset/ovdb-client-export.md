---
"@dalgo/ovdb": minor
---

Ship the CRUD client (`OpenVaultDbDatabase`, `OpenVaultDbHttpError`) as a new `@dalgo/ovdb/client` subpath export (`dist`), and widen the `@dalgo/core` peer range to `>=0.6.0 <0.9.0` so core 0.7.x satisfies it. The `.` and `./dtql` exports are unchanged.

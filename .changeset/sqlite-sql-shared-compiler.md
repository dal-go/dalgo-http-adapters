---
"@dalgo/sqlite-sql": minor
"@dalgo/d1": patch
---

Extract the DALgo-to-SQLite query compiler from `@dalgo/d1` into the new
`@dalgo/sqlite-sql` package so `@dalgo/d1` and `@dalgo/sqlite-wasm` share one
implementation. `@dalgo/d1` output SQL, bound values and error messages are
unchanged.

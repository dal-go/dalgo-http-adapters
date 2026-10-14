# @dalgo/d1

## 0.2.1

### Patch Changes

- ac9f4e9: Extract the DALgo-to-SQLite query compiler from `@dalgo/d1` into the new
  `@dalgo/sqlite-sql` package so `@dalgo/d1` and `@dalgo/sqlite-wasm` share one
  implementation. `@dalgo/d1` output SQL, bound values and error messages are
  unchanged.
- Updated dependencies [ac9f4e9]
  - @dalgo/sqlite-sql@0.1.0

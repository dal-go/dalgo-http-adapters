# @dalgo/d1

## 0.3.0

### Minor Changes

- ab8204e: Require `@dalgo/core` `>=0.8.0 <0.9.0`, the core release that renames DTQL to TugQL with no aliases. Earlier core lines no longer satisfy the peer. Use the TugQL names from core 0.8 with these adapters: `parseTugQLYaml` (formerly `parseDTQL`), `parseRecursiveTugQL`, `executeRecursiveTugQLQuery`, `executeJoinedTugQLQuery`, `executeSourceComposedJoinedTugQLQuery`, `isJoinedTugQLQuery`, `JoinedTugQLQuery` and `TugQLSchema`. The HTTP release gate now installs exact registry core 0.8.0.

### Patch Changes

- ac9f4e9: Extract the DALgo-to-SQLite query compiler from `@dalgo/d1` into the new
  `@dalgo/sqlite-sql` package so `@dalgo/d1` and `@dalgo/sqlite-wasm` share one
  implementation. `@dalgo/d1` output SQL, bound values and error messages are
  unchanged.
- Updated dependencies [ac9f4e9]
  - @dalgo/sqlite-sql@0.1.0

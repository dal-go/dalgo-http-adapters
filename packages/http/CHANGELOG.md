# @dalgo/http

## 0.2.0

### Minor Changes

- ab8204e: Require `@dalgo/core` `>=0.8.0 <0.9.0`, the core release that renames DTQL to TugQL with no aliases. Earlier core lines no longer satisfy the peer. Use the TugQL names from core 0.8 with these adapters: `parseTugQLYaml` (formerly `parseDTQL`), `parseRecursiveTugQL`, `executeRecursiveTugQLQuery`, `executeJoinedTugQLQuery`, `executeSourceComposedJoinedTugQLQuery`, `isJoinedTugQLQuery`, `JoinedTugQLQuery` and `TugQLSchema`. The HTTP release gate now installs exact registry core 0.8.0.

## 0.1.1

### Patch Changes

- 62077ee: Prepare the first public ECB daily XML adapter release with public access, packed licensing, and registry-only native browser consumer gates. Requires @dalgo/core 0.6.0 from npm before release.

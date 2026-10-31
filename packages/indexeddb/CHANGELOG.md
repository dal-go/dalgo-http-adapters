# @dalgo/indexeddb

## 0.4.1

### Patch Changes

- Scan configured collection stores through their unique primary-key cursors, avoiding duplicate collection-index traversal while preserving scope isolation, exact ordering, bounded page retention, and cancellation. Shared stores retain their scoped index scans.

## 0.4.0

### Minor Changes

- ab8204e: Require `@dalgo/core` `>=0.8.0 <0.9.0`, the core release that renames DTQL to TugQL with no aliases. Earlier core lines no longer satisfy the peer. Use the TugQL names from core 0.8 with these adapters: `parseTugQLYaml` (formerly `parseDTQL`), `parseRecursiveTugQL`, `executeRecursiveTugQLQuery`, `executeJoinedTugQLQuery`, `executeSourceComposedJoinedTugQLQuery`, `isJoinedTugQLQuery`, `JoinedTugQLQuery` and `TugQLSchema`. The HTTP release gate now installs exact registry core 0.8.0.

## 0.3.0

### Minor Changes

- e14b17e: Stream selected records through IndexedDB cursors and retain only bounded query pages. Add per-query exact numeric field hints and cancellation for imported decimal and wide-integer values.

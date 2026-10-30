# @dalgo/firestore

## 0.4.0

### Minor Changes

- 356b497: Add read-only TugQL execution through `runFirestoreTugQL` (also exported from
  the write-free `@dalgo/firestore/tugql` entry). A TugQL `schema` is read as a
  Firestore parent document path (`firestoreParentKey`, `firestoreTugQLSource`);
  an odd segment count is refused, naming the path, before any read. `__key__` is
  the document id column, usable in SELECT, WHERE and ORDER BY, and a query whose
  only condition is `__key__ = <value>` reads that one document.
- 2a5cb95: `runFirestoreTugQL` runs a single-collection TugQL query as one Firestore query carrying its WHERE, ORDER BY and LIMIT (plus OFFSET), so Firestore reads only matching documents. A query it cannot express that way (OR, JOIN, subquery, GROUP BY, NULL or non-primitive comparisons, Firestore's `in`/`not-in`/`!=` limits) now fails before any read with a `FirestoreTugQLRefusedError` (`code: "in_memory_evaluation"`, `path`, `reason`) unless `allowInMemoryEvaluation: true` is passed, which keeps the previous in-memory evaluation. LIMIT plus OFFSET over `maxFetchedRows` fails with `query_limit` before any read. New exports: `planFirestoreTugQL`, `FirestoreTugQLRefusedError`, `FirestoreTugQLReader` (the injectable `reader` option).

## 0.3.0

### Minor Changes

- ab8204e: Require `@dalgo/core` `>=0.8.0 <0.9.0`, the core release that renames DTQL to TugQL with no aliases. Earlier core lines no longer satisfy the peer. Use the TugQL names from core 0.8 with these adapters: `parseTugQLYaml` (formerly `parseDTQL`), `parseRecursiveTugQL`, `executeRecursiveTugQLQuery`, `executeJoinedTugQLQuery`, `executeSourceComposedJoinedTugQLQuery`, `isJoinedTugQLQuery`, `JoinedTugQLQuery` and `TugQLSchema`. The HTTP release gate now installs exact registry core 0.8.0.

---
"@dalgo/firestore": minor
---

`runFirestoreTugQL` runs a single-collection TugQL query as one Firestore query carrying its WHERE, ORDER BY and LIMIT (plus OFFSET), so Firestore reads only matching documents. A query it cannot express that way (OR, JOIN, subquery, GROUP BY, NULL or non-primitive comparisons, Firestore's `in`/`not-in`/`!=` limits) now fails before any read with a `FirestoreTugQLRefusedError` (`code: "in_memory_evaluation"`, `path`, `reason`) unless `allowInMemoryEvaluation: true` is passed, which keeps the previous in-memory evaluation. LIMIT plus OFFSET over `maxFetchedRows` fails with `query_limit` before any read. New exports: `planFirestoreTugQL`, `FirestoreTugQLRefusedError`, `FirestoreTugQLReader` (the injectable `reader` option).

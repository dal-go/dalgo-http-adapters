---
"@dalgo/firestore": minor
---

Add read-only TugQL execution through `runFirestoreTugQL` (also exported from
the write-free `@dalgo/firestore/tugql` entry). A TugQL `schema` is read as a
Firestore parent document path (`firestoreParentKey`, `firestoreTugQLSource`);
an odd segment count is refused, naming the path, before any read. `__key__` is
the document id column, usable in SELECT, WHERE and ORDER BY, and a query whose
only condition is `__key__ = <value>` reads that one document.

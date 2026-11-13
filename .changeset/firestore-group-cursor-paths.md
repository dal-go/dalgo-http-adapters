---
"@dalgo/firestore": patch
---

Collection-group query cursors now carry full document paths instead of leaf document ids, and the adapter captures the query source kind before the asynchronous fetch so a later caller mutation cannot change cursor semantics. Cursors for regular root and nested collections continue to use leaf document ids.

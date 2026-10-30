---
"@dalgo/adapter-runtime": patch
"@dalgo/dalgo2couchdb": patch
"@dalgo/dalgo2libsql": patch
"@dalgo/dalgo2postgrest": patch
"@dalgo/dalgo2typesense": patch
"@dalgo/firestore": patch
"@dalgo/ovdb": patch
---

Prepare a fresh coordinated release after correcting the four unpublished native adapter package names to the `@dalgo` npm scope. Include the shared adapter runtime, Firestore and OVDB in normal version-change publication so the complete prepared compatibility batch can be released through the reviewed version pull request.

---
"@dalgo/sqlite-wasm": patch
---

`/opfs`: unlink pool files before importing them, so reset works after the
working copy grew and a crash mid-import never leaves a half-written file;
replace the working copy only when it is damaged (`DatasetStorageError`
otherwise); keep edits when only the pristine copy is missing. A pool that
stays locked fails with a retriable error instead of silently using memory
(`memoryFallbackWhenLocked` opts in); `locks: null` requires
`storage: "memory"`, and browsers without Web Locks use memory. UNIQUE
conflicts on non-key columns are `ConstraintViolationError("unique")`, not
`AlreadyExistsError`. `@dalgo/sqlite-sql` is now a peer, and the package
installs and builds from a GitHub path.

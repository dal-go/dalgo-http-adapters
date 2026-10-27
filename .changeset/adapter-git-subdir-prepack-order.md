---
"@dal-go/dalgo2couchdb": patch
"@dal-go/dalgo2postgrest": patch
---

Build `@dalgo/adapter-runtime` from the same commit inside `prepack`. A pnpm
`github:` subdirectory dependency is prepared in its own fetched workspace copy,
where the workspace-linked runtime had no `dist` yet, so installing either
adapter from a Git subdirectory failed with `TS2307: Cannot find module
'@dalgo/adapter-runtime'`. Packed tarball installs are unchanged; `prepack` now
matches the existing `sqlite-wasm`/`d1` dependency-build order and the new
`check:git-subdir-consumer` gate installs, type-checks and dynamically imports
both adapters from a Git fetch.

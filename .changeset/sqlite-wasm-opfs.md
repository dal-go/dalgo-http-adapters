---
"@dalgo/sqlite-wasm": minor
---

Add `@dalgo/sqlite-wasm/opfs` and `@dalgo/sqlite-wasm/opfs/worker`: editable
demo datasets persisted in OPFS with sqlite-wasm's `opfs-sahpool` VFS in a
dedicated worker (no COOP/COEP needed). Pinned canonical files (optionally
gzip in parts) are verified by size and SHA-256, kept as a working and a
pristine copy, checked with `PRAGMA quick_check`, replaced when the pin
changes (`replacedPreviousVersion`), and restored by `reset()`. Without OPFS
the dataset runs in memory (`persistent: false`, typed `fallback`). One tab
per dataset leads through a Web Lock and serves the others over a
`BroadcastChannel`, with a generic request channel and `MessagePort`-shaped
endpoints; a waiting tab takes over when the leader goes away.

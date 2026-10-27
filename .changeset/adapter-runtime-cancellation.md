---
"@dalgo/adapter-runtime": patch
---

Add `@dalgo/adapter-runtime`, a browser-safe shared contract for DALgo
TypeScript adapters: the optional `CancellableQueryExecutor.queryWithSignal`
surface, redacted caller-abort/deadline handling, targeted abort/listener/timer
helpers, and explicit read/query capability descriptor types. The package also
ships a provider-neutral JSON conformance fixture. This is its first release
preparation; npm publication remains a separate owner gate.

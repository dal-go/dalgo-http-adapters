---
"@dalgo/sqlite-wasm": minor
---

`/opfs` fixes and options for consumers of large demo datasets:

- Bridge ports (`session.connect()` and the ports the leader serves) keep
  listeners per event type, like `EventTarget`: `message` listeners get only
  messages, and `close` is dispatched once when the port closes, its session
  closes or fails, or (served ports) the tab left or the leader stepped
  down. A `close` listener (as `@openvaultdb/inprocess` `fetchOverPort`
  registers) no longer runs on every message and disposes the fetch after
  its first answer. A leader change still does not close a tab's port.
- `onProgress` (`openDemoDb`, `openLeaderDatabase`, `serveDemoDbWorker`):
  throttled `{ phase, loaded?, total? }` events for `fetch`, `verify`,
  `importPristine`, `importWorking` and `open`, sent from the worker.
- Typed errors survive the worker and tab boundaries: `DatasetStorageError`
  (`operation`), `PoolUnavailableError` (`reason`, `retriable`),
  `CanonicalFetchError` (`status`), `CanonicalIntegrityError`,
  `CorruptDatabaseError` and `DemoDbConfigError` are rebuilt as their class,
  with the cause's name and message.
- `memoryFallback: "forbid"` fails with `PoolUnavailableError` before any
  download where OPFS cannot be used (default `"allow"`).
- `storagePolicy: "single-copy"` keeps only the working copy in OPFS; reset
  downloads and verifies the pin again (default `"working-and-pristine"`).

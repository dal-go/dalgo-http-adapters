# @dalgo/sqlite-wasm

## 0.1.0

### Minor Changes

- b2226e8: Add `@dalgo/sqlite-wasm`: a read-write DALgo database over one SQLite
  connection with `createSqliteDatabase`, a `fromOo1Db` driver for
  `@sqlite.org/sqlite-wasm`, schema introspection, capabilities, optional reset,
  and mapping of SQLite constraint failures to DALgo errors.
- 1eaa5ce: `/opfs` fixes and options for consumers of large demo datasets:
  
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
- 490f3f8: Add `@dalgo/sqlite-wasm/opfs` and `@dalgo/sqlite-wasm/opfs/worker`: editable
  demo datasets persisted in OPFS with sqlite-wasm's `opfs-sahpool` VFS in a
  dedicated worker (no COOP/COEP needed). Pinned canonical files (optionally
  gzip in parts) are verified by size and SHA-256, kept as a working and a
  pristine copy, checked with `PRAGMA quick_check`, replaced when the pin
  changes (`replacedPreviousVersion`), and restored by `reset()`. Without OPFS
  the dataset runs in memory (`persistent: false`, typed `fallback`). One tab
  per dataset leads through a Web Lock and serves the others over a
  `BroadcastChannel`, with a generic request channel and `MessagePort`-shaped
  endpoints; a waiting tab takes over when the leader goes away.

### Patch Changes

- 835560d: `/opfs`: unlink pool files before importing them, so reset works after the
  working copy grew and a crash mid-import never leaves a half-written file;
  replace the working copy only when it is damaged (`DatasetStorageError`
  otherwise); keep edits when only the pristine copy is missing. A pool that
  stays locked fails with a retriable error instead of silently using memory
  (`memoryFallbackWhenLocked` opts in); `locks: null` requires
  `storage: "memory"`, and browsers without Web Locks use memory. UNIQUE
  conflicts on non-key columns are `ConstraintViolationError("unique")`, not
  `AlreadyExistsError`. `@dalgo/sqlite-sql` is now a peer, and the package
  installs and builds from a GitHub path.
- Updated dependencies [ac9f4e9]
  - @dalgo/sqlite-sql@0.1.0

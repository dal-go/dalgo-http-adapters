# MongoDB for DALgo

Read-only TypeScript access to existing MongoDB documents through a Node driver
executor and a browser-safe trusted HTTP client. This source slice is unreleased.
The coordinator's isolated Linux checks passed lint, strict types, 21 focused
tests, build and browser bundle inspection for the adapter source. The owned
MongoDB 8.0.17 service-only fixture also passed. Standalone browser acceptance
and an integrated DataTug web journey remain separate pending gates.

Use `@dalgo/dalgo2mongodb/node` only on a trusted Node server. The package root
and `/browser` entry import no MongoDB driver or Node builtin. Selecting a MongoDB
connection in an app must lazily load the browser entry; the server driver must
never enter any browser chunk.

```ts
// Trusted Node application: create/close MongoClient in the host's normal lifecycle.
import { MongoClient } from "mongodb";
import { MongoNodeExecutor, createMongoHttpHandler } from "@dalgo/dalgo2mongodb/node";

const client = new MongoClient(process.env.MONGO_READ_URI!, {
  maxPoolSize: 4, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
});
const executor = new MongoNodeExecutor({
  database: client.db("existing_app"),
  collections: { products: "existing_products" },
  maxRows: 100, maxPages: 20,
});

const handle = createMongoHttpHandler({
  authorize: async (request, connectionId, signal) => {
    // Host must verify user identity, origin/CSRF, rate limits and permission
    // for this saved connection using its established authorization service.
    const permitted = await myExistingAuthorization(request, connectionId, signal);
    return permitted ? executor : undefined;
  },
});
// Mount `handle` at a fixed authenticated route in the host's HTTP framework.
```

`authorize` is mandatory. It returns an already bound executor for the saved
connection, or denies it. The client cannot select a MongoDB URI, database,
credentials, physical collection or arbitrary command. No anonymous fallback or
CORS wildcard is installed. Keep secrets in the host's secret references and
use a server-enforced read-only MongoDB principal. Application validation is an
additional capability boundary, not a replacement for provider authorization.

```ts
// Browser application: credentials here belong to the trusted app, not MongoDB.
import { MongoDatabase, MongoHttpClient } from "@dalgo/dalgo2mongodb/browser";
import { collection } from "@dalgo/core";

const transport = new MongoHttpClient({
  endpoint: "/api/database/mongo", connectionId: "saved-read-connection",
  headers: () => myShortLivedAppAuthHeaders(),
});
const db = new MongoDatabase(transport); // Explicit default core key kind: ObjectId.
const products = collection("products");
const controller = new AbortController();
const page = await db.queryWithSignal(products.query().limit(25).build(), controller.signal);
if (page.nextCursor !== undefined) {
  await db.queryWithSignal(products.query().limit(25).startAfter(...page.nextCursor.values).build(), controller.signal);
}
```

The actual modern `@dalgo/core` Database facade implements `get`, serial bounded
`getMany`, `query` and additive `queryWithSignal`. Core IDs are canonical lowercase
hexadecimal ObjectId strings by default; configure `idKind: "string"` for existing
string `_id` values. Other native BSON identity types are retained by native
`execute()` but explicitly refused by the core record facade. Document data is
never wrapped/replaced with a DALgo storage envelope. Nested collections, writes,
callback transactions, joined queries, offsets and arbitrary ordering are refused.

Native `execute({kind: "find", collection, filter, limit, after?}, signal)` accepts
a bounded predicate subset (`$and`, `$or`, `$nor`, equality/range/membership and
`$exists`), sorts by unique `_id` ascending, reads at most `limit + 1` documents,
and returns only a signed, query-bound keyset continuation. Continuations have a
fixed expiry and page ceiling. The server HMAC key stays private; share a stable
key only between trusted executor instances serving the same authorization scope.
Replays/new queries still require host rate limits. Concurrent writes can affect
later pages; this API does not claim snapshot isolation across separate requests.

Native read-only aggregation accepts only `$match`, simple numeric `$project`,
`$sort` and `$limit`; it never accepts `$out`, `$merge`, `$lookup`, `$unionWith`,
JavaScript, arbitrary expressions or regular expressions. It appends a server
limit, disables disk use, and rejects overflow instead of silently returning a
truncated result. Aggregation has no continuation capability.

Results use canonical Extended JSON: int64/decimal/ObjectId/date/binary retain
their exact tags and values. Browser consumers can display those tags or use an
explicit codec. Ordinary BSON integer/double fields also retain canonical tags;
they are not silently coerced to JavaScript numbers. Metadata reports configured
logical collections, explicitly not automatic database discovery.
`testConnection(collection)` issues a real bounded read; `discover()` alone does
not prove MongoDB transport/authentication.

All requests have finite deadlines, row/request/response/page limits. Abort races
cover request bodies, headers, transport, cursor reads and authorization; Node
passes the signal to the driver and closes its cursor. Server `maxTimeMS` and
cursor close are attempted, but actual remote cancellation still needs real
service proof. Driver/auth/HTTP errors are redacted and never include provider
messages, MongoDB URIs, query contents or abort reasons. The host owns the
MongoClient/pool lifecycle, read-only credentials, TLS, upstream connection timeouts
and concurrency admission.

Pending delivery gates: standalone browser qualification over the real local HTTP
bridge; authenticated app integration/reopen/invalid-auth
journey; independent exact-head review; public npm release and clean consumer.
No Apps UI or shared workspace/lockfile edits are included in this package lane.

`npm run test:real` is an owned, synthetic local-service fixture, run only by the
coordinator after a normal build inside the capped Linux namespace. It refuses
unbounded memory/CPU/PID limits or swap, and starts its own loopback-only `mongod`
with a 256 MiB WiredTiger cache. It creates temporary admin/read-only users and
seven native BSON documents, then closes clients, terminates that exact child
and removes only its owned data directory. No hosted accounts or production data
are involved.

The controller supplies these immutable runtime inputs:

- `MONGO_FIXTURE_SOURCE`: official MongoDB Ubuntu 24.04 x86_64 binary archive URL
  suffixed with `@sha256:<archive checksum>`; this describes a binary archive,
  not a Docker image.
- `MONGO_SERVER_BINARY`: absolute path to the supplied executable and its required
  shared-library closure; Ubuntu 24.04 MongoDB bytes require a matching Noble runtime.
- `MONGO_SERVER_SHA256`: SHA-256 of that executable, verified before execution.
- `MONGO_SERVER_VERSION`: exact `8.0.<patch>` version, checked against `--version`.
- `MONGO_FIXTURE_ROOT`: writable, disk-backed, exclusively owned scratch directory,
  such as `/work`; WiredTiger data must not use the small `/tmp` tmpfs.
- Optional `MONGO_FIXTURE_PORT`: private loopback port, default `17017`; never
  publish it to the host.

The external receipt must also bind the actual container runtime image, official
source archive URL and checksum to the extracted executable. The script's digest check alone does not authenticate
where the controller obtained those bytes. Run the fixture with a finite outer
timeout, for example `timeout --signal=TERM --kill-after=3s 90s npm run test:real`;
the controller removes the exact owned container even on timeout.

The fixture checks configured metadata (not automatic discovery), exact canonical
Extended JSON int64/decimal/binary/date values, mixed BSON `_id` paging, bounded
query/aggregation refusals, signed cursor binding/expiry/page caps, provider-enforced
read-only grants and invalid authentication. Caller cancellation waits for the
owned server's `waitForFailPoint` counter to prove the `find` was dispatched; the
deadline case also checks server entry. Both then reopen a real read. Failure
injection is issued only by the temporary fixture admin. MongoDB 8.0.17's
test-only `configureFailPoint` and `waitForFailPoint` APIs deliberately bypass
authentication when enabled; they do not prove an authorization boundary. This
test-enabled instance stays private to the owned container and loopback interface;
never enable those APIs on a production service. The read-only principal is
instead denied real `insertOne` and `createUser` operations, whose production
privileges are absent from its `read` role. This proves local cancellation/reopen,
not independent observation of a remote kill.

Provider contracts: [pinned 8.0.17 test-command authorization source](https://github.com/mongodb/mongo/blob/r8.0.17/src/mongo/db/commands/fail_point_cmd.cpp),
[createUser required access](https://www.mongodb.com/docs/manual/reference/command/createuser/#required-access)
and [built-in read role](https://www.mongodb.com/docs/manual/reference/built-in-roles/#read).

The final HTTP round trip uses the browser-safe TypeScript client with an
in-process Fetch-compatible handler against the real driver. It is not a network
or Chromium/App journey. Qualify an actual browser separately after measuring the
service-only run's memory and PID headroom; do not add Chromium to an unmeasured
MongoDB run or raise the agreed resource limits.

`npm run test:browser` enables an optional standalone Chromium stage in that same
owned service lifecycle. It requires the pinned Playwright 1.64.1 package and
the matching already cached Chromium (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
in the coordinator's pinned Noble image). The script never downloads a browser
or creates a second MongoDB. The optional helper builds the public browser entry
with esbuild and rejects Node driver/builtin inputs, then serves a fixed loopback
HTTP route through the actual `createMongoHttpHandler` and read-only executor.
Synthetic application authorization is mandatory; provider credentials remain
only on the Node host.

The fixture bridge maps an aborted incoming request or an unfinished response
connection close to `Request.signal`; ordinary completed request-body `close`
events do not cancel a live query. The browser checks exact typed document data,
configured metadata, bounded query paging, invalid application/provider auth and
endpoint-injection refusal. A host-owned failpoint proves the browser query
reached MongoDB before caller abort, and the bridge's actual disconnect abort is
observed. A shorter server deadline also crosses real HTTP as a redacted deadline
error. Each cancellation is followed by a fresh read. One page/context/browser is
used, with one renderer; memory/PID samples are recorded before/during/after,
including kernel `pids.peak` when available. The parent first prepares that one
browser/context/blank page, then starts MongoDB, and finally navigates the same
page to the real bridge. It closes the browser from the parent lifecycle's
`finally` even if MongoDB startup or an earlier assertion fails. No second
browser/context/page is created after the service starts. Fixture clients use
`maxPoolSize: 1` and `maxConnecting: 1` for their serialized operations; admin,
reader and bad-auth principals remain separate. These are fixture limits, not
production client defaults. Stage observations include browser-ready,
MongoDB-ready, principals-ready, service-assertions-passed, reopen and browser-close.
Root admission must check PID
headroom as well as memory before launch; a PID ceiling failure is not grounds
for an unchanged retry or a higher cap.

This optional source fixture remains unqualified until its exact frozen source
passes in the coordinator's single 2 GiB/zero-swap/2-CPU/128-PID slot. Its result
would prove a standalone SDK/HTTP/browser path, not an application UI, shared
Query Editor, deployed integration, registry release or independently observed
remote kill. Service-only `test:real` keeps its existing assertions when the
browser flag is absent. Earlier service-first browser attempts reached the
128-PID ceiling; they do not qualify actual browser execution. Preparing the
renderer before MongoDB is a different, still unqualified lifecycle attempt.

Official API references: [MongoDB cursor iteration and abort](https://www.mongodb.com/docs/drivers/node/current/crud/query/cursor/),
[driver connection options](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/),
[Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/).

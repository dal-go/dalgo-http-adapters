# Native Convex public query functions

This adapter reads existing application data through **explicitly configured
public Convex query functions**. It does not open arbitrary tables, install a
DALgo envelope, discover schemas or expose admin credentials. A collection's
configured get function must return an existing native document or `null`;
a paginated function must return the ordinary Convex pagination result.

```ts
import { Key } from "@dalgo/core";
import { ConvexDatabase } from "@dalgo/dalgo2convex";

const db = new ConvexDatabase({
  endpoint: "https://your-deployment.convex.cloud",
  token: async signal => obtainUserJwt(signal),
  collections: {
    tasks: {
      getFunction: "dalgo:getTask",
      staticArgs: { tenant: "user-1" },
      fields: [{ name: "amount", type: "int64" }],
    },
  },
  queries: {
    tasks: {
      path: "dalgo:listTasks", collection: "tasks",
      staticArgs: { tenant: "user-1" },
    },
  },
});
const record = await db.get(new Key("tasks", existingConvexId));
const page = await db.queryFunction("tasks", {}, { pageSize: 20, signal });
const next = page.nextCursor === undefined ? undefined
  : await db.queryFunction("tasks", {}, { pageSize: 20, cursor: page.nextCursor, signal });
```

The configuration, manifest and static scope arguments are trusted saved
configuration; caller query input cannot choose a URL/function or override fixed
arguments. Dynamic argument names must be listed in the query binding's
`arguments` array. Native keys are strings, top-level collections only. The
adapter checks returned get identity and refuses duplicate page identities.
`exists(key, signal?)` and `testConnection(key, signal?)` execute the same
configured get query; a missing key is a successful authorized response.

`getMany` is sequential and preserves input order, duplicates and missing
positions. It copies all admitted key identities before token/codec callbacks.
`getWithSignal` and `getManyWithSignal` add caller cancellation without
changing modern DALgo core interfaces. Default identity decoding preserves
native values; caller codecs remain responsible for any deliberate conversion.

`metadata()` lists configured collection/field and query aliases with
`provenance: "trusted-configuration"`, `dynamicDiscovery: false` and
`authorizationVerified: false`. It is not a server permission/schema probe.
Generic DALgo StructuredQuery/TugQL, writes, transactions, reactive subscriptions
and automatic discovery are **NOT_IMPLEMENTED** by this adapter. This does not
claim Convex lacks those capabilities.

## Transport, authorization and fidelity

Only POST `/api/query` on a fixed root HTTPS endpoint is used. Credentials,
query parameters, fragments, custom paths and redirects are refused; ambient
cookies are omitted. Explicit `allowInsecureLoopbackHttp` is restricted to
literal `127.0.0.1`/`[::1]` owned fixtures. Fetch is borrowed, never destroyed.
Constructor and configured metadata do no network/token/engine work.

Authentication uses a user bearer JWT supplied within the operation deadline.
There is no `Convex <admin-key>` mode. Anonymous execution requires explicit
`allowAnonymous: true` with no token, and is never a fallback after auth
failure. Server functions must independently validate arguments and enforce
`ctx.auth` authorization; a configured tenant argument is not authorization.
The functions in [examples/convex](./examples/convex) illustrate both checks.

The public `convex/values` codec from pinned `convex@1.49.0` is used with
the official client's `convex_encoded_json` request envelope. Signed int64
values remain `bigint`, bytes remain copied `ArrayBuffer`, IEEE float64
specials and negative zero remain numbers, and nested values retain their
native types. The lossy HTTP guide `json` representation is not used. Maps,
sets, Dates, unresolved commit-timestamp placeholders, undefined values,
accessors, custom iterators, malformed tags/base64, invalid Unicode and unknown
native types are refused without copying their contents into errors.
Legitimate own data fields named `constructor` and `prototype` are
preserved, including nested records. They remain refused as control option or
top-level argument names. The adapter currently refuses `__proto__` data
members for safe decoding; this is an adapter limitation, not a statement that
Convex cannot store that field. Native records may have a null prototype;
their own native values, not an Object.prototype identity, are the contract.

Provider error messages, errorData, logLines, status bodies, auth failure causes
and `AbortSignal.reason` are never emitted or attached as a cause. Failures
use `ConvexReadError.code` or the shared `QueryCancelledError.reason`.

## Pagination and limits

The deployed function must forward `paginationOpts` to `.paginate()`.
The adapter passes `numItems`, `cursor`, `maximumRowsRead` and
`maximumBytesRead`. `numItems` is not a work guarantee: over-returned
pages, repeated cursors, duplicate IDs and pages requesting splits are refused
whole, never truncated or treated as final. Empty unfinished pages with an
advancing cursor are valid. This initial adapter refuses both SplitRequired and
SplitRecommended; it does not implement reactive page-range splitting.

Returned cursors are bounded instance-issued handles, tied to the exact
function, arguments, collection, page size and a private user-token fingerprint.
They are not server cursors, authorization tokens, snapshots or portable across
adapter reopen. JWT rotation invalidates existing continuations. Use the same
instance/query and omit `cursor` to start a fresh traversal.

A continuation carries a cumulative page/request/response/row/work journal.
Failed attempts retain incurred bytes/attempts/work, while leaving the previous
server position and acknowledged IDs unchanged. The cursor is advanced only at
the final successful delivery boundary. A failure may exhaust its budget and
require a deliberate new traversal; no automatic retry or silent reset occurs.

Defaults (hard maxima in parentheses):

| Bound | Default |
| --- | --- |
| Whole operation deadline | 30 s (120 s) |
| Parsed returned rows, including GetMany duplicates | 1000 (10000) |
| GetMany keys | 100 (1000) |
| HTTP requests/pages per operation or cursor journal | 100 (1000) |
| Aggregate response bytes | 4 MiB (16 MiB) |
| One encoded request / aggregate requests | 64 KiB / 1 MiB (1 MiB / 16 MiB) |
| Requested maximumRowsRead reservation | 1000/page, 10000/journey (10000/page, 100000/journey) |
| Requested maximumBytesRead | 1 MiB/page (4 MiB) |
| Active operations / cursor registry | 4 / 128 (16 / 1024) |
| Cursor lifetime | 5 min (10 min), never extended by paging |

Read-work reservations bound requested budgets and request counts; actual
database work depends on the trusted server function forwarding the options and
Convex enforcing them. They are not measured RU/cost or remote cancellation
proof. Native values are limited to 16 levels/8192 array values/1024 object
members, with additional bounded wire parsing. The monotonic whole-operation
deadline starts before argument/key copying and includes async token,
fingerprint, request/body, official codec, caller decode and final cleanup.
Synchronous callbacks cannot be preempted; late results are refused afterward.
HTTP abort requests transport cancellation, without asserting remote query
termination. Late response/body cancellation is nonblocking and rejection-safe.
An aborted public call releases its cursor reservation immediately but retains
its concurrency lease until every tracked borrowed token/fetch/read/fingerprint
promise physically settles. Repeated aborts therefore cannot create unbounded
detached work. A permanently hostile promise can exhaust admission until a new
adapter is opened; public cancellation and `close()` never wait for it.

## Account-free local example and verification scope

Convex documents [anonymous local development](https://docs.convex.dev/cli/local-deployments).
Copy the schema/functions into an owned disposable Convex app; the normal CLI
generates `./_generated/server` during deployment. Configure a fixture user
JWT provider and trusted auth issuer/audience for the shown authenticated queries.
Seed data only through a separate owned setup step. Local setup/admin material
must stay outside the adapter and browser. No account, cloud deployment or paid
resource is required to author this contract.

Source unit/HTTP fixtures and the browser graph guard are separate from a real
local deployed backend, clean packed Node/DOM consumer, actual browser and hosted
authorization/CORS acceptance. Those runtime/release/App/deployment gates remain
UNVERIFIED until their own receipts exist. No installed/released adapter claim
follows from branch publication.
Producer and clean consumer profiles keep `skipLibCheck: false`. Development
Node declarations use the repository-qualified `@types/node@26.6.5` with
TypeScript 6. The Node runtime minimum is **22.0.0**, matching the mandatory
`convex@1.49.0` dependency's engine requirement. Execution qualification is
on **Node 24.22.2**; the minimum declaration does not claim an actual Node 22
runtime run. A declaration package version likewise does not imply that Node 26
or an older incompatible declaration package was executed or qualified.

Primary contracts: [HTTP API](https://docs.convex.dev/http-api/),
[official HTTP client](https://github.com/get-convex/convex-js/blob/fbb97090685455757c7f523646ed994884f3d6dd/src/browser/http_client.ts),
[pagination](https://docs.convex.dev/database/pagination).

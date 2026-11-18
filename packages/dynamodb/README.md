# DALgo adapter for Amazon DynamoDB

`@dal-go/dalgo2dynamodb` implements a deliberately bounded subset of the
`@dalgo/core` database contracts on
the official modular AWS SDK for JavaScript v3 document client.

It is designed for browser applications that receive **temporary,
least-privilege AWS credentials** (normally through Amazon Cognito or web
identity federation). It does not obtain credentials and must never be given
an IAM user access key or another long-lived server credential.

## Qualification

| Capability | DynamoDB through this adapter |
| --- | --- |
| HTTP data plane | Yes — DynamoDB API requests signed by AWS SDK v3/SigV4 |
| Read / insert / update / delete | Yes — `GetItem`, `BatchGetItem`, conditional `PutItem`, `UpdateItem`, `DeleteItem` |
| Query/filter | Yes — partition-key `Query` plus DynamoDB filter expressions |
| Aggregation | No generic DALgo aggregation mapping |
| Transactions | DynamoDB has `TransactWriteItems`, but DALgo callback transactions are rejected because its read/write callback and retry semantics cannot be preserved honestly |
| Streaming / realtime | Not implemented; DynamoDB Streams is a server-side event-source integration, not browser realtime |
| Browser CORS | Browser JavaScript is supported by AWS SDK v3; requests still need network access to AWS endpoints and correctly signed credentials |
| Browser-safe authentication | Yes, with narrowly scoped, expiring Cognito or web-identity credentials |
| Official JS/TS SDK | Yes — `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` |
| Server credentials required | No; long-lived credentials are specifically unsafe in browser code |

AWS documents Cognito as the recommended way to issue temporary credentials to
web/mobile apps and documents the JavaScript v3 document client as the native
JavaScript-object abstraction over DynamoDB's wire values. See [Cognito
credentials for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Cognito.Credentials.html),
[web identity federation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WIF.RunningYourApp.html),
and the [SDK v3 document-client guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-dynamodb-doc-client.html).

Browser readiness is conditional: this adapter receives an already-constructed
AWS client and cannot inspect or enforce the client's credential source, IAM
policy, table policy, session expiry, or browser network policy. It is safe in
a browser only when the application supplies short-lived, least-privilege
Cognito/web-identity credentials and scopes table access correctly.

## Install

The monorepo package remains private, named `@dal-go/dalgo2dynamodb` at
`0.1.0`. This source slice uses the public `@dalgo/core` `0.8.1` identity and
cancellation helpers available in public `@dalgo/adapter-runtime` `0.1.2`.
It does not publish a package, rename it, generate a private Changesets version
or establish registry/hosted/browser availability. The injected AWS SDK peers
remain unchanged; clean-consumer and runtime receipts are separate gates.

## Required table layout

This adapter owns a small physical layout rather than guessing an application's
existing DynamoDB single-table schema. Create a table with two string key
attributes (the default names are `pk` and `sk`):

| Attribute | Stored value |
| --- | --- |
| `pk` | DALgo `key.collectionPath`, for example `spaces/s1/items` |
| `sk` | DALgo `key.path`, for example `spaces/s1/items/milk` |
| `__dalgo_id` | Original DALgo key ID, needed to reconstruct query records |
| `data` | The codec-encoded DALgo document object |

`partitionKey`, `sortKey`, `idAttribute`, `dataAttribute`, and
`maxQueryPages` are configurable when constructing the adapter. Attribute
names must be distinct. Codec output must be a non-null object and may not
contain `undefined` values.

## Browser setup

Create AWS credentials outside this package, using a Cognito identity pool or
web identity federation, and scope its IAM policy to the one table and the
specific `dynamodb:GetItem`, `BatchGetItem`, `PutItem`, `UpdateItem`,
`DeleteItem`, and `Query` actions your app needs.

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collection } from "@dalgo/core";
import { DynamoDbDatabase } from "@dal-go/dalgo2dynamodb";

const lowLevelClient = new DynamoDBClient({
  region: "eu-west-1",
  // credentials: a caller-owned, short-lived Cognito/web-identity provider
});
const client = DynamoDBDocumentClient.from(lowLevelClient);
const db = new DynamoDbDatabase(client, { tableName: "app-dalgo" });

const items = collection<{ done: boolean; title: string }>("items");
await db.insert(items.key("milk"), { done: false, title: "Buy milk" });
```

The example intentionally omits credential values. Do not put access keys,
session tokens, secrets, or authorization headers in source control, URLs,
analytics, or browser storage.

The complete, type-checked example is [examples/basic.ts](examples/basic.ts).

## Bounded cancellable reads

Existing `get`, `getMany`, `query` and CRUD signatures remain. Additive
`getWithSignal(key, signal, codec?)`, `getManyWithSignal(keys, signal, codec?)`
and `queryWithSignal(query, signal)` provide caller cancellation without changing
the core interface. The query entry implements `CancellableQueryExecutor`.

Each read starts one deadline before `SDK.send`, including its credential,
signing and response waiting. `timeoutMs` defaults to 30000 and must be 1–120000.
The same owned `abortSignal` reaches each SDK send/page; an independent race
also bounds local waiting if an injected client ignores it. Monotonic checks
after SDK results, codec/cursor work and final cleanup prevent late success when
the event loop has not serviced the timer. Cancellation uses the runtime's
`QueryCancelledError` (`reason: caller | deadline`), without caller reason/cause.
SDK failures use fixed `DynamoDbReadError` messages and codes `transport`,
`limit` or `invalid-response`, without provider text, metadata or credentials.

The public constructor accepts `DynamoDbDocumentClientLike`, a self-contained
method interface assignable from the official overloaded `DynamoDBDocumentClient`.
It retains that exact client object and the existing SDK commands internally;
it does not wrap, configure or destroy it. This keeps the adapter's own public
declarations free of the SDK's Node ambient types. Direct imports of vendor
declarations may still carry their own Node type requirements; those are a
separate diagnostic, rather than permission to add Node globals to a DOM-only
adapter consumer.

`maxReadRecords` defaults to 1000. It bounds received records across Query pages
and total requested BatchGet output, **including duplicates**. The existing
100-distinct-key native batch admission remains separate: 101duplicates of one
key still work under defaults, preserving input order and missing snapshots.
The admitted key list is copied before I/O. A Query request above the local
record cap or a server response beyond its remaining requested limit fails
whole; it never returns a truncated success or dispatches another page after
failure/cancellation. Empty filtered pages still consume `maxQueryPages`.

`maxReadBytes` defaults to 4000000 accounted bytes across **already-decoded SDK
results**, including metadata/cursors and logical BatchGet duplicate expansion.
Accounting charges UTF-8 text/key lengths, binary byte lengths, scalar/container
overhead and each pre-codec managed payload, without JSON coercion. Native
`Uint8Array`/ArrayBuffer/views, sets, bigint and the public SDK `NumberValue`
retain their objects and precision. Cycles, accessors and unsupported custom
classes are refused, with a 100000-node/64-level structural work cap. Arbitrary
custom number-wrapper classes need an explicitly supported representation;
changing the borrowed client's unmarshalling policy is not implicit.
Native sets/number wrappers and unshared binary buffers/views must have their
canonical platform/SDK prototypes and closed own properties: overridden
iterators, byte-length/value accessors, extra fields and subclasses are refused.
Set traversal and binary sizing use intrinsic methods/getters rather than
payload overrides. Ordinary Node Buffer identity is preserved by optional
platform detection; this adds no Node import or browser Buffer polyfill.

This is **not a wire-body or pre-decoding memory cap**: the AWS SDK has already
materialized its result before the adapter can account it. Caller codec output
allocations, SDK credential providers/handlers that ignore abort, configured SDK
internal retries, provider scan work/capacity and billing are not controlled by
this result budget. The adapter adds no retries and never destroys or
reconfigures the borrowed client. It observes late promise failures and stops
its own later pages, so the same client can reopen or serve another caller.

This qualification is for reads. Existing writes retain their prior behavior,
including conditional DALgo errors with provider causes; they are not newly
deadline/caller-signal/redaction qualified. This slice adds no mutation retry,
rollback, transaction API, native existing-table mapper, index/schema discovery
or consumed-capacity budget. A local abort does not undo provider work.

### Workspace package

This package is not yet published to npm. From the repository root, run
`pnpm install --frozen-lockfile` and
`pnpm --filter @dal-go/dalgo2dynamodb build`.

## Supported DALgo surface

- point reads and ordered `getMany` (up to DynamoDB's 100 distinct-key batch
  limit; duplicate requested keys are restored in output order)
- conditional `insert`, replace-style `set`, top-level-field `update`, and
  `delete`
- collection queries for the adapter's partition-key layout
- AND-combined equality, comparison, membership, `contains`, and
  `array-contains-any` filters over top-level encoded document fields
- ascending or descending document-ID order and adapter-issued `startAfter`
  pagination cursors
- nested collections; their partition value includes the complete parent path

The adapter rejects collection-group queries, arbitrary field ordering,
offsets, inclusive/end cursors, hand-built cursors, and DALgo callback
transactions. These are intentional semantic boundaries, not missing fallback
implementations.

DynamoDB filters run after DynamoDB reads the matched key range, so they do
not reduce read capacity. A limited filtered query can require multiple
underlying DynamoDB requests; the adapter continues through empty filtered
pages until it reaches the requested record limit or the native result range
ends. It rejects a repeated native pagination key and applies a 100-page safety
limit by default (`maxQueryPages` can adjust that bound). DynamoDB limits each
query response to 1 MB and items to 400 KB; design keys and documents
accordingly. See [Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)
and [Scan/query filter behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html).

## Verification

`npm run check` runs ESLint, deterministic Vitest command-contract tests, and
strict source/test/example checking plus the declaration build. Existing tests
mock the injected client. Read lifecycle tests use real AbortControllers,
deferred sends, native pages, mutable monotonic clocks, and an actual
SDK credential provider without contacting DynamoDB. They do **not** establish
hosted IAM/STS/capacity, DynamoDB Local, browser CORS or installed-release proof.

## License

MIT

## Existing tables and classic secondary indexes

`NativeDynamoDbDatabase` is an additive, read-only API for explicitly configured
existing tables. `DynamoDbDatabase` and its managed DALgo key/data layout and
CRUD API remain separate. Native keys are low-level AWS S/N/B attribute maps;
they are not fabricated DALgo `Key` IDs. Native items retain all ten AWS
attribute tags, including decimal number **strings**, binary `Uint8Array`,
sets, nested maps/lists and explicit null. No DocumentClient marshalling or
JavaScript `number` conversion is used by this mode.

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { NativeDynamoDbDatabase } from "@dal-go/dalgo2dynamodb";

const sdk = new DynamoDBClient({ region: "us-east-1", credentials });
const native = new NativeDynamoDbDatabase(sdk, {
  tables: {
    orders: {
      tableName: "existing-orders",
      partitionKey: { name: "account", type: "S" },
      sortKey: { name: "sequence", type: "N" },
      indexes: {
        status: {
          indexName: "status-index", kind: "gsi",
          partitionKey: { name: "status", type: "S" },
          sortKey: { name: "created", type: "N" },
          projection: ["total"],
        },
      },
    },
  },
});
const item = await native.get("orders", {
  account: { S: "tenant-one" }, sequence: { N: "9007199254740993" },
});
const page = await native.queryPartition({
  collection: "orders", index: "status", partition: { S: "open" }, limit: 10,
});
const next = page.nextCursor === undefined ? undefined : await native.queryPartition({
  collection: "orders", index: "status", partition: { S: "open" }, limit: 10,
  cursor: page.nextCursor,
});
native.close(); // Cancels only this adapter's owned scopes; does not destroy sdk.
```

The caller supplies the SDK client, endpoint/region/credential policy and retry
configuration. The constructor does no credentials, network or discovery work.
Never expose long-lived access keys in a browser; use an independently qualified
temporary-credential/IAM flow. Table/index mappings are local read grants and
do not replace IAM. Physical names use the ordinary 3–255 ASCII table/index
name syntax; table ARNs and new multi-attribute index schemas are not implemented.

`get` returns an owned native item or null; `exists` returns a boolean.
`getMany` admits at most 100 distinct native keys in one BatchGet, reconstructs
input order, duplicates and null missing positions, and refuses the **whole**
operation on any unprocessed, duplicate or foreign response key. It does not
silently equate unprocessed keys with missing records or add automatic retries.
The default logical-request limit is 1,000, so 101 copies of one key are valid.
Duplicate outputs have independent binary/container ownership and are charged
to the aggregate parsed-work budget.

All read methods have `WithSignal` variants. Point/batch signatures are
`getWithSignal(collection, key, signal, options?)`,
`existsWithSignal(collection, key, signal)`, and
`getManyWithSignal(collection, keys, signal, options?)`. Query uses
`queryPartitionWithSignal(request, signal)`. One deadline starts before input
admission, credential/send waits and parsing and remains authoritative through
final delivery, including synchronous work crossing the monotonic deadline.
Errors redact raw SDK causes and cancellation reasons. `close()` is idempotent;
subsequent reads refuse locally. Borrowed SDK calls that ignore abortion retain
one admission slot until actual settlement, including after their caller timed
out; no client/transport is destroyed. At most 128 local admission waiters are
accepted. This is not a remote cancellation or billing guarantee.

`queryPartition` requires one typed partition value and optionally a sort
predicate (`=`, `<`, `<=`, `>`, `>=`, `between`, string/binary `begins_with`),
direction, projection and positive limit. Only configured logical indexes are
accepted. GSI strong reads and nonprojected requests refuse before SDK send or
credential acquisition. LSI strong reads are allowed, but implicit table fetches
for nonprojected attributes are deliberately refused. `readAttributes` can
restrict a table's returned attributes; default `"all"` grants its full item.
Identity key attributes are always included in projections and returned items.
Missing non-key projected attributes remain legitimately absent.

Equal index sort keys are legal, including across pages: identities are based
on the **base table** key. String ordering compares UTF-8 bytes, binary ordering
compares unsigned bytes, and decimal identities/comparisons never use float64
(`1` and `1.0` denote the same key). Numbers preserve the string received from
the SDK; DynamoDB may already have trimmed input zeroes. Number values enforce
the documented 38 significant digits and magnitude range. Non-key empty strings,
binary values and containers are supported; empty sets are refused.

Cursors are reusable opaque handles bound to this instance and the exact table,
index, partition, sort predicate, projection, consistency, direction and limit.
Their private key includes the configured base and index attributes. Repeated
service keys, foreign scopes, overreturn, invalid counts or out-of-order rows
fail the whole operation. Empty pages may carry a continuation and are followed
within the same budgets. A continuation does not prove another matching item,
a stable snapshot or transaction. Handles cannot be serialized or reconstructed.

Default limits are 30 seconds (maximum 120 seconds), 1,000 records, 4,000,000
accounted parsed bytes, 100 pages, 10,000 evaluated work units, page size 100,
and four outstanding SDK calls (maximum 32). Configuration itself is bounded
to 1 MiB, 128 table grants and 32 indexes per table. Projections/attribute grants
admit 128 requested names plus identity keys. Native documents have at most
1,000 attributes per map, nesting 32, and shared parsed-node accounting 100,000.
These are conservative parsed SDK/request/output work bounds, **not** a raw
response allocation, engine-memory, exact network-attempt or capacity-unit cap.
The borrowed SDK can perform retries internally; all waits still share one
operation deadline.

`configuredTables()` reports immutable **configured** metadata without
Describe/List calls or proof that a live table/index exists or is accessible.
Scan/parallel Scan, arbitrary filter expressions, raw PartiQL, native writes,
transactions and admin/discovery APIs are not implemented. Missing partition
conditions never trigger Scan. The managed class retains its existing writes.

Native tests include an actual official low-level SDK with an owned signed
request handler and synthetic JSON-wire responses, as well as deterministic
admission, byte/type/page/cursor and cancellation regressions. This source alone
does not qualify DynamoDB Local, hosted AWS IAM/STS/capacity, actual browser
execution/CORS, or a registry/installed release. Package name/private flag/version
stay unchanged; repository policy disables versioning/tagging private packages.

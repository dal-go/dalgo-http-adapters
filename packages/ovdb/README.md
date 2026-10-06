# dalgo2ovdb-js

Browser-ready [DALgo TypeScript](https://github.com/dal-go/dalgo-js) adapter for the versioned [OpenVaultDB](https://openvaultdb.com/) HTTP API.

Use this package when a web application should query an OpenVaultDB server directly. For direct Firestore Web SDK access use [`@dal-go/dalgo2firestore`](../firestore); for same-origin offline storage use [`@dal-go/dalgo2indexeddb`](../indexeddb).

## Install

This package is developed in the repository workspace and is not yet published
to npm:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dal-go/dalgo2ovdb build
```

## Use

```ts
import { collection } from "@dalgo/core";
import { OpenVaultDbDatabase } from "@dal-go/dalgo2ovdb";

interface Todo {
  title: string;
  done: boolean;
  rank: number;
}

const db = new OpenVaultDbDatabase({
  baseUrl: "https://vault.example",
  databaseId: "my-app",
  getAccessToken: async () => auth.currentToken(),
});
const todos = collection<Todo>("todos");

const page = await db.query(
  todos.query()
    .where("done", "==", false)
    .orderBy("rank")
    .limit(20)
    .build(),
);

await db.runReadwriteTransaction(async (transaction) => {
  await transaction.set(todos.key("first"), {
    title: "Try OpenVaultDB",
    done: false,
    rank: 1,
  });
});
```

Reads use OpenVaultDB's record and query endpoints. A DALgo read-write transaction buffers mutations and commits them atomically with one `POST /v1/databases/{database}/batch` request. Reads of buffered point records have read-your-writes behavior; queries inside a transaction are not part of the DALgo TypeScript transaction interface.

## Browser configuration

Start the OpenVaultDB server with the web application's exact origin allowed, for example:

```sh
ovdb serve --manifest mydb.yaml --auth --cors https://app.example
```

Use HTTPS outside loopback development. Tokens are sent only in the `Authorization: Bearer` header; never put them in the base URL, query parameters, logs, analytics, or persisted browser metadata. The adapter rejects base URLs containing credentials, query parameters, or fragments, and refuses HTTP redirects.

Pass `getAccessToken` when the token can rotate. Pass `accessToken` only when the caller already manages its lifecycle securely. Requests always use `cache: "no-store"`, `credentials: "omit"` and `redirect: "error"`; bearer authentication remains explicit. Successful record/query JSON is bounded to 2 MiB and a ten-second body deadline, with invalid UTF-8 rejected. Error bodies have a 16 KiB/one-second bound; only a validated code (up to 64 characters) and message (up to 4096 characters) enter the error. Parse, budget, deadline, UTF-8 and invalid-field failures return a short error retaining only HTTP status.

## Required live-provider observations

OVDB now uses `@dalgo/core` exclusively. Its peer range is `>=0.4.0 <0.5.0`.
The package remains private and unpublished. The workspace uses an OVDB-only Git
development override pinned to core commit `5f80adc2fe53cfaef2d6e73bc4e053259deeec3e`
to test the merged consumer API. That pin is not an npm publication receipt or a
local source replacement. Other adapters keep their existing core dependencies;
this change makes no compatibility claim for mixing their core instances.

For an admitted live-provider query, independently verify the immutable
definition, decoder/model artifacts, provider/executor binding, complete rights
and non-secret resource request plan before calling the adapter. Configure
`expectedServerId` from trusted gateway discovery, and pass the independently
admitted `ProviderReadPlan` as the second query argument. Generate a fresh
`createOpenVaultDbExecutionId()` before admitting each plan: its execution ID is
exactly 32 lowercase hex characters from 128 cryptographically random bits. The
adapter freezes and sends this ID in `OVDB-Execution-ID`; the profile-enabled Go
server binds that exact ID before reading upstream and hashes it into the
observation. This is request correlation, never admission, authentication, source
selection or permission to retain results. Gateways must permit this header in
CORS for the application's exact origin.

```ts
import type { ProviderReadPlan } from "@dalgo/core";

async function executeAdmitted(plan: ProviderReadPlan) {
  const db = new OpenVaultDbDatabase({
    baseUrl: "https://gateway.example",
    databaseId: "synthetic-db",
    expectedServerId: "admitted-gateway",
  });
  return db.query(collection("daily").query().build(), { providerReadPlan: plan });
}
```

The adapter freezes the plan and serialized query before awaiting credentials or
transport. Planned rights must identify this server, database and exact queried
recordset, and `execution.executorId` must equal `expectedServerId`; this
single-collection API refuses mixed-source plans. Invalid executor/ID/source
bindings fail before credentials or transport. The response
must have `Cache-Control: no-store`. Core validates the closed
`ovdb-provider-read/1` envelope, exact full rights/usage/execution/definition
bindings, canonical request/rights/observation digests and metadata budgets before
any row codec runs. The returned `QueryPage` carries the detached `sourceRights`,
`usedSourceIds` and `providerReads`, including when no rows survive filtering.
Unsolicited live evidence without a plan, absent required evidence, malformed
evidence and changed bindings fail. Never derive the admitted plan from the
response being checked. An old producer that generates its own uncorrelated ID
cannot pass this independently admitted query gate. The Go producer must support
the client nonce contract; this adapter never substitutes response execution
identity into its trusted plan.

Legacy queries preserve supplied rights/used-source metadata; absence still means
unknown. Point reads preserve legacy rights inside `RecordSnapshot.metadata`.
Their generic API has no independently admitted live plan, so a point response
containing `providerReads` is explicitly refused. Live point reads, relational
DTQL, paging and rights-aware generic federation are not enabled by this change.

Release/activation requires a published core version containing this exact
consumer capability and a reviewed adapter release dependency; replace the
development override only after verifying that registry artifact. Producer
Go/JS parity, definition/semantic/rights admission, required notices, server
no-retention guards, DataTug's ephemeral route and all actual browser/storage/CDN
receipts remain separate gates. The adapter keeps only ordinary bounded response
buffers during a request. It creates no retained row/body store and authorizes no
source/result copy, live source activation or paid execution.

## Independent review r1 disposition

B1 is addressed in code by the coordinated `OVDB-Execution-ID` nonce protocol; synthetic
actual Go-server to JS-adapter interoperability passed against producer commit
`2dc6a2c36a832061ef7ef9fc447fdb188a04301c`, including concurrent populated/empty
results, nonce correlation, complete digest validation, no-store, CORS and
invalid-header zero-read cases. An omitted nonce still refuses the uncorrelated
legacy response at the consumer gate. Independent rereview remains required
before acceptance. M1 is repaired by binding the proxy executor to the
configured server before credentials/network I/O. M2 is repaired with finite
fatal UTF-8 error-body processing, validated selected fields and short status-only
fallbacks; oversized/stalled/malformed error tests cover those paths. No finding
was declined. This draft does not claim review acceptance or source activation.


## Current server profile

The adapter matches OpenVaultDB HTTP API v1:

- Point get and multi-get.
- Atomic set, insert, update, and delete batches.
- Root and parent-scoped collection queries.
- `==`, `<`, `<=`, `>`, `>=`, `in`, `array-contains`, and `array-contains-any` filters.
- Field ordering and limits.

Collection-group queries, document-ID filters/order, offsets, cursors, `!=`, and `not-in` fail explicitly because the current OpenVaultDB query endpoint does not preserve those semantics. Query responses therefore do not return a DALgo `nextCursor` yet.

OpenVaultDB record paths carry IDs as strings over HTTP. Numeric DALgo key IDs are serialized in paths and return as string IDs in query results.

## Development

```sh
pnpm install
npm run check
```

## License

MIT

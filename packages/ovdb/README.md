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
import { collection } from "@dal-go/dalgo";
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

Pass `getAccessToken` when the token can rotate. Pass `accessToken` only when the caller already manages its lifecycle securely.

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

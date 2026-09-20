# dalgo2indexeddb-js

Native browser [IndexedDB](https://developer.mozilla.org/docs/Web/API/IndexedDB_API) adapter for the TypeScript implementation of [DALgo](https://github.com/dal-go/dalgo-js).

This adapter provides local, same-origin browser persistence. It complements `dalgo2firestore-js`; it does not synchronize IndexedDB with Firestore or an OpenVaultDB server by itself.

## Install

The packages are currently available from GitHub rather than the npm registry:

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2indexeddb-js
```

## Use

```ts
import { collection } from "@dal-go/dalgo";
import { IndexedDbDatabase } from "@dal-go/dalgo2indexeddb";

interface Todo {
  title: string;
  done: boolean;
  rank: number;
}

const db = new IndexedDbDatabase({ name: "my-app" });
const todos = collection<Todo>("todos");

await db.runReadwriteTransaction(async (transaction) => {
  await transaction.set(todos.key("first"), {
    title: "Try DALgo",
    done: false,
    rank: 1,
  });
});

const page = await db.query(
  todos.query()
    .where("done", "==", false)
    .orderBy("rank")
    .limit(20)
    .build(),
);
```

Call `await db.close()` before deleting or upgrading a database from another tab.

## Storage model

The adapter owns one object store named `__dalgo_records`. Records retain their complete hierarchical DALgo keys and are indexed by collection path and collection name. This fixed schema means new DALgo collections do not require IndexedDB version upgrades.

Collection and collection-group selection uses IndexedDB indexes. DALgo filters, ordering, cursors, offsets, and limits are then evaluated in memory, so this initial driver favors correctness and a small stable schema over large-query performance. Use a remote adapter or add purpose-built indexes before querying very large local collections.

`runReadwriteTransaction` uses a real IndexedDB read-write transaction. Its callback should await only DALgo operations; awaiting timers, network calls, or unrelated work can allow the browser to make the native transaction inactive.

## Runtime and testing

The package uses the browser's global `indexedDB` by default. Tests and non-browser runtimes can inject an `IDBFactory`:

```ts
const db = new IndexedDbDatabase({ name: "test", factory });
```

## Development

```sh
pnpm install
npm run check
```

## License

MIT

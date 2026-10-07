# `@dalgo/indexeddb`

Native browser [IndexedDB](https://developer.mozilla.org/docs/Web/API/IndexedDB_API) adapter for [`@dalgo/core`](https://www.npmjs.com/package/@dalgo/core).

This adapter provides local, same-origin browser persistence. It complements `@dalgo/firestore`; it does not synchronize IndexedDB with Firestore or an OpenVaultDB server by itself.

## Install

```sh
pnpm add @dalgo/core @dalgo/indexeddb
```

## Use

```ts
import { collection } from "@dalgo/core";
import { IndexedDbDatabase } from "@dalgo/indexeddb";

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

By default, the adapter owns one object store named `__dalgo_records`. Records retain their complete hierarchical DALgo keys and are indexed by collection path and collection name. This fixed schema means new DALgo collections do not require IndexedDB version upgrades.

For a database whose collections are known in advance, pass `collections` to expose each one as its own IndexedDB object store:

```ts
const db = new IndexedDbDatabase({
  name: "chinook",
  collections: [
    { name: "main.Customer", storeName: "Customer" },
    { name: "main.Invoice", storeName: "Invoice" },
    { name: "main.Track", storeName: "Track" },
  ],
});
```

Strings can also be used when the DALgo collection name and IndexedDB object store name are identical. Only the listed collections can be read or written. Additions to that list require an IndexedDB version upgrade (or a new database name). Choose the layout when creating a database; changing an existing shared-store database to named stores does not migrate its records.

Collection and collection-group selection uses IndexedDB cursors. DALgo filters, ordering, cursors, offsets, and limits are evaluated as records arrive. A query with `limit` retains at most `offset + limit` candidate records in memory; it still scans the selected collection when filtering or ordering cannot use a native index. An unbounded query returns all matching records and can use proportionally more memory.

When an imported source stores exact decimals or wide integers as strings, opt the relevant fields into numeric comparison. Ordinary text, including postal codes such as `"001"`, keeps lexical ordering:

```ts
import { withIndexedDbQueryHints } from "@dalgo/indexeddb";

const query = withIndexedDbQueryHints(
  invoices.query().where("total", ">", "9007199254740992").orderBy("total").limit(20).build(),
  { numericFields: ["total"], signal: controller.signal },
);
const page = await db.query(query);
```

Hints apply to this query only; fields marked numeric must contain decimal strings or safe integer numbers. Decimal comparison is exact within the adapter's 1,000-digit scale bound. Cancellation rejects the query without returning a partial page.

## Recursive DTQL

Run recursive DTQL through `executeRecursiveDTQLQuery` from `@dalgo/core`.
The core sends this adapter ordinary, bounded leaf queries; calling
`IndexedDbDatabase.query()` with a recursive AST is rejected before the database
opens. The leaf path scans IndexedDB cursors. A bounded leaf retains only its
requested page, although a filter or sort may still require visiting every
record in the selected collection.

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

# DALgo adapter for Firestore Web

`@dalgo/firestore` implements the
[`@dalgo/core`](https://www.npmjs.com/package/@dalgo/core) database contracts with
Firebase's modular Cloud Firestore Web SDK. It is intended for browser apps,
including apps that query an OpenVaultDB Firestore database directly.

## Install

```sh
pnpm add @dalgo/core @dalgo/firestore firebase
```

Both packages are published to npm as `@dalgo/core` and `@dalgo/firestore`.

## Browser setup

```ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { collection, key } from "@dalgo/core";
import { FirestoreDatabase } from "@dalgo/firestore";

interface Item {
  title: string;
  done: boolean;
  rank: number;
}

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

const db = new FirestoreDatabase(getFirestore(app));
const spaceKey = key("spaces", "my-space");
const items = collection<Item>("items").in(spaceKey);

const firstPage = await db.query(
  items.query()
    .where("done", "==", false)
    .orderBy("rank")
    .limit(25)
    .build(),
);

const secondPage = firstPage.nextCursor === undefined
  ? undefined
  : await db.query(
      items.query()
        .where("done", "==", false)
        .orderBy("rank")
        .startAfter(...firstPage.nextCursor.values)
        .limit(25)
        .build(),
);
```

For a named Firestore database, pass its database ID to `getFirestore`:

```ts
const db = new FirestoreDatabase(getFirestore(app, openVaultDatabaseId));
```

The adapter appends document ID as a deterministic final ordering field. Use
the returned `nextCursor` rather than constructing pagination values manually.

## Point reads and transactions

```ts
const item = await db.get(items.key("milk"));
if (item.exists) {
  console.log(item.data.title);
}

await db.runReadwriteTransaction(async (tx) => {
  const current = await tx.get<Item>(items.key("milk"));
  if (current.exists) {
    await tx.update(current.key, { done: true });
  }
});
```

Firestore may retry a transaction callback. Keep it idempotent and do not
perform UI or other external side effects inside it. Firestore also requires
all reads before writes; the adapter reports a DALgo `UnsupportedError` when a
callback tries to read after writing.

## OpenVaultDB and browser security

The Firebase Web configuration identifies a project; it is not an admin
credential. Browser access must be authorized with Firebase Authentication and
least-privilege Firestore Security Rules. Every mobile/web SDK request is
checked by those rules. Consider Firebase App Check as an additional abuse
signal. Never ship service-account credentials or server SDK credentials to a
browser.

This package deliberately uses the Web SDK, not `firebase-admin`, so it cannot
bypass Firestore Security Rules.

## Supported query surface

- nested collections and collection-group queries
- Firestore comparison, membership, and array filters
- multiple `where` clauses combined with AND
- ascending and descending ordering
- deterministic value-cursor pagination
- limits

Offset is rejected explicitly because the Firestore Web SDK does not expose an
offset constraint. Firestore index and operator-combination requirements remain
native Firestore behavior and errors.

## License

MIT

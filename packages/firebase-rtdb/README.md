# DALgo adapter for Firebase Realtime Database Web

`@dal-go/dalgo2firebase-rtdb` maps the read and query portions of
[`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) onto Firebase Realtime
Database (RTDB) through Firebase's modular Web SDK. It is deliberately a
browser-facing adapter: Firebase Authentication plus RTDB Security Rules decide
access, and no credential is placed in a URL query parameter.

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2firebase-rtdb-js firebase
```

This repository currently builds as `@dal-go/dalgo2firebase-rtdb`; it is not
published to npm.

## Browser setup

```ts
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { collection } from "@dal-go/dalgo";
import { RealtimeDatabase } from "@dal-go/dalgo2firebase-rtdb";

interface Item { done: boolean; rank: number; title: string }
const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});
const db = new RealtimeDatabase(getDatabase(app));
const items = collection<Item>("items");
await db.set(items.key("milk"), { title: "Milk", done: false, rank: 1 });
const page = await db.query(items.query().orderBy("rank").limit(25).build());
```

Use the regular Firebase Auth Web SDK before reads and writes. RTDB Security
Rules are evaluated by Firebase for Web SDK requests; this package does not use
`firebase-admin`, service-account credentials, or REST URLs containing tokens.
The SDK may use HTTP/SSE internally, but callers only provide an authenticated
`Database` instance.

## Mapping and transaction boundary

DALgo `Key.path` is the RTDB location. Nested keys map directly to nested tree
paths. `get`, `getMany`, codecs, `set`, `update`, `delete`, and an atomic
single-key `insert` are supported. `insert` uses RTDB's location transaction
and throws `AlreadyExistsError` if the location already has a value.

`runReadwriteTransaction` always rejects with `UnsupportedError`. RTDB only
offers a synchronous transaction callback for one location; it cannot preserve
DALgo's asynchronous callback semantics across arbitrary keys, reads, and
writes. Use a focused RTDB transaction in application code only when its
single-location semantics are actually sufficient.

## Query limits and indexes

RTDB is a tree, not a collection-group database. Queries support exactly one
collection source, at most one filter, at most one order, a limit, and one
value cursor. Supported comparisons are `==`, `<`, `<=`, `>`, and `>=`; their
field must match the order field. `__name__` orders by the child key. Collection
groups, offsets, membership/array filters, multiple filters/orders, descending
order, and multi-value cursors fail early with `UnsupportedError`.

Add `.indexOn` for every queried child field in the RTDB Security Rules. The
SDK can return data without one for small development trees, but Firebase warns
and production performance/security-rule query behavior should be designed with
the matching index. Cursor pagination intentionally has no `nextCursor`: RTDB
does not report whether an exact page exhausted the result set without an extra
read, and the DALgo contract must not fabricate one.

## Testing

Unit tests mock the modular `firebase/database` boundary and verify the DALgo
mapping/unsupported surface. `pnpm test:emulator` runs the integration test
against the Firebase RTDB emulator, which is the meaningful check for Auth and
Security Rules behavior. Realtime subscriptions (`onValue`, `onChild*`) are not
exposed because the current DALgo `Database` contract is request/response only.

## License

MIT

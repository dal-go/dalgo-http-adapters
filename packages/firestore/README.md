# DALgo adapter for Firestore Web

`@dalgo/firestore` implements the
[`@dalgo/core`](https://www.npmjs.com/package/@dalgo/core) database contracts with
Firebase's modular Cloud Firestore Web SDK. It is intended for browser apps,
including apps that query an OpenVaultDB Firestore database directly.

## Install

```sh
pnpm add @dalgo/core @dalgo/firestore firebase
```

The adapter uses the separately published `@dalgo/core` contracts. Its required
peer range is `@dalgo/core >=0.8.0 <0.9.0`, the first core line with the TugQL
names.

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

## Recursive TugQL

Run recursive TugQL through `executeRecursiveTugQLQuery` from `@dalgo/core`.
The core sends Firestore ordinary bounded leaf queries; a direct recursive AST
is rejected before Firestore query compilation. `EXISTS` can stop its logical
evaluation after a match, while each Firestore leaf query remains a Web SDK
page request and cannot promise physical first-record stopping within that page.

### TugQL from a browser (read-only)

`runFirestoreTugQL(firestore, resolved, options?)` runs a query resolved by
`resolveTugQL(document, { ..., schemaless: true })` and returns
`{ columns, rows }`. Import it from `@dalgo/firestore/tugql`, which imports no
Firestore write API, so a browser host can run user queries on the signed-in
user's own session.

- A slash `FROM` (`FROM spaces/abc/ext/datatug/projects`) resolves to
  `schema: spaces/abc/ext/datatug`, read as the parent document path
  (`firestoreParentKey`). An odd segment count is refused, naming the path,
  before any read.
- `__key__` is the document id. It may be selected, compared and ordered on;
  every row of a query without `SELECT` carries it as its first column,
  followed by the union of the returned documents' fields in first-seen order.
- A query over one collection whose only condition is `__key__ = <value>`
  reads that one document (`getDoc`) and returns zero or one row.

#### Queries run as Firestore queries

Any other query must be expressible as **one Firestore query**, so Firestore
reads only matching documents through its indexes. That holds when the query:

- reads one collection: no JOIN, derived `FROM`, subquery, `GROUP BY`,
  `HAVING` or aggregate;
- has a `WHERE` that is an `AND` of comparisons of one field (or `__key__`)
  with a value, using `=`, `!=`, `<`, `<=`, `>`, `>=`, `in` or `not-in`;
- compares only with strings, finite numbers and booleans (or lists of them),
  never with `NULL`, after parameters are bound;
- stays within Firestore's limits: at most 30 `in` disjunctions (the product
  of all `in` list sizes), at most 10 `not-in` values, at most one `!=` or
  `not-in`, and no `not-in` together with `in` or `!=`;
- orders by fields (or `__key__`), ascending or descending;
- names fields plainly: a dotted name (`a.b`) or a `__name__`-style name is
  refused, because Firestore would read a nested or reserved path while
  DALgo-JS reads the literal key.

The adapter sends every comparison as a `where`, every `ORDER BY` entry as an
`orderBy`, and a `limit` of `LIMIT + OFFSET` (or `maxFetchedRows + 1` without
`LIMIT`). DALgo-JS then re-applies `WHERE`, `ORDER BY`, `OFFSET`, `LIMIT` and
`SELECT` to the documents returned. Inequality fields are also sent as
explicit `orderBy`s, in the order Firestore itself would use, so a query such as
`rank > 3` needs no composite index. An empty `in` list returns no rows without
a read; `LIMIT + OFFSET` over `maxFetchedRows` (10,000 by default) fails with
`query_limit` at `limit` before any read.

**OFFSET rows are read and billed.** The Firestore Web SDK has no offset, so
`LIMIT 5 OFFSET 10` reads 15 documents and DALgo-JS skips the first 10.

**Firestore semantics, not in-memory TugQL.** A pushed query returns what
Firestore selects:

- `ORDER BY` a field excludes documents that lack that field;
- range and `!=` filters match only values of the operand's type;
- `!=` and `not-in` exclude documents that lack the field, but match stored
  `null`s, which DALgo-JS then drops; with a `LIMIT` such a query can return
  fewer rows than the limit;
- DALgo-JS re-sorts the rows with JavaScript comparison (UTF-16 code units,
  no cross-type order), so their order can differ from Firestore's for
  non-ASCII strings or mixed-type fields.

A missing composite index fails with Firestore's own `failed-precondition`
error and its index-creation link; the adapter never retries in memory.

#### Refusal and `allowInMemoryEvaluation`

Any other query fails **before the first read** with a
`FirestoreTugQLRefusedError` whose `code` is `in_memory_evaluation`, `path` is
the first offending node (`where`, `where.and[1]`, `orderBy[0]`,
`from.joins[0]`, `groupBy`, `columns[0]`, …) and `reason` names the failed
condition (`OR`, `field compared with field`, `comparison with NULL`,
`` `in` disjunctions exceed 30 ``, `JOIN`, …).

`runFirestoreTugQL(firestore, resolved, { allowInMemoryEvaluation: true })`
runs such a query the old way instead: unfiltered collection scans bounded by
`maxFetchedRows`, evaluated in memory by DALgo-JS. Every scanned document is a
billed read, and a collection over the budget fails with `query_limit`. Browser
hosts running user queries should not set it.

`planFirestoreTugQL(query, options)` returns the plan without reading, and the
`reader` option injects the `getDocs`/`getDoc` functions (for tests).

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

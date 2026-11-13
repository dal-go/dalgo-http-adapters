import { initializeApp } from "firebase/app";
import {
  collection as firebaseCollection,
  collectionGroup as firebaseCollectionGroup,
  doc,
  documentId as firebaseDocumentId,
  getFirestore,
  orderBy as firebaseOrderBy,
  query as firebaseQuery,
  queryEqual,
  startAfter as firebaseStartAfter,
  type DocumentReference,
  type DocumentSnapshot,
} from "firebase/firestore";
import { DOCUMENT_ID, UnsupportedError, collection, collectionGroup, key, type StructuredQuery } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { compileFirestoreQuery, toFirestoreDocumentIdValue } from "../src/index.js";
import { cursorFromSnapshot } from "../src/query.js";

interface Item {
  readonly done: boolean;
  readonly rank: number;
}

const app = initializeApp({ projectId: "demo-dalgo-js" }, "dalgo2firestore-tests");
const firestore = getFirestore(app);

type CursorSnapshot = Pick<DocumentSnapshot, "id" | "get" | "ref">;

function snapshotWithRank(ref: DocumentReference, rank: number): CursorSnapshot {
  return {
    id: ref.id,
    ref,
    get: (field: unknown) => (field === "rank" ? rank : undefined),
  };
}

describe("compileFirestoreQuery", () => {
  it("rejects a raw recursive query before Firestore receives it", () => {
    const recursive = { kind: "recursive-tugql", from: { kind: "table", name: "items", joins: [] } } as unknown as StructuredQuery<Item>;
    expect(() => compileFirestoreQuery(firestore, recursive)).toThrow(UnsupportedError);
    expect(() => compileFirestoreQuery(firestore, recursive)).toThrow("core recursive executor");
    const disguised = { ...recursive, source: { kind: "collection", name: "items" }, filters: [], orders: [] } as unknown as StructuredQuery<Item>;
    expect(() => compileFirestoreQuery(firestore, disguised)).toThrow(UnsupportedError);
  });
  it("compiles collection filters and adds document id as a stable tiebreaker", () => {
    const query = collection<Item>("items")
      .query()
      .where("done", "==", false)
      .orderBy("rank", "desc")
      .limit(10)
      .build();

    const compiled = compileFirestoreQuery(firestore, query);
    expect(compiled.query.type).toBe("query");
    expect(compiled.orders).toEqual([
      { field: "rank", direction: "desc" },
      { field: DOCUMENT_ID, direction: "desc" },
    ]);
  });

  it("compiles collection-group queries", () => {
    const compiled = compileFirestoreQuery(
      firestore,
      collectionGroup<Item>("items").where("done", "==", false).build(),
    );
    expect(compiled.orders).toEqual([{ field: DOCUMENT_ID, direction: "asc" }]);
  });

  it("maps DALgo keys to the document-id shape required by each query source", () => {
    const space = key("spaces", "s1");
    const item = key("items", "i1", space);
    const nested = collection<Item>("items", { parent: space }).source;
    const group = collectionGroup<Item>("items").build().source;

    expect(toFirestoreDocumentIdValue(item, nested)).toBe("i1");
    expect(toFirestoreDocumentIdValue(item, group)).toBe("spaces/s1/items/i1");
    expect(() => toFirestoreDocumentIdValue(key("other", "i1"), nested))
      .toThrow("expected spaces/s1/items");
  });

  it("rejects offset because the Firestore Web SDK cannot preserve its semantics", () => {
    const query = collection<Item>("items").query().offset(1).build();
    expect(() => compileFirestoreQuery(firestore, query)).toThrow(UnsupportedError);
  });

  it("requires cursor values for every compiled ordering field", () => {
    const query = collection<Item>("items")
      .query()
      .orderBy("rank")
      .startAfter(10)
      .build();
    expect(() => compileFirestoreQuery(firestore, query)).toThrow("2 order fields");
  });

  it("uses full document paths for collection-group cursors with equal leaf ids", () => {
    const group = collectionGroup<Item>("items").orderBy("rank", "desc").build();
    const compiled = compileFirestoreQuery(firestore, group);
    expect(compiled.orders).toEqual([
      { field: "rank", direction: "desc" },
      { field: DOCUMENT_ID, direction: "desc" },
    ]);

    const refA = doc(firestore, "spaces/a/items/shared");
    const refB = doc(firestore, "spaces/b/items/shared");
    const cursorA = cursorFromSnapshot(snapshotWithRank(refA, 7), compiled.orders, group.source.kind);
    const cursorB = cursorFromSnapshot(snapshotWithRank(refB, 7), compiled.orders, group.source.kind);
    expect(cursorA.values).toEqual([7, "spaces/a/items/shared"]);
    expect(cursorB.values).toEqual([7, "spaces/b/items/shared"]);

    const compiledA = compileFirestoreQuery(
      firestore,
      collectionGroup<Item>("items").orderBy("rank", "desc").startAfter(...cursorA.values).build(),
    );
    const compiledB = compileFirestoreQuery(
      firestore,
      collectionGroup<Item>("items").orderBy("rank", "desc").startAfter(...cursorB.values).build(),
    );
    const firebaseGroup = (cursorPath: string) => firebaseQuery(
      firebaseCollectionGroup(firestore, "items"),
      firebaseOrderBy("rank", "desc"),
      firebaseOrderBy(firebaseDocumentId(), "desc"),
      firebaseStartAfter(7, cursorPath),
    );
    expect(queryEqual(compiledA.query, firebaseGroup("spaces/a/items/shared"))).toBe(true);
    expect(queryEqual(compiledB.query, firebaseGroup("spaces/b/items/shared"))).toBe(true);
    expect(() => firebaseGroup("shared")).toThrow();
  });

  it("keeps leaf document ids for root and nested collection cursors", () => {
    const nestedParent = key("spaces", "a");
    const root = collection<Item>("items").query().orderBy("rank", "desc").build();
    const nested = collection<Item>("items", { parent: nestedParent }).query().orderBy("rank", "desc").build();
    const rootCompiled = compileFirestoreQuery(firestore, root);
    const nestedCompiled = compileFirestoreQuery(firestore, nested);

    const carrier = snapshotWithRank(doc(firestore, "spaces/a/items/shared"), 7);
    const rootCursor = cursorFromSnapshot(carrier, rootCompiled.orders);
    const nestedCursor = cursorFromSnapshot(carrier, nestedCompiled.orders);
    expect(rootCursor.values).toEqual([7, "shared"]);
    expect(nestedCursor.values).toEqual([7, "shared"]);

    const compiledRoot = compileFirestoreQuery(
      firestore,
      collection<Item>("items").query().orderBy("rank", "desc").startAfter(...rootCursor.values).build(),
    );
    const compiledNested = compileFirestoreQuery(
      firestore,
      collection<Item>("items", { parent: nestedParent })
        .query()
        .orderBy("rank", "desc")
        .startAfter(...nestedCursor.values)
        .build(),
    );
    const firebaseCollectionQuery = (path: string, cursorId: string) => firebaseQuery(
      firebaseCollection(firestore, path),
      firebaseOrderBy("rank", "desc"),
      firebaseOrderBy(firebaseDocumentId(), "desc"),
      firebaseStartAfter(7, cursorId),
    );
    expect(queryEqual(compiledRoot.query, firebaseCollectionQuery("items", "shared"))).toBe(true);
    expect(queryEqual(compiledNested.query, firebaseCollectionQuery("spaces/a/items", "shared"))).toBe(true);
    expect(() => firebaseCollectionQuery("items", "spaces/a/items/shared")).toThrow();
  });
});

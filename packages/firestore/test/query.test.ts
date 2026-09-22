import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { DOCUMENT_ID, UnsupportedError, collection, collectionGroup, key, type StructuredQuery } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { compileFirestoreQuery, toFirestoreDocumentIdValue } from "../src/index.js";

interface Item {
  readonly done: boolean;
  readonly rank: number;
}

const app = initializeApp({ projectId: "demo-dalgo-js" }, "dalgo2firestore-tests");
const firestore = getFirestore(app);

describe("compileFirestoreQuery", () => {
  it("rejects a raw recursive query before Firestore receives it", () => {
    const recursive = { kind: "recursive-dtql", from: { kind: "table", name: "items", joins: [] } } as unknown as StructuredQuery<Item>;
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
});

import { collection, collectionGroup, key } from "@dalgo/core";
import { initializeApp } from "firebase/app";
import {
  collection as firebaseCollection,
  collectionGroup as firebaseCollectionGroup,
  doc as firebaseDoc,
  documentId as firebaseDocumentId,
  getDocs,
  getFirestore,
  limit as firebaseLimit,
  orderBy as firebaseOrderBy,
  query as firebaseQuery,
  queryEqual,
  startAfter as firebaseStartAfter,
  type DocumentReference,
  type Query,
  type QuerySnapshot,
} from "firebase/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirestoreDatabase } from "../src/index.js";

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return { ...actual, getDocs: vi.fn() };
});

interface Item { readonly done: boolean; readonly rank: number }

const app = initializeApp({ projectId: "demo-dalgo-js-database-query" }, "dalgo2firestore-database-query-tests");
const firestore = getFirestore(app);
const db = new FirestoreDatabase(firestore);
const mockedGetDocs = vi.mocked(getDocs);

interface SnapshotCarrier {
  readonly id: string;
  readonly ref: DocumentReference;
  readonly metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean };
  get(field: unknown): unknown;
  exists(): boolean;
  data(): Record<string, unknown>;
}

function snapshotCarrier(path: string, rank: number): SnapshotCarrier {
  const ref = firebaseDoc(firestore, path);
  return {
    id: ref.id,
    ref,
    metadata: { fromCache: false, hasPendingWrites: false },
    get: (field) => (field === "rank" ? rank : undefined),
    exists: () => true,
    data: () => ({ done: false, rank }),
  };
}

function querySnapshotCarrier(docs: readonly SnapshotCarrier[]): QuerySnapshot {
  return { docs, size: docs.length } as unknown as QuerySnapshot;
}

function expectedQuery(source: Query, cursor?: readonly unknown[]) {
  return firebaseQuery(source, firebaseOrderBy("rank", "desc"), firebaseOrderBy(firebaseDocumentId(), "desc"),
    ...(cursor === undefined ? [] : [firebaseStartAfter(...cursor)]), firebaseLimit(1));
}

beforeEach(() => { mockedGetDocs.mockReset(); });

describe("FirestoreDatabase query cursors", () => {
  it("uses full document paths for collection-group cursors despite later source mutation", async () => {
    const dalQuery = collectionGroup<Item>("items").orderBy("rank", "desc").limit(1).build();
    const originalKind = dalQuery.source.kind;
    const group = firebaseCollectionGroup(firestore, "items");

    mockedGetDocs.mockImplementationOnce(async (received) => {
      expect(queryEqual(received, expectedQuery(group))).toBe(true);
      await Promise.resolve();
      expect(Reflect.set(dalQuery.source, "kind", "collection")).toBe(true);
      return querySnapshotCarrier([snapshotCarrier("spaces/a/items/shared", 7)]);
    });

    try {
      const page = await db.query(dalQuery);

      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.key.path).toBe("spaces/a/items/shared");
      expect(page.records[0]?.data).toEqual({ done: false, rank: 7 });
      expect(page.nextCursor?.values).toEqual([7, "spaces/a/items/shared"]);
      expect(dalQuery.source.kind).toBe("collection");

      const cursor = page.nextCursor;
      if (cursor === undefined) throw new Error("expected a collection-group cursor");

      mockedGetDocs.mockImplementationOnce(async (received) => {
        expect(queryEqual(received, expectedQuery(group, cursor.values))).toBe(true);
        await Promise.resolve();
        return querySnapshotCarrier([]);
      });

      const resumed = await db.query(
        collectionGroup<Item>("items").orderBy("rank", "desc").startAfter(...cursor.values).limit(1).build(),
      );

      expect(resumed.records).toEqual([]);
      expect(resumed.nextCursor).toBeUndefined();
      expect(mockedGetDocs).toHaveBeenCalledTimes(2);
    } finally {
      expect(Reflect.set(dalQuery.source, "kind", originalKind)).toBe(true);
    }
  });

  it("keeps leaf document ids for nested collection cursors", async () => {
    mockedGetDocs.mockImplementationOnce(async (received) => {
      expect(queryEqual(received, expectedQuery(firebaseCollection(firestore, "spaces/a/items")))).toBe(true);
      await Promise.resolve();
      return querySnapshotCarrier([snapshotCarrier("spaces/a/items/shared", 7)]);
    });

    const page = await db.query(
      collection<Item>("items", { parent: key("spaces", "a") })
        .query()
        .orderBy("rank", "desc")
        .limit(1)
        .build(),
    );

    expect(page.records[0]?.key.path).toBe("spaces/a/items/shared");
    expect(page.records[0]?.data).toEqual({ done: false, rank: 7 });
    expect(page.nextCursor?.values).toEqual([7, "shared"]);
    expect(mockedGetDocs).toHaveBeenCalledTimes(1);
  });
});

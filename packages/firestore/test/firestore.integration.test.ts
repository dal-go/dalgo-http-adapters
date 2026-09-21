import { collection, executeRecursiveDTQLQuery, key, parseRecursiveDTQL, type DTQLSchema } from "@dalgo/core";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  getFirestore,
  terminate,
} from "firebase/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FirestoreDatabase } from "../src/index.js";

interface Item {
  readonly title: string;
  readonly done: boolean;
  readonly rank: number;
}

const app = initializeApp(
  { projectId: "demo-dalgo-js-e2e" },
  "dalgo2firestore-integration",
);
const firestore = getFirestore(app);
const db = new FirestoreDatabase(firestore);
const items = collection<Item>("items").in(key("spaces", "space-1"));

beforeAll(() => {
  connectFirestoreEmulator(firestore, "127.0.0.1", 8089);
});

afterAll(async () => {
  await terminate(firestore);
  await deleteApp(app);
});

describe("FirestoreDatabase", () => {
  it("writes, queries, pages, reads, and updates through the Web SDK", async () => {
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("milk"), {
        title: "Milk",
        done: false,
        rank: 1,
      });
      await transaction.set(items.key("bread"), {
        title: "Bread",
        done: false,
        rank: 2,
      });
    });

    const firstPage = await db.query(
      items.query()
        .where("done", "==", false)
        .orderBy("rank")
        .limit(1)
        .build(),
    );
    expect(firstPage.records.map(({ data }) => data.title)).toEqual(["Milk"]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await db.query(
      items.query()
        .where("done", "==", false)
        .orderBy("rank")
        .startAfter(...(firstPage.nextCursor?.values ?? []))
        .limit(1)
        .build(),
    );
    expect(secondPage.records.map(({ data }) => data.title)).toEqual(["Bread"]);

    const milk = await db.get<Item>(items.key("milk"));
    expect(milk.exists && milk.data.rank).toBe(1);

    await db.runReadwriteTransaction(async (transaction) => {
      const current = await transaction.get<Item>(items.key("milk"));
      expect(current.exists).toBe(true);
      await transaction.update(items.key("milk"), { done: true });
    });

    const completed = await db.query(
      items.query().where("done", "==", true).limit(10).build(),
    );
    expect(completed.records.map(({ data }) => data.title)).toEqual(["Milk"]);

    const schema: DTQLSchema = { tables: [{ name: "items", fields: ["title", "done", "rank"] }] };
    const recursive = parseRecursiveDTQL("from: {name: items, alias: outer}\nwhere:\n  exists:\n    query:\n      from: {name: items, alias: inner}\n      where: {left: {field: done, source: inner}, op: '==', right: {field: done, source: outer}}\norderBy: [{field: rank, source: outer}]\nlimit: 1\ncolumns: [{field: title, source: outer}]\n", schema);
    const page = await executeRecursiveDTQLQuery(db, recursive, {
      maxFetchedRows: 10,
      resolveSource: () => items.source,
    });
    expect(page.records.map((record) => record.data)).toEqual([{ title: "Milk" }]);
  });
});

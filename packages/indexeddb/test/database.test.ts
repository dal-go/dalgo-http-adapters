import { DOCUMENT_ID, AlreadyExistsError, NotFoundError, collection, collectionGroup, key } from "@dal-go/dalgo";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbDatabase } from "../src/index.js";

interface Item {
  readonly title: string;
  readonly done: boolean;
  readonly rank: number;
  readonly tags: readonly string[];
  readonly details?: { readonly owner: string };
}

function database(): IndexedDbDatabase {
  return new IndexedDbDatabase({ name: "test", factory: new IDBFactory() });
}

const items = collection<Item>("items");

describe("IndexedDbDatabase", () => {
  it("gets missing and existing records and preserves hierarchical keys", async () => {
    const db = database();
    const missing = await db.get(items.key("missing"));
    expect(missing.exists).toBe(false);

    const nestedKey = key("items", "milk", key("spaces", "home"));
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(nestedKey, { title: "Milk", done: false, rank: 1, tags: ["food"] });
    });
    const record = await db.get<Item>(nestedKey);
    expect(record.exists && record.data.title).toBe("Milk");
    expect(record.key.parent?.id).toBe("home");
  });

  it("rejects duplicate inserts with the DALgo error", async () => {
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => transaction.insert(
      items.key("milk"),
      { title: "Milk", done: false, rank: 1, tags: [] },
    ));
    await expect(db.runReadwriteTransaction(async (transaction) => transaction.insert(
      items.key("milk"),
      { title: "Other", done: false, rank: 2, tags: [] },
    ))).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("filters, orders, offsets, and pages collection records", async () => {
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("milk"), { title: "Milk", done: false, rank: 1, tags: ["food"], details: { owner: "a" } });
      await transaction.set(items.key("bread"), { title: "Bread", done: false, rank: 2, tags: ["food"], details: { owner: "b" } });
      await transaction.set(items.key("walk"), { title: "Walk", done: true, rank: 3, tags: ["health"] });
    });

    const first = await db.query(items.query()
      .where("tags", "array-contains", "food")
      .where("details.owner", "in", ["a", "b"])
      .orderBy("rank")
      .limit(1)
      .build());
    expect(first.records.map(({ data }) => data.title)).toEqual(["Milk"]);
    expect(first.nextCursor).toBeDefined();

    const second = await db.query(items.query()
      .where("done", "==", false)
      .orderBy("rank")
      .startAfter(...(first.nextCursor?.values ?? []))
      .limit(1)
      .build());
    expect(second.records.map(({ data }) => data.title)).toEqual(["Bread"]);

    const offset = await db.query(items.query().orderBy("rank").offset(1).limit(1).build());
    expect(offset.records.map(({ data }) => data.title)).toEqual(["Bread"]);

    const byKey = await db.query(items.query()
      .where(DOCUMENT_ID, "in", [items.key("bread")])
      .build());
    expect(byKey.records.map(({ data }) => data.title)).toEqual(["Bread"]);
  });

  it("queries collection groups and uses full paths for document ids", async () => {
    const db = database();
    const homeItem = key("items", "same", key("spaces", "home"));
    const workItem = key("items", "same", key("spaces", "work"));
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(homeItem, { title: "Home", done: false, rank: 1, tags: [] });
      await transaction.set(workItem, { title: "Work", done: false, rank: 2, tags: [] });
    });
    const result = await db.query(collectionGroup<Item>("items")
      .where(DOCUMENT_ID, "==", workItem)
      .build());
    expect(result.records.map(({ key: recordKey }) => recordKey.path)).toEqual([workItem.path]);
  });

  it("updates nested fields, deletes records, and fails updates for missing records", async () => {
    const db = database();
    const item = items.key("milk");
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(item, { title: "Milk", done: false, rank: 1, tags: [], details: { owner: "a" } });
      await transaction.update(item, { "details.owner": "b", done: true });
    });
    const updated = await db.get<Item>(item);
    expect(updated.exists && updated.data.details?.owner).toBe("b");
    expect(updated.exists && updated.data.done).toBe(true);

    await expect(db.runReadwriteTransaction(async (transaction) => {
      await transaction.update(items.key("missing"), { done: true });
    })).rejects.toBeInstanceOf(NotFoundError);

    await db.runReadwriteTransaction(async (transaction) => transaction.delete(item));
    expect((await db.get(item)).exists).toBe(false);
  });
});

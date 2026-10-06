import { DOCUMENT_ID, AlreadyExistsError, NotFoundError, UnsupportedError, collection, collectionGroup, executeRecursiveDTQLQuery, key, parseRecursiveDTQL, type DTQLSchema, type StructuredQuery } from "@dalgo/core";
import { IDBFactory, IDBIndex } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbDatabase, withIndexedDbQueryHints } from "../src/index.js";

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
  it("rejects a raw recursive query before opening a database", async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open");
    const db = new IndexedDbDatabase({ name: "reject-recursive", factory });
    const recursive = { kind: "recursive-dtql", from: { kind: "table", name: "items", joins: [] } } as unknown as StructuredQuery<Item>;
    await expect(db.query(recursive)).rejects.toThrow(UnsupportedError);
    await expect(db.query(recursive)).rejects.toThrow("core recursive executor");
    const disguised = { ...recursive, source: { kind: "collection", name: "items" }, filters: [], orders: [] } as unknown as StructuredQuery<Item>;
    await expect(db.query(disguised)).rejects.toThrow(UnsupportedError);
    expect(open).not.toHaveBeenCalled();
  });

  it("runs core recursive DTQL through bounded IndexedDB leaf scans", async () => {
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("milk"), { title: "Milk", done: false, rank: 1, tags: [] });
      await transaction.set(items.key("bread"), { title: "Bread", done: false, rank: 2, tags: [] });
      await transaction.set(items.key("walk"), { title: "Walk", done: true, rank: 3, tags: [] });
    });
    const schema: DTQLSchema = { tables: [{ name: "items", fields: ["title", "done", "rank", "tags"] }] };
    const recursive = parseRecursiveDTQL("from: {name: items, alias: outer}\nwhere:\n  exists:\n    query:\n      from: {name: items, alias: inner}\n      where: {left: {field: done, source: inner}, op: '==', right: {field: done, source: outer}}\norderBy: [{field: rank, source: outer}]\nlimit: 1\ncolumns: [{field: title, source: outer}]\n", schema);

    const page = await executeRecursiveDTQLQuery(db, recursive, { maxFetchedRows: 20 });

    expect(page.records.map((record) => record.data)).toEqual([{ title: "Milk" }]);
    await db.close();
  });
  it("uses separate named object stores when collections are configured", async () => {
    const factory = new IDBFactory();
    const db = new IndexedDbDatabase({
      name: "named-collections",
      factory,
      collections: ["chinook.Customer", "chinook.Invoice"],
    });
    const customers = collection<{ name: string }>("chinook.Customer");
    const invoices = collection<{ total: number }>("chinook.Invoice");
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(customers.key(1), { name: "Alice" });
      await transaction.set(invoices.key(2), { total: 12 });
    });

    expect((await db.getMany([customers.key(1), invoices.key(2)])).map((record) => record.exists)).toEqual([true, true]);
    expect((await db.query(customers.query().build())).records.map((record) => record.data.name)).toEqual(["Alice"]);
    expect((await db.query(invoices.query().build())).records.map((record) => record.data.total)).toEqual([12]);
    await expect(db.get(key("other", 1))).rejects.toThrow("not configured");
    await db.close();

    const native = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("named-collections");
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { reject(request.error ?? new Error("failed to open database")); };
    });
    expect(Array.from(native.objectStoreNames)).toEqual(["chinook.Customer", "chinook.Invoice"]);
    native.close();
  });

  it("maps schema-qualified collections to plain object store names", async () => {
    const factory = new IDBFactory();
    const db = new IndexedDbDatabase({
      name: "chinook",
      factory,
      collections: [
        { name: "main.Customer", storeName: "Customer" },
        { name: "main.Invoice", storeName: "Invoice" },
      ],
    });
    const customer = collection<{ name: string }>("main.Customer");
    const invoice = collection<{ total: number }>("main.Invoice");
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(customer.key(1), { name: "Alice" });
      await transaction.set(invoice.key(1), { total: 42 });
    });
    expect((await db.query(customer.query().build())).records.map((record) => record.data.name)).toEqual(["Alice"]);
    expect((await db.query(invoice.query().build())).records.map((record) => record.data.total)).toEqual([42]);
    await db.close();

    const native = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("chinook");
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { reject(request.error ?? new Error("failed to open database")); };
    });
    expect(Array.from(native.objectStoreNames)).toEqual(["Customer", "Invoice"]);
    native.close();
  });

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

  it("compares hinted decimal and wide integer tokens exactly while preserving text ordering", async () => {
    interface Money { readonly amount: string; readonly zip: string }
    const money = collection<Money>("money");
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(money.key("a"), { amount: "2", zip: "010" });
      await transaction.set(money.key("b"), { amount: "10.00", zip: "001" });
      await transaction.set(money.key("c"), { amount: "9007199254740993", zip: "1" });
      await transaction.set(money.key("d"), { amount: "9007199254740992", zip: "02" });
    });
    const hint = { numericFields: ["amount"] };
    const first = await db.query(withIndexedDbQueryHints(money.query().orderBy("amount").limit(2).build(), hint));
    expect(first.records.map((record) => record.key.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeDefined();
    const second = await db.query(withIndexedDbQueryHints(money.query().orderBy("amount")
      .startAfter(...(first.nextCursor?.values ?? [])).limit(2).build(), hint));
    expect(second.records.map((record) => record.key.id)).toEqual(["d", "c"]);
    const filtered = await db.query(withIndexedDbQueryHints(money.query()
      .where("amount", ">", "9007199254740992").build(), hint));
    expect(filtered.records.map((record) => record.key.id)).toEqual(["c"]);
    const text = await db.query(money.query().orderBy("zip").build());
    expect(text.records.map((record) => record.data.zip)).toEqual(["001", "010", "02", "1"]);
    await db.close();
  });

  it("scans with a cursor and retains only the bounded page", async () => {
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      for (let index = 0; index < 1000; index += 1) {
        await transaction.set(items.key(index), { title: String(index), done: false, rank: 1000 - index, tags: [] });
      }
    });
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    const result = await db.query(items.query().orderBy("rank").limit(5).build());
    expect(result.records.map((record) => record.data.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(getAll).not.toHaveBeenCalled();
    getAll.mockRestore();
    await db.close();
  });

  it("aborts an IndexedDB cursor query without returning a partial page", async () => {
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(items.key("one"), { title: "one", done: false, rank: 1, tags: [] });
    });
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(db.query(withIndexedDbQueryHints(items.query().build(), { signal: abort.signal })))
      .rejects.toThrow("stop");
    await db.close();
  });

  it("rejects a negative limit even when a positive offset would mask it", async () => {
    const db = database();
    const query = { ...items.query().build(), offset: 3, limit: -1 };
    await expect(db.query(query)).rejects.toThrow("nonnegative safe integers");
    await db.close();
  });

  it("supports decimal edge spellings and excludes null from hinted ordered filters", async () => {
    const numbers = collection<{ amount: string | null }>("numbers");
    const db = database();
    await db.runReadwriteTransaction(async (transaction) => {
      await transaction.set(numbers.key("null"), { amount: null });
      await transaction.set(numbers.key("half"), { amount: ".5" });
      await transaction.set(numbers.key("one"), { amount: "1." });
      await transaction.set(numbers.key("two"), { amount: "2e0" });
    });
    const hint = { numericFields: ["amount"] };
    const less = await db.query(withIndexedDbQueryHints(numbers.query().where("amount", "<", "1.").build(), hint));
    expect(less.records.map((record) => record.key.id)).toEqual(["half"]);
    const equalNull = await db.query(withIndexedDbQueryHints(numbers.query().where("amount", "==", null).build(), hint));
    expect(equalNull.records.map((record) => record.key.id)).toEqual(["null"]);
    const sorted = await db.query(withIndexedDbQueryHints(numbers.query().orderBy("amount").build(), hint));
    expect(sorted.records.map((record) => record.key.id)).toEqual(["null", "half", "one", "two"]);
    await db.close();
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

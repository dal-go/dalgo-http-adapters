import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import {
  CouchDbHttpError,
  CouchDbRequestError,
  NativeCouchDbDatabase,
  type NativeCouchDbDatabaseOptions,
} from "../src/index.js";

const env = (globalThis as { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } }).process?.env ?? {};
const liveUrl = env.COUCHDB_NATIVE_URL;
const liveUser = env.COUCHDB_NATIVE_USER ?? "reader";
const livePassword = env.COUCHDB_NATIVE_PASSWORD ?? "readerpass";
const indexDdoc = env.COUCHDB_NATIVE_INDEX_DDOC ?? "_design/status-id-ddoc";
const indexName = env.COUCHDB_NATIVE_INDEX_NAME ?? "status-id-index";

const basic = `Basic ${btoa(`${liveUser}:${livePassword}`)}`;
const items = collection<{
  title: string;
  status?: string;
  nullable?: string | null;
  nested?: { a?: number | null; b?: null };
}>("items");

function liveDatabase(options: Partial<NativeCouchDbDatabaseOptions> = {}): NativeCouchDbDatabase {
  return new NativeCouchDbDatabase({
    databaseUrl: liveUrl ?? "https://couch.example.invalid/app",
    collection: "items",
    headers: () => ({ authorization: basic }),
    timeoutMs: 10_000,
    permittedIndexes: [{
      ddoc: indexDdoc,
      name: indexName,
      fields: [
        { field: "status", direction: "asc" },
        { field: "_id", direction: "asc" },
      ],
    }],
    ...options,
  });
}

describe.skipIf(liveUrl === undefined)("NativeCouchDbDatabase against a disposable CouchDB", () => {
  it("reads pre-existing documents with native string ids and nested/null data", async () => {
    const database = liveDatabase();
    const milk = await database.get(key("items", "milk"));
    expect(milk).toMatchObject({
      key: key("items", "milk"),
      exists: true,
      metadata: { id: "milk", revision: expect.stringMatching(/^1-/u) },
      data: { _id: "milk", title: "Milk", status: "open", nullable: null, nested: { a: 1, b: null } },
    });
    expect(milk.data).toHaveProperty("_rev");

    const unicode = await database.get(key("items", "unicode"));
    expect(unicode).toMatchObject({ data: { _id: "unicode", title: "Ünïcode", nested: { a: null } } });
    expect((await database.get(key("items", "id with space")))).toMatchObject({ data: { _id: "id with space" } });
    expect((await database.get(key("items", "id/slash")))).toMatchObject({ data: { _id: "id/slash" } });
    await expect(database.get(key("items", "does-not-exist"))).resolves.toMatchObject({ exists: false });
  });

  it("reads getMany in request order with the exact batch bound", async () => {
    const database = liveDatabase({ maxGetManyKeys: 2, maxParallelReads: 2 });
    const snapshots = await database.getMany([
      key("items", "milk"),
      key("items", "does-not-exist"),
      key("items", "bread"),
    ].slice(0, 2));
    expect(snapshots.map((snapshot) => snapshot.key.id)).toEqual(["milk", "does-not-exist"]);
    await expect(database.getMany([key("items", "milk"), key("items", "bread"), key("items", "eggs")]))
      .rejects.toBeInstanceOf(UnsupportedError);
  });

  it("keeps CouchDB NULL/missing semantics faithful", async () => {
    const database = liveDatabase();
    const explicitNull = await database.query({ ...items.query().where("nullable", "==", null).build(), limit: 10 });
    expect(explicitNull.records.map((record) => record.key.id)).toEqual(["milk"]);
    const presentNotNull = await database.query({ ...items.query().where("nullable", "!=", null).build(), limit: 10 });
    expect(presentNotNull.records.map((record) => record.key.id)).toEqual(["eggs"]);
    const missing = await database.query({ ...items.query().where("status", "==", "open").limit(10).build() });
    expect(missing.records.some((record) => record.key.id === "bread")).toBe(true);
    expect(missing.records.some((record) => record.key.id === "eggs")).toBe(false);
  });

  it("pages an explicitly indexed ordered query, binds the cursor and rejects reuse", async () => {
    const database = liveDatabase();
    const first = await database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).build());
    expect(first.records).toHaveLength(2);
    expect(first.records.map((record) => record.data)).toEqual(first.records.map((record) => expect.objectContaining({ _id: record.key.id })));
    const cursor = first.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("expected a native CouchDB bookmark cursor");

    await expect(database.query(items.query().where("status", "==", "done").orderBy("status").limit(2).startAfter(cursor).build()))
      .rejects.toThrow("does not match");

    const second = await database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build());
    expect(second.records).toHaveLength(2);
    expect(second.records.map((record) => record.key.id).sort()).not.toEqual(first.records.map((record) => record.key.id).sort());

    await expect(database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build()))
      .rejects.toThrow("already been used");

    const third = await database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(...(second.nextCursor?.values ?? [])).build());
    expect(third.records).toEqual([]);
  });

  it("rejects tampered, forged and foreign cursor handles before the provider", async () => {
    const database = liveDatabase();
    const first = await database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).build());
    const cursor = first.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("expected a native CouchDB bookmark cursor");
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(tampered).build()))
      .rejects.toThrow("invalid or unknown to this adapter instance");
    await expect(database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(`nc1_${"A".repeat(43)}`).build()))
      .rejects.toThrow("invalid or unknown to this adapter instance");

    const foreign = liveDatabase();
    await expect(foreign.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build()))
      .rejects.toThrow("invalid or unknown to this adapter instance");

    const second = await database.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build());
    expect(second.records.length).toBeGreaterThan(0);
  });

  it("honours an explicit projection and never drops the requested _id", async () => {
    const database = liveDatabase();
    const page = await database.query({ ...items.query().where("status", "==", "open").limit(2).build(), projection: ["_id", "title"] });
    expect(page.records).toHaveLength(2);
    for (const record of page.records) {
      expect(record.data).toEqual({ _id: record.key.id, title: expect.any(String) });
      expect(record.metadata).toEqual({ id: record.key.id });
    }
    await expect(database.query({ ...items.query().limit(1).build(), projection: ["title"] }))
      .rejects.toThrow("must include _id");
  });

  it("discovers the configured database, indexes and sampled fields without admin APIs", async () => {
    const database = liveDatabase({ maxSampleDocuments: 20 });
    const connection = await database.testConnection();
    expect(connection).toMatchObject({ ok: true, collection: "items", database: { database: "app" } });
    const indexes = await database.listIndexes();
    expect(indexes.status).toBe("available");
    if (indexes.status === "available") {
      expect(indexes.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "_all_docs", type: "special" }),
        expect.objectContaining({ name: indexName, type: "json", fields: [{ field: "status", direction: "asc" }, { field: "_id", direction: "asc" }] }),
      ]));
    }
    const fields = await database.sampleFields();
    expect(fields).toMatchObject({ status: "sampled", sampleSize: expect.any(Number) });
    if (fields.status === "sampled") {
      expect(fields.fields).toEqual(expect.arrayContaining(["_id", "_rev", "title", "status", "nested"]));
      expect(fields.fields).not.toContain("validate_doc_update");
    }
    const described = await database.describe();
    expect(described).toMatchObject({ storage: "native-rows", readOnly: true, resource: { database: "app", collection: "items" } });
  });

  it("refuses every mutation before contacting the read-only provider", async () => {
    const database = liveDatabase();
    await expect(database.insert(key("items", "write-probe"), { title: "no" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.set(key("items", "write-probe"), { title: "no" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.update(key("items", "write-probe"), { title: "no" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.delete(key("items", "write-probe"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.get(key("items", "write-probe"))).resolves.toMatchObject({ exists: false });
  });

  it("reports bad auth and byte bounds without leaking a credential or body", async () => {
    const bad = liveDatabase({
      headers: () => ({ authorization: `Basic ${btoa(`native-live-no-such-user:wrong-${livePassword}`)}` }),
    });
    const readError = await bad.get(key("items", "milk")).catch((reason: unknown) => reason);
    expect(readError).toBeInstanceOf(CouchDbHttpError);
    expect(String(readError)).not.toContain(livePassword);
    await expect(bad.testConnection()).resolves.toMatchObject({ ok: false, reason: "unauthorized", httpStatus: 401 });

    const bounded = liveDatabase({ maxResponseBytes: 64 });
    await expect(bounded.query(items.query().where("status", "==", "open").limit(2).build()))
      .rejects.toThrow("maxResponseBytes");
    const requestBounded = liveDatabase({ maxRequestBytes: 32 });
    await expect(requestBounded.query(items.query().where("status", "==", "a".repeat(128)).build()))
      .rejects.toThrow("maxRequestBytes");
    const batchBounded = liveDatabase({ maxGetManyKeys: 1 });
    await expect(batchBounded.getMany([key("items", "milk"), key("items", "eggs")]))
      .rejects.toBeInstanceOf(UnsupportedError);
    const bytesBounded = liveDatabase({ maxGetManyBytes: 1 });
    await expect(bytesBounded.getMany([key("items", "milk"), key("items", "eggs")]))
      .rejects.toThrow("maxGetManyBytes");
  });

  it("does no header or provider work for an already-aborted caller", async () => {
    const database = liveDatabase();
    const controller = new AbortController();
    controller.abort();
    await expect(database.queryWithSignal(items.query().build(), controller.signal))
      .rejects.toBeInstanceOf(QueryCancelledError);
  });

  it("redacts a real transport failure without exposing the configured header", async () => {
    const database = liveDatabase({
      databaseUrl: "http://127.0.0.1:1/app",
      headers: () => ({ authorization: "Bearer must-not-leak" }),
      timeoutMs: 1_000,
    });
    const error = await database.query(items.query().build()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CouchDbRequestError);
    expect(String(error)).not.toContain("must-not-leak");
  });
});

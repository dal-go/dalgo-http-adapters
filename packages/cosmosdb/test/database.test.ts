import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";

import { CosmosHttpError, CosmosNoSqlDatabase } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function testDatabase() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const authorization = vi.fn(() => "type=resource&ver=1.0&sig=opaque");
  return { database: new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization, fetch }), fetch, authorization };
}

function request(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetch.mock.calls[call]?.[1] as RequestInit;
}

describe("CosmosNoSqlDatabase", () => {
  it("uses a supplied authorization header and partition header for a point read", async () => {
    const { database, fetch, authorization } = testDatabase();
    fetch.mockResolvedValueOnce(response(200, { id: "Im1pbGsi", __dalgo_collection: "items", __dalgo_id: "milk", data: { done: false }, _etag: "etag" }));
    await expect(database.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: true, data: { done: false }, metadata: { etag: "etag" } });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.documents.azure.com/dbs/app/colls/records/docs/Im1pbGsi");
    expect(request(fetch).method).toBe("GET");
    expect(request(fetch).headers).toMatchObject({ authorization: "type=resource&ver=1.0&sig=opaque", "x-ms-version": "2018-12-31", "x-ms-documentdb-partitionkey": '["items"]' });
    expect(authorization).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", resourcePath: "dbs/app/colls/records/docs/Im1pbGsi", resourceType: "docs" }));
  });

  it("preserves getMany order through individual partition-aware reads", async () => {
    const { database, fetch } = testDatabase();
    fetch.mockResolvedValueOnce(response(404));
    fetch.mockResolvedValueOnce(response(200, { id: "ImIi", __dalgo_collection: "items", __dalgo_id: "b", data: { n: 2 } }));
    await expect(database.getMany<{ n: number }>([key("items", "missing"), key("items", "b")])).resolves.toEqual([
      { key: key("items", "missing"), exists: false }, { key: key("items", "b"), exists: true, data: { n: 2 }, metadata: {} },
    ]);
  });

  it("creates a physical layout and maps conflict to AlreadyExistsError", async () => {
    const { database, fetch } = testDatabase();
    fetch.mockResolvedValueOnce(response(201));
    await database.insert(key("items", "milk"), { done: false });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.documents.azure.com/dbs/app/colls/records/docs");
    expect(request(fetch).method).toBe("POST");
    expect(JSON.parse(request(fetch).body as string)).toEqual({ id: "Im1pbGsi", __dalgo_collection: "items", __dalgo_id: "milk", __dalgo_partition: "items", data: { done: false } });
    fetch.mockResolvedValueOnce(response(409, { code: "Conflict" }));
    await expect(database.insert(key("items", "milk"), { done: false })).rejects.toMatchObject({ name: "AlreadyExistsError", key: key("items", "milk") });
  });

  it("upserts both absent and existing documents, then idempotently deletes one partition-scoped document", async () => {
    const { database, fetch } = testDatabase();
    fetch.mockResolvedValueOnce(response(201));
    fetch.mockResolvedValueOnce(response(200));
    fetch.mockResolvedValueOnce(response(404));
    await database.set(key("items", "milk"), { done: true });
    await database.set(key("items", "milk"), { done: false });
    await database.delete(key("items", "milk"));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.documents.azure.com/dbs/app/colls/records/docs");
    expect(request(fetch).method).toBe("POST");
    expect(request(fetch).headers).toMatchObject({ "x-ms-documentdb-is-upsert": "True" });
    expect(JSON.parse(request(fetch).body as string)).toMatchObject({ __dalgo_collection: "items", __dalgo_id: "milk", data: { done: true } });
    expect(request(fetch, 1).headers).toMatchObject({ "x-ms-documentdb-is-upsert": "True" });
    expect(JSON.parse(request(fetch, 1).body as string)).toMatchObject({ data: { done: false } });
    expect(request(fetch, 2).method).toBe("DELETE");
    expect(request(fetch, 2).headers).toMatchObject({ "x-ms-documentdb-partitionkey": '["items"]' });
  });

  it("queries one configured partition with parameterized filters and opaque cursor continuation", async () => {
    const { database, fetch } = testDatabase();
    const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { Documents: [{ id: "ImEi", __dalgo_collection: "items", __dalgo_id: "a", data: { done: false } }] }, { "x-ms-continuation": "opaque-token" }));
    const first = await database.query(items.query().where("done", "==", false).limit(10).build());
    expect(first.records).toEqual([{ key: key("items", "a"), exists: true, data: { done: false }, metadata: {} }]);
    expect(JSON.parse(request(fetch).body as string)).toEqual({ query: 'SELECT * FROM c WHERE c.__dalgo_collection = @collection AND c.data["done"] = @p0', parameters: [{ name: "@collection", value: "items" }, { name: "@p0", value: false }] });
    expect(request(fetch).headers).toMatchObject({ "content-type": "application/query+json", "x-ms-documentdb-isquery": "True", "x-ms-max-item-count": "10" });
    fetch.mockResolvedValueOnce(response(200, { Documents: [] }));
    await database.query(items.query().startAfter(...(first.nextCursor?.values ?? [])).build());
    expect(request(fetch, 1).headers).toMatchObject({ "x-ms-continuation": "opaque-token" });
  });

  it("rejects callback transactions, updates, ordering, cross-collection queries, and untrusted cursors before a request", async () => {
    const { database, fetch } = testDatabase();
    const items = collection<{ done: boolean }>("items");
    await expect(database.update(key("items", "a"), { done: true })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.runReadwriteTransaction(() => Promise.resolve("nope"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(items.query().orderBy(DOCUMENT_ID).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(items.query().startAfter("not-an-adapter-cursor").build())).rejects.toThrow("cursor returned by this adapter");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps non-success response bodies out of happy paths", async () => {
    const { database, fetch } = testDatabase();
    fetch.mockResolvedValueOnce(response(429, { secret: "must not escape" }, { "x-ms-retry-after-ms": "25" }));
    await expect(database.get(key("items", "a"))).rejects.toMatchObject({ name: "CosmosHttpError", status: 429, retryAfterMs: 25 });
    fetch.mockResolvedValueOnce(response(500, { secret: "must not escape" }));
    try { await database.get(key("items", "b")); } catch (error: unknown) { expect(error).toBeInstanceOf(CosmosHttpError); expect(error).not.toHaveProperty("body"); }
  });

  it("resolves a stateful partition mapping once per operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const partitionKey = vi.fn(() => `p${String(partitionKey.mock.calls.length)}`);
    const database = new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization: () => "resource", partitionKey, fetch });
    fetch.mockResolvedValueOnce(response(201));
    await database.insert(key("items", "a"), { done: false });
    expect(partitionKey).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request(fetch).body as string)).toMatchObject({ __dalgo_partition: "p1" });
    expect(request(fetch).headers).toMatchObject({ "x-ms-documentdb-partitionkey": '["p1"]' });
  });

  it("rejects malformed IDs and returned physical documents before decoding", async () => {
    const { database, fetch } = testDatabase();
    await expect(database.get(key("items", 1.5))).rejects.toThrow("safe integers");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(response(200, { id: "wrong", __dalgo_collection: "items", __dalgo_id: "a", data: { done: false } }));
    await expect(database.get(key("items", "a"))).rejects.toThrow("does not match");
  });

  it("bounds requests, responses, getMany, and query limits before sending unbounded work", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const database = new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization: () => "resource", fetch, maxRequestBytes: 20, maxResponseBytes: 20, maxGetManyKeys: 1, maxQueryLimit: 2 });
    await expect(database.insert(key("items", "a"), { long: "this is too large" })).rejects.toThrow("maxRequestBytes");
    await expect(database.getMany([key("items", "a"), key("items", "b")])).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(collection("items").query().limit(3).build())).rejects.toBeInstanceOf(UnsupportedError);
    fetch.mockResolvedValueOnce(response(200, { id: "ImEi", __dalgo_collection: "items", __dalgo_id: "a", data: {} }, { "content-length": "99" }));
    await expect(database.get(key("items", "a"))).rejects.toThrow("maxResponseBytes");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe constructor and authorization settings", async () => {
    const options = { endpoint: "https://example.documents.azure.com/path", databaseId: "app", containerId: "records", authorization: () => "resource" };
    expect(() => new CosmosNoSqlDatabase(options)).toThrow("origin");
    expect(() => new CosmosNoSqlDatabase({ ...options, endpoint: "https://example.documents.azure.com", partitionKeyField: "data" })).toThrow("reserved");
    expect(() => new CosmosNoSqlDatabase({ ...options, endpoint: "https://example.documents.azure.com", databaseId: "app/x" })).toThrow("ASCII");
    const { database, fetch } = testDatabase();
    const unsafe = new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization: () => "bad\nheader", fetch });
    await expect(unsafe.get(key("items", "a"))).rejects.toThrow("unsafe header");
    expect(fetch).not.toHaveBeenCalled();
    expect(database).toBeDefined();
  });

  it("rejects non-finite and negative-zero partition mappings before serialization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const base = { endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization: () => "resource", fetch };
    await expect(new CosmosNoSqlDatabase({ ...base, partitionKey: () => Number.NaN }).get(key("items", "a"))).rejects.toThrow("finite");
    await expect(new CosmosNoSqlDatabase({ ...base, partitionKey: () => -0 }).get(key("items", "a"))).rejects.toThrow("finite");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strictly rejects lossy JSON documents and document-ID filter values", async () => {
    const { database, fetch } = testDatabase();
    await expect(database.insert(key("items", "a"), { value: BigInt(1) })).rejects.toThrow("JSON values");
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    await expect(database.set(key("items", "a"), cycle)).rejects.toThrow("cycles");
    const items = collection<{ done: boolean }>("items");
    await expect(database.query(items.query().where(DOCUMENT_ID, "==", 1.5).build())).rejects.toThrow("valid key ID");
    await expect(database.query(items.query().where("done", "==", Number.NaN).build())).rejects.toThrow("finite");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the deadline through a stalled response stream and cancels the reader", async () => {
    let cancelled = false;
    let resolvePull: (() => void) | undefined;
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>((resolve) => { resolvePull = resolve; }), cancel: () => { cancelled = true; } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stalled, { status: 200 }));
    const database = new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization: () => "resource", fetch, timeoutMs: 1 });
    await expect(database.get(key("items", "a"))).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
    resolvePull?.();
  });
});

import { DOCUMENT_ID, Key, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { AzureTableDatabase, AzureTableHttpError, AzureTableRequestError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response { return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers }); }
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const authorization = vi.fn(() => "Bearer opaque-token");
  return { fetch, authorization, database: new AzureTableDatabase({ endpoint: "https://example.table.core.windows.net", authorization, tableName: () => "Records", fetch, now: () => new Date("2026-01-02T03:04:05Z") }) };
}
function init(fetch: ReturnType<typeof vi.fn>, index = 0): RequestInit { return fetch.mock.calls[index]?.[1] as RequestInit; }

describe("AzureTableDatabase", () => {
  it("maps a top-level DALgo key to one configured table, partition and opaque RowKey", async () => {
    const { database, fetch, authorization } = setup();
    fetch.mockResolvedValueOnce(response(200, { PartitionKey: "items", RowKey: "Im1pbGsi", done: false, "odata.etag": 'W/"etag"' }));
    await expect(database.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: true, data: { done: false }, metadata: { etag: 'W/"etag"' } });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.table.core.windows.net/Records(PartitionKey='items',RowKey='Im1pbGsi')");
    expect(init(fetch).headers).toMatchObject({ authorization: "Bearer opaque-token", "x-ms-date": "Fri, 02 Jan 2026 03:04:05 GMT", "x-ms-version": "2019-02-02", accept: "application/json;odata=fullmetadata" });
    expect(authorization).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", serviceVersion: "2019-02-02" }));
  });

  it("implements insert, insert-or-replace, merge and idempotent delete with documented methods", async () => {
    const { database, fetch } = setup();
    fetch.mockResolvedValueOnce(response(204)); fetch.mockResolvedValueOnce(response(204)); fetch.mockResolvedValueOnce(response(204)); fetch.mockResolvedValueOnce(response(404));
    await database.insert(key("items", "milk"), { done: false }); await database.set(key("items", "milk"), { done: true }); await database.update(key("items", "milk"), { done: false }); await database.delete(key("items", "milk"));
    expect(init(fetch).method).toBe("POST"); expect(JSON.parse(init(fetch).body as string)).toEqual({ PartitionKey: "items", RowKey: "Im1pbGsi", done: false });
    expect(init(fetch, 1).method).toBe("PUT"); expect(init(fetch, 1).headers).not.toHaveProperty("if-match");
    expect(init(fetch, 2).method).toBe("MERGE"); expect(init(fetch, 2).headers).toMatchObject({ "if-match": "*" });
    expect(init(fetch, 3).method).toBe("DELETE"); expect(init(fetch, 3).headers).toMatchObject({ "if-match": "*" });
  });

  it("maps conflicts and absent updates without leaking an Azure body", async () => {
    const { database, fetch } = setup();
    fetch.mockResolvedValueOnce(response(409, { secret: "no" }));
    await expect(database.insert(key("items", "milk"), { done: false })).rejects.toMatchObject({ name: "AlreadyExistsError" });
    fetch.mockResolvedValueOnce(response(404, { secret: "no" }));
    await expect(database.update(key("items", "milk"), { done: false })).rejects.toMatchObject({ name: "NotFoundError" });
    fetch.mockResolvedValueOnce(response(500, { secret: "no" }));
    await expect(database.get(key("items", "milk"))).rejects.toBeInstanceOf(AzureTableHttpError);
  });

  it("exposes deliberate ETag conditional operations", async () => {
    const { database, fetch } = setup();
    fetch.mockResolvedValueOnce(response(204)); fetch.mockResolvedValueOnce(response(204)); fetch.mockResolvedValueOnce(response(204));
    await database.setIfMatch(key("items", "milk"), { done: true }, 'W/"old"');
    await database.updateIfMatch(key("items", "milk"), { done: false }, 'W/"old"');
    await database.deleteIfMatch(key("items", "milk"), 'W/"old"');
    expect(init(fetch).headers).toMatchObject({ "if-match": 'W/"old"' }); expect(init(fetch, 1).method).toBe("MERGE"); expect(init(fetch, 2).method).toBe("DELETE");
  });

  it("uses OData filters, service continuation headers, and a bound opaque cursor", async () => {
    const { database, fetch } = setup(); const items = collection<{ done: boolean; rank: number }>("items");
    fetch.mockResolvedValueOnce(response(200, { value: [{ PartitionKey: "items", RowKey: "ImEi", done: false, rank: 2 }] }, { "x-ms-continuation-NextPartitionKey": "opaque-p", "x-ms-continuation-NextRowKey": "opaque-r" }));
    const page = await database.query(items.query().where("done", "==", false).where("rank", ">", 1).limit(10).build());
    expect(page.records).toEqual([{ key: key("items", "a"), exists: true, data: { done: false, rank: 2 }, metadata: {} }]);
    expect(fetch.mock.calls[0]?.[0]).toContain("%24filter=PartitionKey+eq+%27items%27+and+done+eq+false+and+rank+gt+1");
    fetch.mockResolvedValueOnce(response(200, { value: [] }));
    await database.query(items.query().startAfter(...(page.nextCursor?.values ?? [])).build());
    expect(fetch.mock.calls[1]?.[0]).toContain("NextPartitionKey=opaque-p"); expect(fetch.mock.calls[1]?.[0]).toContain("NextRowKey=opaque-r");
  });

  it("supports document-id equality with the adapter RowKey encoding and rejects dishonest query semantics", async () => {
    const { database, fetch } = setup(); const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { value: [] }));
    await database.query(items.query().where(DOCUMENT_ID, "==", "milk").build());
    expect(fetch.mock.calls[0]?.[0]).toContain("RowKey+eq+%27Im1pbGsi%27");
    await expect(database.query(items.query().orderBy(DOCUMENT_ID).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(items.query().offset(1).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(items.query().where("done", "in", [true]).build())).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("bounds getMany, payloads, responses, and unsafe input before unbounded work", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const database = new AzureTableDatabase({ endpoint: "https://example.table.core.windows.net", authorization: () => "Bearer token", tableName: () => "Records", fetch, maxGetManyKeys: 1, maxRequestBytes: 20, maxResponseBytes: 20 });
    await expect(database.getMany([key("items", "a"), key("items", "b")])).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.insert(key("items", "a"), { long: "oversized" })).rejects.toThrow("maxRequestBytes");
    await expect(database.insert(key("items", "a"), { nested: { no: true } })).rejects.toBeInstanceOf(UnsupportedError);
    fetch.mockResolvedValueOnce(response(200, { PartitionKey: "items", RowKey: "ImEi" }, { "content-length": "999" }));
    await expect(database.get(key("items", "a"))).rejects.toThrow("maxResponseBytes");
  });

  it("redacts provider and transport failures and rejects unsafe auth before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const database = new AzureTableDatabase({ endpoint: "https://example.table.core.windows.net", authorization: () => { throw new Error("secret"); }, tableName: () => "Records", fetch });
    await expect(database.get(key("items", "a"))).rejects.toBeInstanceOf(AzureTableRequestError); expect(fetch).not.toHaveBeenCalled();
    const unsafe = new AzureTableDatabase({ endpoint: "https://example.table.core.windows.net", authorization: () => "bad\nsecret", tableName: () => "Records", fetch });
    await expect(unsafe.get(key("items", "a"))).rejects.toThrow("CR/LF"); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects callback transactions and nested keys without making requests", async () => {
    const { database, fetch } = setup();
    await expect(database.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.get(new Key("children", "x", key("parents", "p")))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

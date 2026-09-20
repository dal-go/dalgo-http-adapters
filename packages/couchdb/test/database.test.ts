import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";

import { CouchDbConflictError, CouchDbDatabase, CouchDbHttpError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}
function database(options: Partial<ConstructorParameters<typeof CouchDbDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return { fetch, headers, database: new CouchDbDatabase({ databaseUrl: "https://couch.example.com/app", fetch, headers, ...options }) };
}
function request(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit { return fetch.mock.calls[call]?.[1] as RequestInit; }
function document(id: string, rev = "1-a", data: unknown = { done: false }) { return { _id: id, _rev: rev, __dalgo_collection: "items", __dalgo_id: "milk", data }; }

describe("CouchDbDatabase", () => {
  it("uses a redaction-safe refreshed header provider and decodes _id/_rev metadata", async () => {
    const { database: db, fetch, headers } = database();
    fetch.mockResolvedValueOnce(response(200, document("WyJpdGVtcyIsIm1pbGsiXQ", "2-current")));
    await expect(db.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: true, data: { done: false }, metadata: { revision: "2-current" } });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://couch.example.com/app/WyJpdGVtcyIsIm1pbGsiXQ");
    expect(request(fetch).headers).toMatchObject({ authorization: "Bearer opaque", accept: "application/json" });
    expect(headers).toHaveBeenCalledTimes(1);
  });

  it("creates explicit _id documents and maps a create conflict", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(201, { ok: true, id: "x", rev: "1-a" }));
    await db.insert(key("items", "milk"), { done: false });
    expect(request(fetch).method).toBe("PUT");
    expect(JSON.parse(request(fetch).body as string)).toEqual({ _id: "WyJpdGVtcyIsIm1pbGsiXQ", __dalgo_collection: "items", __dalgo_id: "milk", data: { done: false } });
    fetch.mockResolvedValueOnce(response(409, { reason: "secret never leaks" }));
    await expect(db.insert(key("items", "milk"), { done: false })).rejects.toMatchObject({ name: "AlreadyExistsError" });
  });

  it("reads a revision before set/delete and surfaces an MVCC conflict rather than overwriting", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, document("WyJpdGVtcyIsIm1pbGsiXQ", "3-current")));
    fetch.mockResolvedValueOnce(response(409, { error: "conflict", reason: "secret" }));
    await expect(db.set(key("items", "milk"), { done: true })).rejects.toBeInstanceOf(CouchDbConflictError);
    expect(JSON.parse(request(fetch, 1).body as string)).toMatchObject({ _rev: "3-current", data: { done: true } });
    fetch.mockResolvedValueOnce(response(200, document("WyJpdGVtcyIsIm1pbGsiXQ", "4-current")));
    fetch.mockResolvedValueOnce(response(409));
    await expect(db.delete(key("items", "milk"))).rejects.toBeInstanceOf(CouchDbConflictError);
    expect(request(fetch, 3).headers).toMatchObject({ "if-match": "4-current" });
  });

  it("preserves getMany order and bounds its input before excess HTTP requests", async () => {
    const { database: db, fetch } = database({ maxGetManyKeys: 2, maxParallelReads: 1 });
    fetch.mockResolvedValueOnce(response(404));
    fetch.mockResolvedValueOnce(response(200, { ...document("WyJpdGVtcyIsImVnZ3MiXQ"), __dalgo_id: "eggs" }));
    await expect(db.getMany([{ ...key("items", "milk") }, key("items", "eggs")])).resolves.toHaveLength(2);
    await expect(db.getMany([key("items", "a"), key("items", "b"), key("items", "c")])).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("maps a direct unordered query to bounded Mango selector/bookmark pagination", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { docs: [document("WyJpdGVtcyIsIm1pbGsiXQ")], bookmark: "opaque" }));
    const page = await db.query(items.query().where("done", "==", false).limit(1).build());
    expect(JSON.parse(request(fetch).body as string)).toEqual({ selector: { $and: [{ __dalgo_collection: { $eq: "items" } }, { "data.done": { $eq: false } }] }, limit: 1 });
    expect(page.nextCursor?.values).toHaveLength(1);
    fetch.mockResolvedValueOnce(response(200, { docs: [] }));
    await db.query(items.query().startAfter(...(page.nextCursor?.values ?? [])).build());
    expect(JSON.parse(request(fetch, 1).body as string)).toMatchObject({ bookmark: "opaque" });
  });

  it("rejects unsupported partial writes, callback transactions, ordering, and non-adapter cursors", async () => {
    const { database: db, fetch } = database(); const items = collection<{ done: boolean }>("items");
    await expect(db.update(key("items", "milk"), { done: true })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().orderBy("done").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where(DOCUMENT_ID, "array-contains", "x").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().startAfter("forged").build())).rejects.toThrow("returned by this adapter");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts error bodies and rejects unsafe URLs, headers, oversized bodies, and streamed responses", async () => {
    const { database: db, fetch } = database({ maxRequestBytes: 20, maxResponseBytes: 20 });
    fetch.mockResolvedValueOnce(response(500, { secret: "must not escape" }));
    const normal = new CouchDbDatabase({ databaseUrl: "https://couch.example.com/app", fetch });
    await expect(normal.get(key("items", "milk"))).rejects.toBeInstanceOf(CouchDbHttpError);
    await expect(db.insert(key("items", "milk"), { tooLong: "this request is too large" })).rejects.toThrow("maxRequestBytes");
    expect(() => new CouchDbDatabase({ databaseUrl: "https://user:password@couch.example.com/app" })).toThrow("credentials");
    const unsafe = new CouchDbDatabase({ databaseUrl: "https://couch.example.com/app", headers: () => ({ authorization: "bad\nheader" }), fetch });
    await expect(unsafe.get(key("items", "milk"))).rejects.toThrow("CR/LF");
    fetch.mockResolvedValueOnce(response(200, document("WyJpdGVtcyIsIm1pbGsiXQ"), { "content-length": "99" }));
    await expect(db.get(key("items", "milk"))).rejects.toThrow("maxResponseBytes");
  });
});

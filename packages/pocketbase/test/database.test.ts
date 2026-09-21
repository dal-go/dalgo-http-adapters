import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { PocketBaseDatabase, PocketBaseHttpError, PocketBaseRequestError } from "../src/index.js";

const milk = "a1b2c3d4e5f6g7h";
const bread = "b1b2c3d4e5f6g7h";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}
function setup(options: Partial<ConstructorParameters<typeof PocketBaseDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return { fetch, headers, db: new PocketBaseDatabase({ baseUrl: "https://db.example.com", fetch, headers, ...options }) };
}
function init(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit { return fetch.mock.calls[call]?.[1] as RequestInit; }
function header(fetch: ReturnType<typeof vi.fn>, name: string, call = 0): string | null { return (init(fetch, call).headers as Headers).get(name); }

describe("PocketBaseDatabase", () => {
  it("maps point reads to the records API and strips PocketBase metadata", async () => {
    const { db, fetch, headers } = setup();
    fetch.mockResolvedValueOnce(response(200, { id: milk, collectionId: "abc", collectionName: "items", created: "now", updated: "now", expand: {}, done: false }));
    await expect(db.get<{ done: boolean }>(key("items", milk))).resolves.toEqual({ key: key("items", milk), exists: true, data: { done: false } });
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(`https://db.example.com/api/collections/items/records/${milk}`);
    expect(header(fetch, "authorization")).toBe("Bearer opaque"); expect(headers).toHaveBeenCalledOnce(); expect(init(fetch).credentials).toBe("omit");
  });

  it("maps create, patch, and delete to records endpoints", async () => {
    const { db, fetch } = setup();
    fetch.mockResolvedValueOnce(response(200, { id: milk, collectionName: "items" })); await db.insert(key("items", milk), { done: false });
    expect(init(fetch).method).toBe("POST"); expect(JSON.parse(init(fetch).body as string)).toEqual({ id: milk, done: false });
    fetch.mockResolvedValueOnce(response(200, { id: milk, collectionName: "items" })); await db.update(key("items", milk), { done: true }); expect(init(fetch, 1).method).toBe("PATCH");
    fetch.mockResolvedValueOnce(response(204)); await db.delete(key("items", milk)); expect(init(fetch, 2).method).toBe("DELETE");
  });

  it("maps missing get/update/delete, but preserves ambiguous create validation", async () => {
    const { db, fetch } = setup();
    fetch.mockResolvedValueOnce(response(404, { message: "secret record" })); await expect(db.get(key("items", bread))).resolves.toEqual({ key: key("items", bread), exists: false });
    fetch.mockResolvedValueOnce(response(404)); await expect(db.update(key("items", bread), {})).rejects.toMatchObject({ name: "NotFoundError" });
    fetch.mockResolvedValueOnce(response(404)); await expect(db.delete(key("items", bread))).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(response(400, { message: "schema secret" })); await expect(db.insert(key("items", milk), {})).rejects.toEqual(new PocketBaseHttpError(400));
  });

  it("compiles exact bounded list queries including offset emulation", async () => {
    const { db, fetch } = setup({ maxQueryLimit: 10 }); const items = collection<{ done: boolean; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, { page: 1, perPage: 7, totalItems: -1, totalPages: -1, items: [
      { id: milk, done: false, priority: 1 }, { id: bread, done: false, priority: 2 }, { id: "c1b2c3d4e5f6g7h", done: true, priority: 3 },
    ] }));
    await expect(db.query(items.query().where("done", "==", false).where("priority", "in", [1, 2]).orderBy("priority", "desc").limit(5).offset(2).build())).resolves.toEqual({ records: [{ key: key("items", "c1b2c3d4e5f6g7h"), exists: true, data: { done: true, priority: 3 } }] });
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(url.searchParams.get("page")).toBe("1"); expect(url.searchParams.get("perPage")).toBe("7"); expect(url.searchParams.get("skipTotal")).toBe("true");
    expect(url.searchParams.get("filter")).toBe("(done = false) && ((priority = 1 || priority = 2))"); expect(url.searchParams.get("sort")).toBe("-priority");
  });

  it("rejects non-atomic set, unsupported hierarchy/cursors/IDs, and reserved data before HTTP", async () => {
    const { db, fetch } = setup(); const items = collection<{ done: boolean }>("items");
    await expect(db.set(key("items", milk), {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.in(key("parents", milk)).query().build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().startAfter("cursor").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.insert(key("items", "short"), {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.insert(key("items", milk), { id: "reserved" })).rejects.toThrow("system fields");
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError); expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts provider, fetch, timeout, malformed response, and oversized body failures", async () => {
    const { fetch } = setup();
    const badProvider = new PocketBaseDatabase({ baseUrl: "https://db.example.com", fetch, headers: () => { throw new Error("token secret"); } });
    await expect(badProvider.get(key("items", milk))).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockRejectedValueOnce(new Error("Bearer secret")); const db = new PocketBaseDatabase({ baseUrl: "https://db.example.com", fetch });
    await expect(db.get(key("items", milk))).rejects.toEqual(new PocketBaseRequestError()); expect(init(fetch).redirect).toBe("error");
    fetch.mockResolvedValueOnce(response(200, { id: milk }, { "content-length": "999" })); const small = new PocketBaseDatabase({ baseUrl: "https://db.example.com", fetch, maxResponseBytes: 10 });
    await expect(small.get(key("items", milk))).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockResolvedValueOnce(response(200, { items: [{ id: "bad\nrecord", done: false }] }));
    await expect(db.query(collection<{ done: boolean }>("items").query().build())).rejects.toEqual(new PocketBaseRequestError());
  });

  it("validates successful mutation identity and exact list page envelopes", async () => {
    const { db, fetch } = setup(); const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { id: bread, collectionName: "items" }));
    await expect(db.insert(key("items", milk), {})).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockResolvedValueOnce(response(200, { id: milk, collectionName: "other" }));
    await expect(db.update(key("items", milk), {})).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockResolvedValueOnce(response(200, { page: 2, perPage: 1, items: [] }));
    await expect(db.query(items.query().limit(1).build())).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockResolvedValueOnce(response(200, { page: 1, perPage: 2, items: [] }));
    await expect(db.query(items.query().limit(1).build())).rejects.toEqual(new PocketBaseRequestError());
    fetch.mockResolvedValueOnce(response(200, { page: 1, perPage: 1, items: [{ id: milk }, { id: bread }] }));
    await expect(db.query(items.query().limit(1).build())).rejects.toEqual(new PocketBaseRequestError());
  });

  it("requires HTTPS outside loopback and validates externally mapped collections", async () => {
    expect(() => new PocketBaseDatabase({ baseUrl: "http://db.example.com" })).toThrow("HTTPS");
    expect(() => new PocketBaseDatabase({ baseUrl: "https://db.example.com/path" })).toThrow("path");
    const db = new PocketBaseDatabase({ baseUrl: "https://db.example.com", collectionName: () => "not/a/collection" });
    await expect(db.get(key("items", milk))).rejects.toBeInstanceOf(UnsupportedError);
  });
});

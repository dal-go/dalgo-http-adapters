import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { AppwriteDatabase, AppwriteHttpError, AppwriteRequestError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}
function setup(options: Partial<ConstructorParameters<typeof AppwriteDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return { fetch, headers, db: new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch, headers, ...options }) };
}
function init(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit { return fetch.mock.calls[call]?.[1] as RequestInit; }
function header(fetch: ReturnType<typeof vi.fn>, name: string, call = 0): string | null { return (init(fetch, call).headers as Headers).get(name); }

describe("AppwriteDatabase", () => {
  it("uses TablesDB rows and strips system fields before codec decoding", async () => {
    const { db, fetch, headers } = setup();
    fetch.mockResolvedValueOnce(response(200, { $id: "milk", $createdAt: "now", done: false }));
    await expect(db.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: true, data: { done: false } });
    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://cloud.appwrite.io/v1/tablesdb/data/tables/items/rows/milk");
    expect(header(fetch, "x-appwrite-project")).toBe("project"); expect(header(fetch, "authorization")).toBe("Bearer opaque"); expect(headers).toHaveBeenCalledOnce();
  });

  it("maps CRUD to current TablesDB row endpoints", async () => {
    const { db, fetch } = setup();
    fetch.mockResolvedValueOnce(response(201)); await db.insert(key("items", "milk"), { done: false });
    expect(init(fetch).method).toBe("POST"); expect(JSON.parse(init(fetch).body as string)).toEqual({ rowId: "milk", data: { done: false } });
    fetch.mockResolvedValueOnce(response(200)); await db.set(key("items", "milk"), { done: true }); expect(init(fetch, 1).method).toBe("PUT");
    fetch.mockResolvedValueOnce(response(200)); await db.update(key("items", "milk"), { done: false }); expect(init(fetch, 2).method).toBe("PATCH");
    fetch.mockResolvedValueOnce(response(204)); await db.delete(key("items", "milk")); expect(init(fetch, 3).method).toBe("DELETE");
  });

  it("maps missing and conflicts without exposing Appwrite bodies", async () => {
    const { db, fetch } = setup();
    fetch.mockResolvedValueOnce(response(404, { message: "secret row" })); await expect(db.get(key("items", "missing"))).resolves.toEqual({ key: key("items", "missing"), exists: false });
    fetch.mockResolvedValueOnce(response(409, { message: "secret conflict" })); await expect(db.insert(key("items", "milk"), {})).rejects.toMatchObject({ name: "AlreadyExistsError" });
    fetch.mockResolvedValueOnce(response(404)); await expect(db.update(key("items", "missing"), {})).rejects.toMatchObject({ name: "NotFoundError" });
    fetch.mockResolvedValueOnce(response(500, { message: "database internals" })); await expect(db.get(key("items", "milk"))).rejects.toEqual(new AppwriteHttpError(500));
  });

  it("compiles bounded rows queries", async () => {
    const { db, fetch } = setup({ maxQueryLimit: 10 }); const items = collection<{ done: boolean; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, { total: 1, rows: [{ $id: "milk", done: false, priority: 2 }] }));
    await expect(db.query(items.query().where("done", "==", false).where("priority", "in", [1, 2]).orderBy("priority", "desc").limit(5).offset(2).build())).resolves.toEqual({ records: [{ key: key("items", "milk"), exists: true, data: { done: false, priority: 2 } }] });
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(url.searchParams.getAll("queries[]")).toEqual([
      JSON.stringify({ method: "equal", column: "done", values: [false] }),
      JSON.stringify({ method: "equal", column: "priority", values: [1, 2] }),
      JSON.stringify({ method: "orderDesc", column: "priority" }),
      JSON.stringify({ method: "limit", values: [5] }),
      JSON.stringify({ method: "offset", values: [2] }),
    ]);
    expect(init(fetch).credentials).toBe("include");
  });

  it("rejects unsupported hierarchy, cursors, IDs, system data, and callback transactions before HTTP", async () => {
    const { db, fetch } = setup(); const items = collection<{ done: boolean }>("items");
    await expect(db.query(items.in(key("parents", "one")).query().build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().startAfter("cursor").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.insert(key("items", "contains spaces"), {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.insert(key("items", "milk"), { $id: "reserved" })).rejects.toThrow("system fields");
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError); expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts provider, fetch, timeout, malformed response, and oversized body failures", async () => {
    const { fetch } = setup();
    const badProvider = new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch, headers: () => { throw new Error("jwt secret"); } });
    await expect(badProvider.get(key("items", "milk"))).rejects.toEqual(new AppwriteRequestError());
    fetch.mockRejectedValueOnce(new Error("Bearer secret")); const db = new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch });
    await expect(db.get(key("items", "milk"))).rejects.toEqual(new AppwriteRequestError()); expect(init(fetch).redirect).toBe("error");
    fetch.mockResolvedValueOnce(response(200, { $id: "milk" }, { "content-length": "999" })); const small = new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch, maxResponseBytes: 10 });
    await expect(small.get(key("items", "milk"))).rejects.toEqual(new AppwriteRequestError());
  });

  it("requires explicit trusted-server mode for an API key and omits browser cookies there", async () => {
    const { fetch } = setup();
    expect(() => new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch, apiKey: "secret" })).toThrow("trusted-server");
    const browser = new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", fetch, headers: { "x-appwrite-key": "secret" } });
    await expect(browser.get(key("items", "milk"))).rejects.toEqual(new AppwriteRequestError());
    const trusted = new AppwriteDatabase({ endpoint: "https://cloud.appwrite.io/v1", projectId: "project", databaseId: "data", credentialMode: "trusted-server", apiKey: "server-secret", fetch });
    fetch.mockResolvedValueOnce(response(404)); await trusted.get(key("items", "milk"));
    expect(header(fetch, "x-appwrite-key")).toBe("server-secret"); expect(init(fetch).credentials).toBe("omit");
  });
});

import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { AlgoliaDatabase, AlgoliaHttpError, AlgoliaRequestError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function database(fetch: typeof globalThis.fetch, access: "search" | "write" = "search"): AlgoliaDatabase {
  return new AlgoliaDatabase({ applicationId: "my-app", apiKey: "public-search-key", access, fetch, indexes: { products: "products_v1" } });
}

describe("AlgoliaDatabase", () => {
  it("reads one or multiple objects with the documented search-key endpoints and preserves missing/order", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ objectID: "one", title: "One" }))
      .mockResolvedValueOnce(json({ results: [{ objectID: "one", title: "One" }, null, { objectID: "three", title: "Three" }] }));
    const db = database(fetch);
    await expect(db.get(key("products", "one"))).resolves.toEqual({ key: key("products", "one"), exists: true, data: { title: "One" } });
    await expect(db.getMany([key("products", "one"), key("products", "two"), key("products", "three")])).resolves.toEqual([
      { key: key("products", "one"), exists: true, data: { title: "One" } },
      { key: key("products", "two"), exists: false },
      { key: key("products", "three"), exists: true, data: { title: "Three" } },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://my-app-dsn.algolia.net/1/indexes/products_v1/one");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { "x-algolia-application-id": "my-app", "x-algolia-api-key": "public-search-key" } });
    expect(JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({ requests: [
      { indexName: "products_v1", objectID: "one" }, { indexName: "products_v1", objectID: "two" }, { indexName: "products_v1", objectID: "three" },
    ] });
  });

  it("compiles only the documented safe filter subset with bounded paging", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ hits: [{ objectID: "one", price: 5, category: "books" }] }));
    const query = collection<{ price: number; category: string }>("products").query().where("price", ">=", 3).where("category", "in", ["books", "games"]).limit(10).offset(10).build();
    await expect(database(fetch).query(query)).resolves.toEqual({ records: [{ key: key("products", "one"), exists: true, data: { price: 5, category: "books" } }] });
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      query: "", hitsPerPage: 10, page: 1, filters: 'price>=3 AND (category:"books" OR category:"games")',
    });
  });

  it("requires an explicit write-mode declaration for replacement writes and deletion", async () => {
    const searchFetch = vi.fn();
    const search = database(searchFetch);
    await expect(search.set(key("products", "one"), { title: "One" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(search.delete(key("products", "one"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(searchFetch).not.toHaveBeenCalled();

    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ taskID: 123 })));
    const write = database(fetch, "write");
    await write.set(key("products", "one"), { title: "One" });
    await write.delete(key("products", "one"));
    expect((fetch.mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => [url, init.method])).toEqual([
      ["https://my-app-dsn.algolia.net/1/indexes/products_v1/one", "PUT"], ["https://my-app-dsn.algolia.net/1/indexes/products_v1/one", "DELETE"],
    ]);
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ title: "One", objectID: "one" });
  });

  it("rejects atomic DALgo operations and semantic mismatches before an HTTP request", async () => {
    const fetch = vi.fn();
    const db = database(fetch, "write");
    await expect(db.insert(key("products", "one"), { title: "One" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.update(key("products", "one"), { title: "Updated" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(collection("products").query().orderBy("name").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(collection("products").query().offset(1).limit(2).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.get(key("products", 1))).rejects.toThrow("document IDs");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds request and response data and redacts failed provider responses", async () => {
    const bad = database(vi.fn().mockResolvedValue(json({ message: "api key secret" }, 403)));
    const error = await bad.get(key("products", "one")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AlgoliaHttpError);
    expect(String(error)).not.toContain("secret");

    const oversized = database(vi.fn(), "write");
    const small = new AlgoliaDatabase({ applicationId: "app", apiKey: "key", access: "write", fetch: vi.fn(), maxRequestBytes: 8, indexes: { products: "products" } });
    await expect(small.set(key("products", "one"), { title: "too long" })).rejects.toThrow("maxRequestBytes");
    await expect(oversized.get(key("products", "one"))).rejects.toBeInstanceOf(AlgoliaRequestError);
  });

  it("validates mappings, data ownership, malformed responses, and header safety", async () => {
    expect(() => new AlgoliaDatabase({ applicationId: "bad id", apiKey: "key", indexes: {} })).toThrow("applicationId");
    const db = new AlgoliaDatabase({ applicationId: "app", apiKey: "key", access: "write", indexes: { products: "products" }, fetch: vi.fn().mockResolvedValue(json({ taskID: 1 })), headers: { "x-algolia-api-key": "no" } });
    await expect(db.set(key("products", "one"), { title: "One" })).rejects.toThrow("authentication");
    const malformed = database(vi.fn().mockResolvedValue(json({ objectID: "other" })));
    await expect(malformed.get(key("products", "one"))).rejects.toThrow("does not match");
    const ownsId = database(vi.fn(), "write");
    await expect(ownsId.set(key("products", "one"), { objectID: "wrong" })).rejects.toThrow("adapter-owned");
  });
});

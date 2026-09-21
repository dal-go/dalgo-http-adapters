import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { QdrantDatabase, QdrantHttpError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function database(fetch: typeof globalThis.fetch): QdrantDatabase {
  return new QdrantDatabase({
    baseUrl: "https://qdrant.example/api/",
    fetch,
    collections: { products: { collection: "products-v1", vectorForWrite: (payload) => [Number(payload.price ?? 0), 1] } },
  });
}

describe("QdrantDatabase", () => {
  it("uses explicit collection mapping, numeric/string IDs, payloads, and per-request headers", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ result: { id: "a/b", payload: { price: 3 }, version: 2 } }));
    const headers = vi.fn().mockReturnValue({ "api-key": "rotated-secret" });
    const db = new QdrantDatabase({
      baseUrl: "https://qdrant.example/",
      fetch,
      headers,
      collections: { products: { collection: "products-v1", vectorForWrite: () => [1] } },
    });
    await expect(db.get(key("products", "a/b"))).resolves.toMatchObject({ exists: true, data: { price: 3 }, metadata: { version: 2 } });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://qdrant.example/collections/products-v1/points/a%2Fb");
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "api-key": "rotated-secret", accept: "application/json" });
    expect(headers).toHaveBeenCalledOnce();
  });

  it("preserves getMany input order and represents missing points", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: [{ id: 2, payload: { price: 2 } }] }));
    const records = await database(fetch).getMany([key("products", "one"), key("products", 2)]);
    expect(records).toEqual([
      { key: key("products", "one"), exists: false },
      { key: key("products", 2), exists: true, data: { price: 2 } },
    ]);
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ ids: ["one", 2], with_payload: true, with_vector: false });
  });

  it("maps bounded DALgo queries and keeps vector similarity an explicit helper", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: { points: [{ id: "p1", payload: { price: 4 } }] } }))
      .mockResolvedValueOnce(json({ result: { points: [{ id: "p2", payload: { price: 9 }, score: 0.91 }] } }));
    const db = database(fetch);
    const query = collection<{ price: number }>("products").query().where("price", ">=", 4).limit(1).build();
    await expect(db.query(query)).resolves.toMatchObject({ records: [{ key: key("products", "p1"), data: { price: 4 } }] });
    await expect(db.vectorSearch(query, [0.2, 0.8])).resolves.toMatchObject({ records: [{ metadata: { score: 0.91 } }] });
    const standard: unknown = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string);
    const vector: unknown = JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(standard).not.toHaveProperty("query");
    expect(vector).toMatchObject({ query: [0.2, 0.8], with_payload: true, with_vector: false });
  });

  it("writes payload documents with configured vectors and uses Qdrant payload/delete operations", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: { status: "acknowledged" } }))
      .mockResolvedValueOnce(json({ result: { id: 3, payload: { price: 3 } } }))
      .mockResolvedValueOnce(json({ result: { status: "acknowledged" } }))
      .mockResolvedValueOnce(json({ result: { status: "acknowledged" } }));
    const db = database(fetch);
    await db.set(key("products", 3), { price: 3 });
    await db.update(key("products", 3), { status: "sale" });
    await db.delete(key("products", 3));
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://qdrant.example/api/collections/products-v1/points?wait=true", "PUT"],
      ["https://qdrant.example/api/collections/products-v1/points/3", "GET"],
      ["https://qdrant.example/api/collections/products-v1/points/payload?wait=true", "POST"],
      ["https://qdrant.example/api/collections/products-v1/points/delete?wait=true", "POST"],
    ]);
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({ points: [{ id: 3, payload: { price: 3 }, vector: [3, 1] }] });
    expect(JSON.parse(calls[2]?.[1].body as string)).toEqual({ points: [3], payload: { status: "sale" } });
  });

  it("detects existing/missing records for insert/update and rejects transactions", async () => {
    const present = database(vi.fn().mockResolvedValue(json({ result: { id: "p", payload: {} } })));
    await expect(present.insert(key("products", "p"), {})).rejects.toBeInstanceOf(AlreadyExistsError);
    const missing = database(vi.fn().mockResolvedValue(json({ status: "not found" }, 404)));
    await expect(missing.update(key("products", "p"), {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(missing.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("rejects unsafe URLs, missing mappings, unsafe headers, oversized bodies, and redacts failures", async () => {
    expect(() => new QdrantDatabase({ baseUrl: "http://qdrant.example", collections: {} })).toThrow("HTTPS");
    expect(() => new QdrantDatabase({ baseUrl: "https://user:secret@qdrant.example", collections: {} })).toThrow("credentials");
    const fetch = vi.fn().mockResolvedValue(json({ status: "unauthorized", detail: "secret" }, 401));
    const db = new QdrantDatabase({
      baseUrl: "https://qdrant.example",
      fetch,
      headers: { "api-key": "secret" },
      collections: { products: { collection: "products", vectorForWrite: () => [1] } },
    });
    const error = await db.get(key("products", "p")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QdrantHttpError);
    expect(String(error)).not.toContain("secret");
    await expect(db.get(key("unknown", "p"))).rejects.toBeInstanceOf(UnsupportedError);

    const unsafe = new QdrantDatabase({ baseUrl: "https://qdrant.example", fetch, headers: { "api-key": "x\nInjected: y" }, collections: { products: { collection: "products", vectorForWrite: () => [1] } } });
    await expect(unsafe.get(key("products", "p"))).rejects.toThrow("CR/LF-safe");
    const limited = new QdrantDatabase({ baseUrl: "https://qdrant.example", fetch, maxRequestBytes: 8, collections: { products: { collection: "products", vectorForWrite: () => [1] } } });
    await expect(limited.set(key("products", "p"), { long: "payload" })).rejects.toThrow("maxRequestBytes");
  });
});

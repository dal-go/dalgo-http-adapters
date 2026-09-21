import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { QdrantDatabase, QdrantHttpError, QdrantRequestError } from "../src/index.js";

const productOne = "123e4567-e89b-12d3-a456-426614174000";
const productTwo = "123e4567-e89b-12d3-a456-426614174001";

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
    const fetch = vi.fn().mockResolvedValueOnce(json({ result: { id: productOne, payload: { price: 3 }, version: 2 } }));
    const headers = vi.fn().mockReturnValue({ "api-key": "rotated-secret" });
    const db = new QdrantDatabase({
      baseUrl: "https://qdrant.example/",
      fetch,
      headers,
      collections: { products: { collection: "products-v1", vectorForWrite: () => [1] } },
    });
    await expect(db.get(key("products", productOne))).resolves.toMatchObject({ exists: true, data: { price: 3 }, metadata: { version: 2 } });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://qdrant.example/collections/products-v1/points/${productOne}`);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "api-key": "rotated-secret", accept: "application/json" });
    expect(headers).toHaveBeenCalledOnce();
  });

  it("preserves getMany input order and represents missing points", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: [{ id: 2, payload: { price: 2 } }] }));
    const records = await database(fetch).getMany([key("products", productOne), key("products", 2)]);
    expect(records).toEqual([
      { key: key("products", productOne), exists: false },
      { key: key("products", 2), exists: true, data: { price: 2 } },
    ]);
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ ids: [productOne, 2], with_payload: true, with_vector: false });
  });

  it("maps bounded DALgo queries and keeps vector similarity an explicit helper", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: { points: [{ id: productOne, payload: { price: 4 } }] } }))
      .mockResolvedValueOnce(json({ result: { points: [{ id: productTwo, payload: { price: 9 }, score: 0.91 }] } }));
    const db = database(fetch);
    const query = collection<{ price: number }>("products").query().where("price", ">=", 4).limit(1).build();
    await expect(db.query(query)).resolves.toMatchObject({ records: [{ key: key("products", productOne), data: { price: 4 } }] });
    await expect(db.vectorSearch(query, [0.2, 0.8])).resolves.toMatchObject({ records: [{ metadata: { score: 0.91 } }] });
    const standard: unknown = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string);
    const vector: unknown = JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(standard).not.toHaveProperty("query");
    expect(vector).toMatchObject({ query: [0.2, 0.8], with_payload: true, with_vector: false });
  });

  it("sends a named vector as query data with using, never as a named-vector object", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: { points: [] } }));
    const db = new QdrantDatabase({
      baseUrl: "https://qdrant.example",
      fetch,
      collections: { products: { collection: "products", vectorName: "embedding", vectorForWrite: () => [1] } },
    });
    await db.vectorSearch(collection("products").query().limit(1).build(), [0.2, 0.8]);
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({ query: [0.2, 0.8], using: "embedding" });
  });

  it("writes payload documents with configured vectors and validates Qdrant mutation results", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: { status: "acknowledged" } }))
      .mockResolvedValueOnce(json({ result: { status: "acknowledged" } }));
    const db = database(fetch);
    await db.set(key("products", 3), { price: 3 });
    await db.delete(key("products", 3));
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://qdrant.example/api/collections/products-v1/points?wait=true", "PUT"],
      ["https://qdrant.example/api/collections/products-v1/points/delete?wait=true", "POST"],
    ]);
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({ points: [{ id: 3, payload: { price: 3 }, vector: [3, 1] }] });
  });

  it("rejects non-atomic insert/update and transactions without making a request", async () => {
    const fetch = vi.fn();
    const db = database(fetch);
    await expect(db.insert(key("products", productOne), {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.update(key("products", productOne), {})).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
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
    const error = await db.get(key("products", productOne)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QdrantHttpError);
    expect(String(error)).not.toContain("secret");
    await expect(db.get(key("unknown", productOne))).rejects.toBeInstanceOf(UnsupportedError);

    const unsafe = new QdrantDatabase({ baseUrl: "https://qdrant.example", fetch, headers: { "api-key": "x\nInjected: y" }, collections: { products: { collection: "products", vectorForWrite: () => [1] } } });
    await expect(unsafe.get(key("products", productOne))).rejects.toThrow("CR/LF-safe");
    const limited = new QdrantDatabase({ baseUrl: "https://qdrant.example", fetch, maxRequestBytes: 8, collections: { products: { collection: "products", vectorForWrite: () => [1] } } });
    await expect(limited.set(key("products", productOne), { long: "payload" })).rejects.toThrow("maxRequestBytes");
  });

  it("rejects non-UUID string IDs and malformed mutation/query responses", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: { points: [{ id: productOne, payload: {} }, { id: productTwo, payload: {} }] } }));
    const db = database(fetch);
    await expect(db.get(key("products", "a/b"))).rejects.toThrow("UUID");
    await expect(db.query(collection("products").query().limit(1).build())).rejects.toThrow("more points");

    const malformed = database(vi.fn().mockResolvedValue(json({ result: { status: "unexpected" } })));
    await expect(malformed.set(key("products", 1), { price: 1 })).rejects.toThrow("mutation");
  });

  it("bounds header resolution, transport, and response reads without exposing provider or transport secrets", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<Response>(() => undefined);
      const headers = new QdrantDatabase({
        baseUrl: "https://qdrant.example",
        headers: () => never.then(() => ({ "api-key": "secret" })),
        timeoutMs: 1,
        collections: { products: { collection: "products", vectorForWrite: () => [1] } },
      });
      const headerRequest = headers.get(key("products", productOne));
      const headerAssertion = expect(headerRequest).rejects.toMatchObject({ name: "QdrantRequestError", message: "Qdrant request timed out" });
      await vi.advanceTimersByTimeAsync(1);
      await headerAssertion;

      const transport = new QdrantDatabase({
        baseUrl: "https://qdrant.example",
        fetch: () => never,
        timeoutMs: 1,
        collections: { products: { collection: "products", vectorForWrite: () => [1] } },
      });
      const transportRequest = transport.get(key("products", productOne));
      const transportAssertion = expect(transportRequest).rejects.toMatchObject({ name: "QdrantRequestError", message: "Qdrant request timed out" });
      await vi.advanceTimersByTimeAsync(1);
      await transportAssertion;

      const pendingBody = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
      const body = new QdrantDatabase({
        baseUrl: "https://qdrant.example",
        fetch: () => Promise.resolve(new Response(pendingBody)),
        timeoutMs: 1,
        collections: { products: { collection: "products", vectorForWrite: () => [1] } },
      });
      const bodyRequest = body.get(key("products", productOne));
      const bodyAssertion = expect(bodyRequest).rejects.toMatchObject({ name: "QdrantRequestError", message: "Qdrant request timed out" });
      await vi.advanceTimersByTimeAsync(1);
      await bodyAssertion;
    } finally {
      vi.useRealTimers();
    }

    const failingHeaders = new QdrantDatabase({
      baseUrl: "https://qdrant.example",
      headers: () => Promise.reject(new Error("api-key secret")),
      collections: { products: { collection: "products", vectorForWrite: () => [1] } },
    });
    const error = await failingHeaders.get(key("products", productOne)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QdrantRequestError);
    expect(String(error)).not.toContain("secret");

    const failingBody = new QdrantDatabase({
      baseUrl: "https://qdrant.example",
      fetch: () => Promise.resolve(new Response(new ReadableStream({ start: (controller) => { controller.error(new Error("body secret")); } }))),
      collections: { products: { collection: "products", vectorForWrite: () => [1] } },
    });
    const bodyError = await failingBody.get(key("products", productOne)).catch((caught: unknown) => caught);
    expect(bodyError).toBeInstanceOf(QdrantRequestError);
    expect(String(bodyError)).not.toContain("secret");
  });
});

import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { PineconeDatabase, PineconeHttpError, PineconeRequestError } from "../src/index.js";

function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function database(fetch: typeof globalThis.fetch): PineconeDatabase { return new PineconeDatabase({ baseUrl: "https://index.example/", namespace: "tenant-a", vectorForWrite: () => [1, 2], fetch }); }
const products = collection<{ readonly title: string; readonly price: number }>("products");

describe("PineconeDatabase", () => {
  it("uses fetch with repeated ids, a namespace, and preserves getMany input order", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ vectors: { one: { id: "one", metadata: { title: "One", price: 1 } } } }));
    const db = database(fetch);
    await expect(db.getMany([key("products", "missing"), key("products", "one"), key("products", "one")])).resolves.toEqual([
      { key: key("products", "missing"), exists: false },
      { key: key("products", "one"), exists: true, data: { title: "One", price: 1 } },
      { key: key("products", "one"), exists: true, data: { title: "One", price: 1 } },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://index.example/vectors/fetch?ids=missing&ids=one&namespace=tenant-a");
  });

  it("upserts metadata and deletes by id without exposing configured headers", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ upsertedCount: 1 })).mockResolvedValueOnce(json({}));
    const db = new PineconeDatabase({ baseUrl: "https://index.example", namespace: "tenant-a", vectorForWrite: () => [1, 2], headers: { "Api-Key": "secret" }, fetch });
    await db.set(products.key("one"), { title: "One", price: 1 });
    await db.delete(products.key("one"));
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://index.example/vectors/upsert", "POST"], ["https://index.example/vectors/delete", "POST"],
    ]);
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({ vectors: [{ id: "one", values: [1, 2], metadata: { title: "One", price: 1 } }], namespace: "tenant-a" });
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({ ids: ["one"], namespace: "tenant-a" });
    expect(calls[0]?.[1].headers).toMatchObject({ "Api-Key": "secret", accept: "application/json" });
  });

  it("keeps vector search explicit and maps supported metadata filters", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ matches: [{ id: "one", score: 0.9, metadata: { title: "One", price: 3 } }] }));
    const db = database(fetch);
    const query = products.query().where("price", ">=", 3).limit(2).build();
    await expect(db.vectorSearch(query, [0.2, 0.8])).resolves.toMatchObject({ records: [{ key: key("products", "one"), data: { title: "One", price: 3 }, metadata: { score: 0.9 } }] });
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ vector: [0.2, 0.8], topK: 2, includeValues: false, includeMetadata: true, namespace: "tenant-a", filter: { price: { $gte: 3 } } });
    await expect(db.query(query)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("rejects conditional writes, transactions, nested keys, and unsupported query semantics before requests", async () => {
    const fetch = vi.fn(); const db = database(fetch);
    await expect(db.insert(products.key("one"), { title: "One", price: 1 })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.update(products.key("one"), { price: 2 })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.vectorSearch(products.query().orderBy("price").build(), [1])).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.get(key("products", "one", key("parents", "p")))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces URL, JSON, response, and error-redaction boundaries", async () => {
    expect(() => new PineconeDatabase({ baseUrl: "http://index.example", vectorForWrite: () => [1] })).toThrow("HTTPS");
    expect(() => new PineconeDatabase({ baseUrl: "https://key:secret@index.example", vectorForWrite: () => [1] })).toThrow("credentials");
    const failing = new PineconeDatabase({ baseUrl: "https://index.example", vectorForWrite: () => [1], headers: { "Api-Key": "secret" }, fetch: vi.fn().mockResolvedValue(json({ message: "secret" }, 401)) });
    const error = await failing.get(products.key("one")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PineconeHttpError); expect(String(error)).not.toContain("secret");
    const malformed = database(vi.fn().mockResolvedValue(json({ vectors: { one: { id: "one", metadata: "wrong" } } })));
    await expect(malformed.get(products.key("one"))).rejects.toBeInstanceOf(UnsupportedError);
    const limited = new PineconeDatabase({ baseUrl: "https://index.example", vectorForWrite: () => [1], maxRequestBytes: 8 });
    await expect(limited.set(products.key("one"), { title: "a long title", price: 1 })).rejects.toThrow("maxRequestBytes");
  });

  it("bounds header, transport, and response reads and redacts their causes", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<Response>(() => undefined);
      const headers = new PineconeDatabase({ baseUrl: "https://index.example", vectorForWrite: () => [1], timeoutMs: 1, headers: () => never.then(() => ({ "Api-Key": "secret" })) });
      const headerRequest = headers.get(products.key("one")); const headerAssertion = expect(headerRequest).rejects.toMatchObject({ name: "PineconeRequestError", message: "Pinecone request timed out" });
      await vi.advanceTimersByTimeAsync(1); await headerAssertion;
      const transport = new PineconeDatabase({ baseUrl: "https://index.example", vectorForWrite: () => [1], timeoutMs: 1, fetch: () => never });
      const transportRequest = transport.get(products.key("one")); const transportAssertion = expect(transportRequest).rejects.toMatchObject({ name: "PineconeRequestError", message: "Pinecone request timed out" });
      await vi.advanceTimersByTimeAsync(1); await transportAssertion;
    } finally { vi.useRealTimers(); }
    const failingHeaders = new PineconeDatabase({ baseUrl: "https://index.example", vectorForWrite: () => [1], headers: () => { throw new Error("secret"); } });
    const error = await failingHeaders.get(products.key("one")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PineconeRequestError); expect(String(error)).not.toContain("secret");
  });
});

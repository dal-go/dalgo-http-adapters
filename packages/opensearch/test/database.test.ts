import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { OpenSearchDatabase, OpenSearchHttpError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenSearchDatabase", () => {
  it("gets existing and missing documents and refreshes headers per request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ _index: "items", _id: "a/b", _source: { value: 1 }, _version: 3 }))
      .mockResolvedValueOnce(json({ found: false, _index: "items", _id: "missing" }, 404));
    const headers = vi.fn().mockReturnValue({ Authorization: "ApiKey secret" });
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example/", fetch, headers });

    await expect(db.get(key("items", "a/b"))).resolves.toMatchObject({ exists: true, data: { value: 1 } });
    await expect(db.get(key("items", "missing"))).resolves.toEqual({ key: key("items", "missing"), exists: false });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://opensearch.example/items/_doc/a%2Fb");
    expect(headers).toHaveBeenCalledTimes(2);
  });

  it("preserves input order for multi-get", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ docs: [
      { _index: "a", _id: "1", found: false },
      { _index: "b", _id: "2", found: true, _source: { n: 2 } },
    ] }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch });
    const records = await db.getMany([key("a", "1"), key("b", "2")]);
    expect(records.map((record) => record.exists)).toEqual([false, true]);
    const request = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.body).toBeTypeOf("string");
    expect(JSON.parse(request?.body as string)).toEqual({ docs: [
      { _index: "a", _id: "1" },
      { _index: "b", _id: "2" },
    ] });
  });

  it("decodes search hits and exposes a cursor only from returned sort values", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ hits: { hits: [
      { _index: "products", _id: "p1", _source: { price: 12 }, sort: [12] },
    ] } }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch });
    const result = await db.query(collection<{ price: number }>("products").query().orderBy("price").limit(1).build());
    expect(result.records[0]?.key).toEqual(key("products", "p1"));
    expect(result.nextCursor).toEqual({ values: [12] });
  });

  it("requires string IDs and verifies OpenSearch response identities", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ _index: "items", _id: "other", _source: {} }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch });
    await expect(db.get(key("items", 1))).rejects.toThrow("IDs must be strings");
    await expect(db.get(key("items", "wanted"))).rejects.toThrow("does not match requested key");
    expect(fetch).toHaveBeenCalledTimes(1);

    const mget = new OpenSearchDatabase({
      baseUrl: "https://opensearch.example",
      fetch: vi.fn().mockResolvedValue(json({ docs: [{ _index: "wrong", _id: "1", found: false }] })),
    });
    await expect(mget.getMany([key("items", "1")])).rejects.toThrow("does not match requested key");
  });

  it("bounds query sizes and validates search sort values before returning a cursor", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ hits: { hits: [{ _index: "items", _id: "1", _source: {}, sort: [1, 2] }] } }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch, maxQueryLimit: 2 });
    await expect(db.query(collection("items").query().orderBy("n").limit(1).build())).rejects.toThrow("sort value count");
    await expect(db.query(collection("items").query().limit(3).build())).rejects.toThrow("maxQueryLimit");

    const boundedFetch = vi.fn().mockResolvedValue(json({ hits: { hits: [] } }));
    const bounded = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch: boundedFetch, maxQueryLimit: 7 });
    await bounded.query(collection("items").query().build());
    expect(JSON.parse((boundedFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({ size: 7 });
  });

  it("maps insert conflicts and missing updates while deletion is idempotent", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ found: false }, 404))
      .mockResolvedValueOnce(json({ result: "not_found" }, 404));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch });
    await expect(db.insert(key("items", "1"), { n: 1 })).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(db.update(key("items", "1"), { n: 2 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.delete(key("items", "1"))).resolves.toBeUndefined();
  });

  it("sends set, update, and delete with exact methods, bodies, and redirect protection", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: "created" }, 201))
      .mockResolvedValueOnce(json({ result: "updated" }))
      .mockResolvedValueOnce(json({ result: "deleted" }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example/prefix/", fetch });
    const item = key("items", "1");

    await db.set(item, { n: 1 });
    await db.update(item, { n: 2 });
    await db.delete(item);

    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://opensearch.example/prefix/items/_doc/1", "PUT"],
      ["https://opensearch.example/prefix/items/_update/1", "POST"],
      ["https://opensearch.example/prefix/items/_doc/1", "DELETE"],
    ]);
    expect(calls[0]?.[1].redirect).toBe("error");
    expect(calls[0]?.[1].body).toBe(JSON.stringify({ n: 1 }));
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ doc: { n: 2 } }));
  });

  it("rejects unsafe base URLs and index names before making a request", async () => {
    expect(() => new OpenSearchDatabase({ baseUrl: "http://opensearch.example" })).toThrow("HTTPS");
    expect(() => new OpenSearchDatabase({ baseUrl: "https://user:secret@opensearch.example" })).toThrow("credentials");
    expect(() => new OpenSearchDatabase({ baseUrl: "https://opensearch.example?secret=value" })).toThrow("query or fragment");

    const fetch = vi.fn();
    const db = new OpenSearchDatabase({ baseUrl: "http://localhost:9200", fetch });
    await expect(db.get(key("x".repeat(256), "1"))).rejects.toThrow("255 bytes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed responses and existing records without source data", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ _index: "items", _id: "1" }))
      .mockResolvedValueOnce(json({ docs: "not-an-array" }))
      .mockResolvedValueOnce(json({ hits: {} }));
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch });

    await expect(db.get(key("items", "1"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.getMany([key("items", "1")])).rejects.toThrow("malformed OpenSearch _mget response");
    await expect(db.query(collection("items").query().build())).rejects.toThrow("malformed OpenSearch search response");
  });

  it("does not pretend OpenSearch offers DALgo transactions", async () => {
    const db = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch: vi.fn() });
    await expect(db.runReadwriteTransaction(() => Promise.resolve("never called"))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("reports non-DALgo HTTP failures without exposing configured credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: { type: "security_exception" } }, 401));
    const db = new OpenSearchDatabase({
      baseUrl: "https://opensearch.example",
      fetch,
      headers: { Authorization: "ApiKey secret" },
    });
    const error = await db.get(key("items", "1")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenSearchHttpError);
    expect(String(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("body");
  });

  it("enforces request/response limits and mandatory safe headers", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ result: "created" }));
    const db = new OpenSearchDatabase({
      baseUrl: "https://opensearch.example",
      fetch,
      maxRequestBytes: 8,
      headers: { accept: "text/plain", "content-type": "text/plain" },
    });
    await expect(db.set(key("items", "1"), { long: "payload" })).rejects.toThrow("maxRequestBytes");
    await expect(db.set(key("items", "1"), { n: 1 })).resolves.toBeUndefined();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ accept: "application/json", "content-type": "application/json" });

    const unsafe = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch, headers: { Authorization: "Bearer x\nInjected: y" } });
    await expect(unsafe.get(key("items", "1"))).rejects.toThrow("CR/LF-safe");

    const large = new OpenSearchDatabase({ baseUrl: "https://opensearch.example", fetch: vi.fn().mockResolvedValue(new Response("12345", { headers: { "content-length": "5" } })), maxResponseBytes: 4 });
    await expect(large.get(key("items", "1"))).rejects.toThrow("maxResponseBytes");
  });
});

import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { ElasticsearchDatabase, ElasticsearchHttpError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ElasticsearchDatabase", () => {
  it("gets existing and missing documents and refreshes headers per request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ _index: "items", _id: "a/b", _source: { value: 1 }, _version: 3 }))
      .mockResolvedValueOnce(json({ found: false, _index: "items", _id: "missing" }, 404));
    const headers = vi.fn().mockReturnValue({ Authorization: "ApiKey secret" });
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example/", fetch, headers });

    await expect(db.get(key("items", "a/b"))).resolves.toMatchObject({ exists: true, data: { value: 1 } });
    await expect(db.get(key("items", "missing"))).resolves.toEqual({ key: key("items", "missing"), exists: false });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://elastic.example/items/_doc/a%2Fb");
    expect(headers).toHaveBeenCalledTimes(2);
  });

  it("preserves input order for multi-get", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ docs: [
      { _index: "a", _id: "1", found: false },
      { _index: "b", _id: "2", found: true, _source: { n: 2 } },
    ] }));
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example", fetch });
    const records = await db.getMany([key("a", 1), key("b", 2)]);
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
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example", fetch });
    const result = await db.query(collection<{ price: number }>("products").query().orderBy("price").limit(1).build());
    expect(result.records[0]?.key).toEqual(key("products", "p1"));
    expect(result.nextCursor).toEqual({ values: [12] });
  });

  it("maps insert conflicts and missing updates while deletion is idempotent", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ found: false }, 404))
      .mockResolvedValueOnce(json({ result: "not_found" }, 404));
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example", fetch });
    await expect(db.insert(key("items", "1"), { n: 1 })).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(db.update(key("items", "1"), { n: 2 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.delete(key("items", "1"))).resolves.toBeUndefined();
  });

  it("sends set, update, and delete with exact methods, bodies, and redirect protection", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ result: "created" }, 201))
      .mockResolvedValueOnce(json({ result: "updated" }))
      .mockResolvedValueOnce(json({ result: "deleted" }));
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example/prefix/", fetch });
    const item = key("items", "1");

    await db.set(item, { n: 1 });
    await db.update(item, { n: 2 });
    await db.delete(item);

    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://elastic.example/prefix/items/_doc/1", "PUT"],
      ["https://elastic.example/prefix/items/_update/1", "POST"],
      ["https://elastic.example/prefix/items/_doc/1", "DELETE"],
    ]);
    expect(calls[0]?.[1].redirect).toBe("error");
    expect(calls[0]?.[1].body).toBe(JSON.stringify({ n: 1 }));
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ doc: { n: 2 } }));
  });

  it("rejects unsafe base URLs and index names before making a request", async () => {
    expect(() => new ElasticsearchDatabase({ baseUrl: "http://elastic.example" })).toThrow("HTTPS");
    expect(() => new ElasticsearchDatabase({ baseUrl: "https://user:secret@elastic.example" })).toThrow("credentials");
    expect(() => new ElasticsearchDatabase({ baseUrl: "https://elastic.example?secret=value" })).toThrow("query or fragment");

    const fetch = vi.fn();
    const db = new ElasticsearchDatabase({ baseUrl: "http://localhost:9200", fetch });
    await expect(db.get(key("x".repeat(256), "1"))).rejects.toThrow("255 bytes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed responses and existing records without source data", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ _index: "items", _id: "1" }))
      .mockResolvedValueOnce(json({ docs: "not-an-array" }))
      .mockResolvedValueOnce(json({ hits: {} }));
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example", fetch });

    await expect(db.get(key("items", "1"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.getMany([key("items", "1")])).rejects.toThrow("malformed Elasticsearch _mget response");
    await expect(db.query(collection("items").query().build())).rejects.toThrow("malformed Elasticsearch search response");
  });

  it("does not pretend Elasticsearch offers DALgo transactions", async () => {
    const db = new ElasticsearchDatabase({ baseUrl: "https://elastic.example", fetch: vi.fn() });
    await expect(db.runReadwriteTransaction(() => Promise.resolve("never called"))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("reports non-DALgo HTTP failures without exposing configured credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: { type: "security_exception" } }, 401));
    const db = new ElasticsearchDatabase({
      baseUrl: "https://elastic.example",
      fetch,
      headers: { Authorization: "ApiKey secret" },
    });
    const error = await db.get(key("items", "1")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElasticsearchHttpError);
    expect(String(error)).not.toContain("secret");
  });
});

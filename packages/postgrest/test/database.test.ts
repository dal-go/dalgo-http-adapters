import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";

import { PostgrestDatabase, PostgrestHttpError, PostgrestRequestError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function database(options: Partial<ConstructorParameters<typeof PostgrestDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return { fetch, headers, database: new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1", fetch, headers, ...options }) };
}

function request(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetch.mock.calls[call]?.[1] as RequestInit;
}

function header(fetch: ReturnType<typeof vi.fn>, name: string, call = 0): string | null {
  return (request(fetch, call).headers as Headers).get(name);
}

describe("PostgrestDatabase", () => {
  it("uses a redaction-safe refreshed header provider and decodes adapter-owned IDs", async () => {
    const { database: db, fetch, headers } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false }]));

    await expect(db.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({
      key: key("items", "milk"), exists: true, data: { done: false },
    });

    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://api.example.com/rest/v1/items?id=eq.%22milk%22&select=*&limit=1");
    expect(header(fetch, "authorization")).toBe("Bearer opaque");
    expect(header(fetch, "accept")).toBe("application/json");
    expect(headers).toHaveBeenCalledTimes(1);
  });

  it("creates, fully replaces, updates, and deletes through PostgREST write verbs", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(201, [{ id: "milk", done: false }]));
    await db.insert(key("items", "milk"), { done: false });
    expect(request(fetch).method).toBe("POST");
    expect(JSON.parse(request(fetch).body as string)).toEqual({ id: "milk", done: false });
    expect(header(fetch, "prefer")).toBe("return=minimal");
    expect(header(fetch, "content-type")).toBe("application/json");

    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: true }]));
    await db.set(key("items", "milk"), { done: true });
    expect(request(fetch, 1).method).toBe("PUT");
    expect(fetch.mock.calls[1]?.[0].toString()).toContain("id=eq.%22milk%22");
    expect(header(fetch, "prefer", 1)).toBe("return=representation");
    expect(JSON.parse(request(fetch, 1).body as string)).toEqual({ id: "milk", done: true });
    expect(JSON.parse(request(fetch, 1).body as string)).not.toHaveProperty("legacyField");
    expect(header(fetch, "prefer", 1)).not.toContain("resolution=merge-duplicates");

    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: true }]));
    await db.update(key("items", "milk"), { done: true });
    expect(request(fetch, 2).method).toBe("PATCH");
    expect(fetch.mock.calls[2]?.[0].toString()).toContain("id=eq.%22milk%22");
    expect(header(fetch, "prefer", 2)).toBe("handling=strict, max-affected=1, return=representation");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.delete(key("items", "milk"));
    expect(request(fetch, 3).method).toBe("DELETE");
    expect(header(fetch, "prefer", 3)).toBe("handling=strict, max-affected=1, return=representation");
  });

  it("maps uniqueness conflicts and missing partial updates to DALgo errors", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(409, { detail: "secret row values never leak" }));
    await expect(db.insert(key("items", "milk"), { done: false })).rejects.toMatchObject({ name: "AlreadyExistsError" });

    fetch.mockResolvedValueOnce(response(200, []));
    await expect(db.update(key("items", "missing"), { done: true })).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("compiles bounded direct-collection filters, ordering, and offsets", async () => {
    const { database: db, fetch } = database({ maxQueryLimit: 10 });
    const items = collection<{ done: boolean; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 2 }]));

    await expect(db.query(items.query().where("done", "==", false).where("priority", "in", [1, 2]).orderBy("priority", "desc").limit(5).offset(2).build())).resolves.toEqual({
      records: [{ key: key("items", "milk"), exists: true, data: { done: false, priority: 2 } }],
    });

    const url = fetch.mock.calls[0]?.[0].toString() ?? "";
    expect(url).toContain("done=eq.false");
    expect(url).toContain("priority=in.%281%2C2%29");
    expect(url).toContain("order=priority.desc");
    expect(url).toContain("limit=5");
    expect(url).toContain("offset=2");
  });

  it("rejects unsupported hierarchical queries, cursors, bad filter inputs, and callback transactions", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ done: boolean }>("items");
    await expect(db.query(items.in(key("parents", "one")).query().build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().startAfter("opaque").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where(DOCUMENT_ID, "in", []).build())).rejects.toThrow("non-empty array");
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts PostgREST errors and rejects unsafe URLs, headers, payloads, and oversized responses", async () => {
    const { database: db, fetch } = database({ maxRequestBytes: 20, maxResponseBytes: 20 });
    const normal = new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1", fetch });
    fetch.mockResolvedValueOnce(response(500, { detail: "database internals must not escape" }));
    await expect(normal.get(key("items", "milk"))).rejects.toEqual(new PostgrestHttpError(500));
    await expect(db.insert(key("items", "milk"), { long: "this request is too large" })).rejects.toThrow("maxRequestBytes");
    expect(() => new PostgrestDatabase({ baseUrl: "https://user:password@api.example.com/rest/v1" })).toThrow("credentials");
    const unsafe = new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1", fetch, headers: () => ({ authorization: "bad\nheader" }) });
    await expect(unsafe.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false }], { "content-length": "99" }));
    await expect(db.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
  });

  it("rejects unexpected multi-row keyed write representations", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk" }, { id: "eggs" }]));
    await expect(db.set(key("items", "milk"), { done: true })).rejects.toEqual(new PostgrestRequestError());
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk" }, { id: "eggs" }]));
    await expect(db.update(key("items", "milk"), { done: true })).rejects.toEqual(new PostgrestRequestError());
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk" }, { id: "eggs" }]));
    await expect(db.delete(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
  });

  it("uses redirect errors and redacts header, fetch, and timeout failures", async () => {
    const { database: db, fetch } = database();
    fetch.mockRejectedValueOnce(new Error("fetch failed with Bearer secret-token https://private.example"));
    await expect(db.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
    expect(request(fetch).redirect).toBe("error");

    const badHeaders = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      headers: () => { throw new Error("token secret must not propagate"); },
      fetch,
    });
    await expect(badHeaders.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());

    const hangingHeaders = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      headers: () => new Promise<Readonly<Record<string, string>>>(() => undefined),
      fetch,
      timeoutMs: 1,
    });
    await expect(hangingHeaders.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
  });
});

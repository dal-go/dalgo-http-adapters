import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { PostgrestDatabase, PostgrestHttpError, PostgrestRequestError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function neverSettlingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull: () => new Promise<void>(() => undefined),
    cancel: () => new Promise<void>(() => undefined),
  });
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

    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://api.example.com/rest/v1/items?id=eq.milk&select=*&limit=1");
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
    expect(fetch.mock.calls[1]?.[0].toString()).toContain("id=eq.milk");
    expect(header(fetch, "prefer", 1)).toBe("return=representation");
    expect(JSON.parse(request(fetch, 1).body as string)).toEqual({ id: "milk", done: true });
    expect(JSON.parse(request(fetch, 1).body as string)).not.toHaveProperty("legacyField");
    expect(header(fetch, "prefer", 1)).not.toContain("resolution=merge-duplicates");

    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: true }]));
    await db.update(key("items", "milk"), { done: true });
    expect(request(fetch, 2).method).toBe("PATCH");
    expect(fetch.mock.calls[2]?.[0].toString()).toContain("id=eq.milk");
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

  it("quotes every PostgREST control parameter name used as a filter key", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ value: string }>("items");
    const names = ["select", "columns", "on_conflict", "order", "limit", "offset", "and", "or"];
    for (const name of names) {
      fetch.mockResolvedValueOnce(response(200, []));
      await db.query(items.query().where(name, "==", "x").build());
      const url = new URL(fetch.mock.calls.at(-1)?.[0].toString() ?? "");
      // The predicate keeps its own quoted key instead of colliding with, or
      // being consumed as, the adapter's control parameter of the same name.
      expect(url.searchParams.getAll(`"${name}"`), name).toEqual(["eq.x"]);
    }
    expect(fetch).toHaveBeenCalledTimes(names.length);
  });

  it("maps DOCUMENT_ID to a quoted configured ID column and quotes its point reads", async () => {
    const { database: db, fetch } = database({ idColumn: "order" });
    const items = collection<{ title: string }>("items");
    fetch.mockResolvedValueOnce(response(200, []));
    await db.query(items.query().where(DOCUMENT_ID, "==", "a").build());
    const queryUrl = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(queryUrl.searchParams.getAll("\"order\"")).toEqual(["eq.a"]);
    expect(queryUrl.searchParams.getAll("order")).toEqual([]);

    fetch.mockResolvedValueOnce(response(200, [{ order: "a", title: "Alpha" }]));
    await expect(db.get<{ title: string }>(key("items", "a"))).resolves.toEqual({
      key: key("items", "a"), exists: true, data: { title: "Alpha" },
    });
    const pointUrl = new URL(fetch.mock.calls[1]?.[0].toString() ?? "");
    expect(pointUrl.searchParams.getAll("\"order\"")).toEqual(["eq.a"]);
    expect(pointUrl.searchParams.get("select")).toBe("*");
    expect(pointUrl.searchParams.get("limit")).toBe("1");
  });

  it("quotes a control-named configured key on keyed write verbs too", async () => {
    const { database: db, fetch } = database({ idColumn: "offset" });
    fetch.mockResolvedValueOnce(response(200, [{ offset: 7, title: "seven" }]));
    await db.set(key("reserved_ids", 7), { title: "seven" });
    expect(request(fetch).method).toBe("PUT");
    expect(new URL(fetch.mock.calls[0]?.[0].toString() ?? "").searchParams.getAll("\"offset\"")).toEqual(["eq.7"]);

    fetch.mockResolvedValueOnce(response(200, [{ offset: 7, title: "updated" }]));
    await db.update(key("reserved_ids", 7), { title: "updated" });
    expect(request(fetch, 1).method).toBe("PATCH");
    expect(new URL(fetch.mock.calls[1]?.[0].toString() ?? "").searchParams.getAll("\"offset\"")).toEqual(["eq.7"]);

    fetch.mockResolvedValueOnce(response(200, []));
    await db.delete(key("reserved_ids", 7));
    expect(request(fetch, 2).method).toBe("DELETE");
    expect(new URL(fetch.mock.calls[2]?.[0].toString() ?? "").searchParams.getAll("\"offset\"")).toEqual(["eq.7"]);
  });

  it("keeps ordinary column names that resemble a control unquoted", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ value: string }>("items");
    fetch.mockResolvedValueOnce(response(200, []));
    await db.query(
      items.query()
        .where("order_id", "==", "a")
        .where("limiters", "==", "b")
        .where("columns_count", "==", "c")
        .where("ordinary", "==", "d")
        .where("android", "==", "e")
        .build(),
    );
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(url.searchParams.getAll("order_id")).toEqual(["eq.a"]);
    expect(url.searchParams.getAll("limiters")).toEqual(["eq.b"]);
    expect(url.searchParams.getAll("columns_count")).toEqual(["eq.c"]);
    expect(url.searchParams.getAll("ordinary")).toEqual(["eq.d"]);
    expect(url.searchParams.getAll("android")).toEqual(["eq.e"]);
  });

  it("keeps the actual URL for supported equality, range and IN filters", async () => {
    const { database: db, fetch } = database({ maxQueryLimit: 10 });
    const items = collection<{ title: string; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, []));
    await db.query(
      items.query()
        .where("title", "==", "Alpha")
        .where("priority", ">=", 2)
        .where(DOCUMENT_ID, "in", ["a", "b"])
        .limit(2)
        .build(),
    );
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(url.pathname).toBe("/rest/v1/items");
    expect(url.searchParams.getAll("select")).toEqual(["*"]);
    expect(url.searchParams.getAll("title")).toEqual(["eq.Alpha"]);
    expect(url.searchParams.getAll("priority")).toEqual(["gte.2"]);
    expect(url.searchParams.getAll("id")).toEqual(["in.(\"a\",\"b\")"]);
    expect(url.searchParams.getAll("limit")).toEqual(["2"]);
    expect(url.searchParams.get("offset")).toBeNull();
    expect(url.searchParams.get("or")).toBeNull();
  });

  it("accepts a control name as the configured ID column because it is always quoted", () => {
    expect(() => new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      idColumn: "limit",
    })).not.toThrow();
    expect(() => new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      idColumn: "order",
    })).not.toThrow();
    expect(() => new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      idColumn: "not a column",
    })).toThrow("id column");
  });

  it("sends top-level string operands raw and quotes them only in list contexts", async () => {
    const { database: db, fetch } = database({ maxQueryLimit: 10 });
    const items = collection<{ title: string; tag: string }>("items");
    fetch.mockResolvedValueOnce(response(200, []));
    await db.query(
      items.query()
        .where("title", "==", "a, b.c")
        .where("tag", "not-in", ["say \"hi\"", "back\\slash"])
        .build(),
    );
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    // PostgREST compares a single-value operand literally, so quoting it would
    // compare the quote characters too (`eq."a"` does not match `a`).
    expect(url.searchParams.getAll("title")).toEqual(["eq.a, b.c"]);
    // A membership list is a reserved-character context: quote and escape.
    expect(url.searchParams.getAll("tag")).toEqual(["not.in.(\"say \\\"hi\\\"\",\"back\\\\slash\")"]);
  });

  it("refuses unsafe native integers in outgoing filters and record data before HTTP", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ priority: number }>("items");
    await expect(db.query(items.query().where("priority", "==", 2 ** 53).build()))
      .rejects.toThrow("lossless");
    await expect(db.insert(key("items", "unsafe"), { priority: 2 ** 53 }))
      .rejects.toThrow("lossless");
    await expect(db.insert(key("items", 2 ** 53), { priority: 1 }))
      .rejects.toThrow("lossless number or string ID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("emits exact decimal filter literals without rounding them through a safe-integer rule", async () => {
    const { database: db, fetch } = database({ maxQueryLimit: 10 });
    const items = collection<{ score: number }>("items");
    fetch.mockResolvedValueOnce(response(200, []));
    await db.query(items.query().where("score", ">", 0.1).where("score", "<", 0.30000000000000004).build());
    const url = new URL(fetch.mock.calls[0]?.[0].toString() ?? "");
    expect(url.searchParams.getAll("score")).toEqual(["gt.0.1", "lt.0.30000000000000004"]);
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("does not await a never-settling cancellation or body read", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(new Response(neverSettlingStream(), { status: 201 }));
    await expect(db.insert(key("items", "milk"), { done: false })).resolves.toBeUndefined();

    fetch.mockResolvedValueOnce(new Response(neverSettlingStream(), { status: 500 }));
    await expect(db.get(key("items", "milk"))).rejects.toEqual(new PostgrestHttpError(500));

    const timeout = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch: vi.fn().mockResolvedValue(new Response(neverSettlingStream(), { status: 200 })),
      timeoutMs: 1,
    });
    await expect(timeout.get(key("items", "milk"))).rejects.toEqual(new PostgrestRequestError());
  });

  it("binds the default fetch to globalThis like a browser requires", async () => {
    const calls: unknown[] = [];
    function strictFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
      // Chromium rejects window.fetch with "Illegal invocation" when called
      // with a receiver other than the window.
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      calls.push(input);
      return Promise.resolve(response(200, []));
    }
    vi.stubGlobal("fetch", strictFetch);
    try {
      const db = new PostgrestDatabase({
        baseUrl: "https://api.example.com/rest/v1",
        headers: { authorization: "Bearer opaque" },
      });
      await expect(db.get(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: false });
      expect(calls).toHaveLength(1);
      expect(new URL(String(calls[0])).pathname).toBe("/rest/v1/items");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

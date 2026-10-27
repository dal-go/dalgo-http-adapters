import { QueryCancelledError } from "@dalgo/adapter-runtime";
import {
  DOCUMENT_ID,
  UnsupportedError,
  collection,
  key,
} from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import {
  COUCHDB_READ_CAPABILITIES,
  NATIVE_COUCHDB_READ_CAPABILITIES,
  CouchDbBatchSizeError,
  CouchDbHttpError,
  CouchDbRequestError,
  NativeCouchDbDatabase,
  type NativeCouchDbQuery,
} from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function nativeDatabase(options: Partial<ConstructorParameters<typeof NativeCouchDbDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return {
    fetch,
    headers,
    database: new NativeCouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      collection: "items",
      fetch,
      headers,
      ...options,
    }),
  };
}

function request(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetch.mock.calls[call]?.[1] as RequestInit;
}

function body(fetch: ReturnType<typeof vi.fn>, call = 0): unknown {
  return JSON.parse(request(fetch, call).body as string);
}

function legacyCursor(payload: Record<string, unknown>): string {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve(value: T): void { resolve?.(value); } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function doc(id: string, rev = "1-a", data: Record<string, unknown> = { title: "Milk" }) {
  return { _id: id, _rev: rev, ...data };
}

const items = collection<{ title: string; nullable?: string | null }>("items");

function query<T>(value: NativeCouchDbQuery<T>): NativeCouchDbQuery<T> { return value; }

describe("NativeCouchDbDatabase reads", () => {
  it("preserves native _id/_rev and nested/null data without rewriting the document", async () => {
    const { database, fetch } = nativeDatabase();
    const source = doc("id with space/slash", "3-current", {
      title: "Milk",
      nullable: null,
      nested: { a: 1, b: null },
    });
    fetch.mockResolvedValueOnce(response(200, source));

    await expect(database.get(key("items", "id with space/slash"))).resolves.toEqual({
      key: key("items", "id with space/slash"),
      exists: true,
      data: source,
      metadata: { id: "id with space/slash", revision: "3-current" },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://couch.example.com/app/id%20with%20space%2Fslash");
    expect(request(fetch).headers).toMatchObject({ authorization: "Bearer opaque", accept: "application/json" });
  });

  it("returns a missing snapshot for 404 and refuses non-string or foreign keys before I/O", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(404));
    await expect(database.get(key("items", "missing"))).resolves.toEqual({ key: key("items", "missing"), exists: false });

    await expect(database.get(key("items", 1))).rejects.toThrow("require a string CouchDB _id");
    await expect(database.get(key("other", "milk"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.get(key("items", "_design/no-writes"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.get(key("items", ".."))).rejects.toThrow("dot segment");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads getMany in input order with a bounded key count and parallel reads", async () => {
    const { database, fetch } = nativeDatabase({ maxGetManyKeys: 2, maxParallelReads: 1 });
    fetch.mockResolvedValueOnce(response(200, doc("a")));
    fetch.mockResolvedValueOnce(response(404));
    await expect(database.getMany([key("items", "a"), key("items", "b")])).resolves.toMatchObject([
      { key: key("items", "a"), exists: true },
      { key: key("items", "b"), exists: false },
    ]);
    await expect(database.getMany([key("items", "a"), key("items", "b"), key("items", "c")]))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.getMany([key("items", "a"), key("other", "b")]))
      .rejects.toBeInstanceOf(UnsupportedError);
  });

  it("maps the supported filters including faithful explicit-null semantics", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }));
    await database.query(query(items.query()
      .where(DOCUMENT_ID, "==", "milk")
      .where("title", "!=", "Eggs")
      .where("nullable", "==", null)
      .where("nullable", "!=", null)
      .where("title", "in", ["Milk", "Bread"])
      .where("title", "not-in", ["Eggs"])
      .build()));
    expect(body(fetch)).toEqual({
      selector: {
        $and: [
          { _id: { $eq: "milk" } },
          { title: { $ne: "Eggs" } },
          { nullable: { $eq: null } },
          { nullable: { $ne: null } },
          { title: { $in: ["Milk", "Bread"] } },
          { title: { $nin: ["Eggs"] } },
        ],
      },
      limit: 100,
    });
  });

  it("refuses unsupported operators, complex paths, undefined and non-array membership before I/O", async () => {
    const { database, fetch } = nativeDatabase();
    await expect(database.query(query(items.query().where("title", "array-contains", "x").build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query(items.query().where("nested.title", "==", "x").build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query({ ...items.query().build(), filters: [{ field: "title", operator: "==", value: undefined }] })))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query({ ...items.query().build(), filters: [{ field: "title", operator: "in", value: "Milk" }] })))
      .rejects.toThrow("require an array");
    await expect(database.query(query({ ...items.query().build(), filters: [{ field: "nullable", operator: "<", value: null }] })))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query(collection("other").query().build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query(items.query().offset(1).build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query(items.query().startAt("x").build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps records from an explicit docs array and keeps projected _id in data", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, {
      docs: [
        { _id: "milk", _rev: "2-b", title: "Milk", nested: { a: null } },
        { _id: "bread", _rev: "1-a", title: "Bread" },
      ],
      bookmark: "opaque",
    }));
    const page = await database.query(query(items.query().limit(2).build()));
    expect(page.records.map((record) => record.key.id)).toEqual(["milk", "bread"]);
    expect(page.records[0]?.data).toEqual({ _id: "milk", _rev: "2-b", title: "Milk", nested: { a: null } });
    expect(page.records[0]?.metadata).toEqual({ id: "milk", revision: "2-b" });
    expect(page.nextCursor?.values).toHaveLength(1);

    fetch.mockResolvedValueOnce(response(200, {
      docs: [{ _id: "milk", title: "Milk" }],
      bookmark: "opaque",
    }));
    const projected = await database.query(query({ ...items.query().limit(1).build(), projection: ["_id", "title"] }));
    expect(body(fetch, 1)).toMatchObject({ fields: ["_id", "title"] });
    expect(projected.records[0]?.data).toEqual({ _id: "milk", title: "Milk" });
    expect(projected.records[0]?.metadata).toEqual({ id: "milk" });

    fetch.mockResolvedValueOnce(response(200, {
      docs: [{ _id: "milk", _rev: "2-b", title: "Milk" }],
      bookmark: "opaque",
    }));
    const withRevision = await database.query(query({ ...items.query().limit(1).build(), projection: ["_id", "_rev", "title"] }));
    expect(withRevision.records[0]?.metadata).toEqual({ id: "milk", revision: "2-b" });
  });

  it("rejects projections that would drop the native _id before I/O", async () => {
    const { database, fetch } = nativeDatabase();
    await expect(database.query(query({ ...items.query().build(), projection: ["title"] })))
      .rejects.toThrow("must include _id");
    await expect(database.query(query({ ...items.query().build(), projection: ["_id", "_attachments"] })))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query({ ...items.query().build(), projection: [] })))
      .rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function idFromRequest(input: unknown): string {
  const url = new URL(String(input));
  return decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
}

describe("NativeCouchDbDatabase getMany bounds and cancellation", () => {
  it("applies one batch deadline instead of renewing it for every key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementation((input) => new Promise<Response>((resolve) => {
      setTimeout(() => { resolve(response(200, doc(idFromRequest(input)))); }, 30);
    }));
    const database = new NativeCouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      collection: "items",
      fetch,
      timeoutMs: 80,
      maxParallelReads: 1,
    });
    const error = await database.getMany([
      key("items", "a"), key("items", "b"), key("items", "c"), key("items", "d"), key("items", "e"),
    ]).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(fetch.mock.calls.length).toBeLessThan(5);
  });

  it("counts delayed header acquisition against the same batch deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementation((input) => Promise.resolve(response(200, doc(idFromRequest(input)))));
    let issued = 0;
    const database = new NativeCouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      collection: "items",
      fetch,
      timeoutMs: 80,
      maxParallelReads: 1,
      headers: () => new Promise((resolve) => {
        issued += 1;
        setTimeout(() => { resolve({ authorization: `Bearer ${String(issued)}` }); }, 30);
      }),
    });
    const error = await database.getMany([
      key("items", "a"), key("items", "b"), key("items", "c"), key("items", "d"), key("items", "e"),
    ]).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(issued).toBeLessThan(5);
    expect(fetch.mock.calls.length).toBeLessThan(5);
  });

  it("enforces one cumulative response budget before accepting results", async () => {
    const sample = JSON.stringify(doc("a"));
    const perDocument = new TextEncoder().encode(sample).byteLength;
    const database = nativeDatabase({ maxGetManyBytes: perDocument + 4 });
    const fetch = database.fetch;
    fetch.mockImplementation((input) => Promise.resolve(response(200, doc(idFromRequest(input)))));
    const error = await database.database.getMany([key("items", "a"), key("items", "b")]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CouchDbBatchSizeError);
    expect(String(error)).toContain("maxGetManyBytes");
    expect(fetch).toHaveBeenCalledTimes(2);

    const single = nativeDatabase({ maxGetManyBytes: perDocument });
    single.fetch.mockResolvedValueOnce(response(200, doc("a")));
    await expect(single.database.getMany([key("items", "a")])).resolves.toMatchObject([{ key: key("items", "a"), exists: true }]);
  });

  it("aborts pending siblings and issues no later-key request after the first failure", async () => {
    const pending = deferred<Response>();
    const { database, fetch } = nativeDatabase({ maxParallelReads: 2 });
    fetch.mockImplementationOnce(() => Promise.reject(new Error("synthetic transport failure")))
      .mockImplementationOnce(() => pending.promise);
    const error = await database.getMany([key("items", "a"), key("items", "b"), key("items", "c")])
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CouchDbRequestError);
    expect(fetch).toHaveBeenCalledTimes(2);

    const late = response(200, doc("b"));
    const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
    pending.resolve(late);
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    const sequential = nativeDatabase({ maxParallelReads: 1 });
    sequential.fetch.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await expect(sequential.database.getMany([key("items", "a"), key("items", "b"), key("items", "c")]))
      .rejects.toBeInstanceOf(CouchDbRequestError);
    expect(sequential.fetch).toHaveBeenCalledTimes(1);
  });

  it("honours getManyWithSignal without scheduling or accepting late work", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementation(() => pending.promise);
    const database = new NativeCouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      collection: "items",
      fetch,
      maxParallelReads: 1,
    });
    const controller = new AbortController();
    const running = database.getManyWithSignal([
      key("items", "a"), key("items", "b"), key("items", "c"),
    ], controller.signal);
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const late = response(200, doc("a"));
    const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
    pending.resolve(late);
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const headers = vi.fn(() => ({ authorization: "Bearer never" }));
    const aborted = new NativeCouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      collection: "items",
      fetch: vi.fn<typeof globalThis.fetch>(),
      headers,
    });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(aborted.getManyWithSignal([key("items", "a")], preAborted.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(headers).not.toHaveBeenCalled();
  });
});

describe("NativeCouchDbDatabase numeric policy", () => {
  const unsafe = "9007199254740993";

  it("refuses an unsafe raw-wire integer instead of rounding it", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(new Response(`{"_id":"a","_rev":"1-a","amount":${unsafe}}`, { status: 200 }));
    const error = await database.get(key("items", "a")).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain("safe integer");
    expect(String(error)).not.toContain("9007");
  });

  it("covers nested values, arrays, integer-valued decimals, -0 and non-finite tokens", async () => {
    const { database, fetch } = nativeDatabase();
    for (const text of [
      `{"_id":"a","_rev":"1-a","nested":{"deep":{"n":${unsafe}}}}`,
      `{"_id":"a","_rev":"1-a","values":[1,2,${unsafe}]}`,
      `{"_id":"a","_rev":"1-a","amount":${unsafe}.0}`,
      `{"_id":"a","_rev":"1-a","amount":-0}`,
      `{"_id":"a","_rev":"1-a","amount":1e400}`,
    ]) {
      fetch.mockResolvedValueOnce(new Response(text, { status: 200 }));
      const error = await database.get(key("items", "a")).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain("9007");
    }
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("preserves safe integers, fractions, exponents and numeric-looking strings exactly", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(new Response(
      `{"_id":"a","_rev":"1-a","max":9007199254740991,"min":-9007199254740991,"fraction":1.25,"exponent":1e3,"text":"${unsafe}","values":[0,-1.5,9007199254740991]}`,
      { status: 200 },
    ));
    const snapshot = await database.get(key("items", "a"));
    expect(snapshot.data).toEqual({
      _id: "a",
      _rev: "1-a",
      max: Number.MAX_SAFE_INTEGER,
      min: Number.MIN_SAFE_INTEGER,
      fraction: 1.25,
      exponent: 1_000,
      text: unsafe,
      values: [0, -1.5, Number.MAX_SAFE_INTEGER],
    });
  });

  it("applies the same policy to getMany, query and discovery responses", async () => {
    const getMany = nativeDatabase({ maxParallelReads: 1 });
    getMany.fetch.mockResolvedValueOnce(new Response(`{"_id":"a","_rev":"1-a","n":${unsafe}}`, { status: 200 }));
    await expect(getMany.database.getMany([key("items", "a"), key("items", "b")]))
      .rejects.toThrow("safe integer");
    expect(getMany.fetch).toHaveBeenCalledTimes(1);

    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(new Response(`{"docs":[{"_id":"a","n":${unsafe}}],"bookmark":"b"}`, { status: 200 }));
    await expect(database.query(query(items.query().limit(1).build()))).rejects.toThrow("safe integer");

    fetch.mockResolvedValueOnce(new Response(`{"db_name":"app","doc_count":${unsafe}}`, { status: 200 }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "malformed" });

    fetch.mockResolvedValueOnce(new Response(`{"rows":[{"id":"a","doc":{"_id":"a","n":${unsafe}}}]}`, { status: 200 }));
    await expect(database.sampleFields()).resolves.toMatchObject({ status: "unavailable", reason: "malformed" });
  });

  it("refuses unsafe request integers before I/O and still delivers safe values to a codec", async () => {
    const { database, fetch } = nativeDatabase();
    await expect(database.query(query(items.query().where("n", "==", Number.MAX_SAFE_INTEGER + 1).build())))
      .rejects.toThrow("safe integers");
    await expect(database.query(query(items.query().where("n", "in", [1, Number.MAX_SAFE_INTEGER + 1]).build())))
      .rejects.toThrow("safe integers");
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }));
    await database.query(query(items.query().where("n", "==", Number.MAX_SAFE_INTEGER).build()));
    expect(body(fetch)).toMatchObject({ selector: { $and: [{ n: { $eq: Number.MAX_SAFE_INTEGER } }] } });

    const decode = vi.fn((value: unknown) => value as { n: number });
    const codec = { encode: (value: { n: number }) => value, decode };
    fetch.mockResolvedValueOnce(new Response(`{"_id":"a","_rev":"1-a","n":9007199254740991}`, { status: 200 }));
    await expect(database.get(key("items", "a"), codec)).resolves.toMatchObject({ data: { n: Number.MAX_SAFE_INTEGER } });
    expect(decode).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce(new Response(`{"_id":"a","_rev":"1-a","n":${unsafe}}`, { status: 200 }));
    await expect(database.get(key("items", "a"), codec)).rejects.toThrow("safe integer");
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe("NativeCouchDbDatabase ordered queries", () => {
  const ascIndex = {
    ddoc: "_design/status-id",
    name: "status-id-index",
    fields: [{ field: "status", direction: "asc" as const }, { field: "_id", direction: "asc" as const }],
  };
  const descIndex = {
    ddoc: "_design/status-desc",
    name: "status-desc-index",
    fields: [{ field: "status", direction: "desc" as const }, { field: "_id", direction: "desc" as const }],
  };

  it("uses an explicitly permitted index, appends the _id tie-break and disables fallback", async () => {
    const { database, fetch } = nativeDatabase({ permittedIndexes: [ascIndex] });
    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }));
    await database.query(query(items.query().where("status", "==", "open").orderBy("status").limit(3).build()));
    expect(body(fetch)).toEqual({
      selector: { $and: [{ status: { $eq: "open" } }] },
      limit: 3,
      sort: [{ status: "asc" }, { _id: "asc" }],
      use_index: ["_design/status-id", "status-id-index"],
      allow_fallback: false,
    });
  });

  it("supports a matching descending index and preserves an explicit final _id", async () => {
    const { database, fetch } = nativeDatabase({ permittedIndexes: [descIndex] });
    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }));
    await database.query(query(items.query().where("status", "==", "open").orderBy("status", "desc").orderBy(DOCUMENT_ID, "desc").build()));
    expect(body(fetch)).toMatchObject({
      sort: [{ status: "desc" }, { _id: "desc" }],
      use_index: ["_design/status-desc", "status-desc-index"],
      allow_fallback: false,
    });
  });

  it("refuses absent/unmatched indexes and mixed directions before I/O", async () => {
    const { database, fetch } = nativeDatabase({ permittedIndexes: [ascIndex] });
    await expect(database.query(query(items.query().where("status", "==", "open").orderBy("status", "desc").build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(query(items.query().where("status", "==", "open").orderBy("status").orderBy(DOCUMENT_ID, "desc").build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    const noIndex = nativeDatabase();
    await expect(noIndex.database.query(query(items.query().where("status", "==", "open").orderBy("status").build())))
      .rejects.toThrow("permitted index");
    expect(fetch).not.toHaveBeenCalled();
    expect(noIndex.fetch).not.toHaveBeenCalled();
  });

  it("requires a bounded filter on at least one requested sort field", async () => {
    const { database, fetch } = nativeDatabase({ permittedIndexes: [ascIndex] });
    await expect(database.query(query(items.query().orderBy("status").build())))
      .rejects.toThrow("filter on at least one sort field");
    await expect(database.query(query(items.query().where("status", "!=", "closed").orderBy("status").build())))
      .rejects.toThrow("filter on at least one sort field");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a permitted index without the _id tie-break", () => {
    expect(() => nativeDatabase({ permittedIndexes: [{ ddoc: "_design/status", name: "s", fields: [{ field: "status", direction: "asc" }] }] }))
      .toThrow("_id tie-break");
  });
});

describe("NativeCouchDbDatabase cursor binding", () => {
  const ascIndex = {
    ddoc: "_design/status-id",
    name: "status-id-index",
    fields: [{ field: "status", direction: "asc" as const }, { field: "_id", direction: "asc" as const }],
  };

  async function firstPage(options: Partial<ConstructorParameters<typeof NativeCouchDbDatabase>[0]> = {}) {
    const state = nativeDatabase({ permittedIndexes: [ascIndex], ...options });
    state.fetch.mockResolvedValueOnce(response(200, {
      docs: [{ _id: "a", _rev: "1-a", status: "open" }, { _id: "b", _rev: "1-a", status: "open" }],
      bookmark: "provider-bookmark",
    }));
    const built = query(items.query().where("status", "==", "open").orderBy("status").limit(2).build());
    const page = await state.database.query(built);
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("expected an opaque cursor");
    return { ...state, built, cursor, page };
  }

  it("returns an unguessable opaque handle that carries no filter, bookmark or credential", async () => {
    const { cursor, fetch } = await firstPage({ headers: () => ({ authorization: "Bearer super-secret-token" }) });
    expect(cursor).toMatch(/^nc1_[A-Za-z0-9_-]{43}$/u);
    expect(cursor).not.toContain("open");
    expect(cursor).not.toContain("super-secret-token");
    expect(cursor).not.toContain("provider-bookmark");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("continues with the same query, page size and adapter-stored bookmark", async () => {
    const { database, fetch, built, cursor } = await firstPage();
    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "next" }));
    const page = await database.query({ ...built, startAfter: { values: [cursor] } });
    expect(page.records).toEqual([]);
    expect(body(fetch, 1)).toMatchObject({ bookmark: "provider-bookmark", limit: 2 });
  });

  it("rejects changed query/filter/projection/page size before I/O", async () => {
    const { database, fetch, built, cursor } = await firstPage();
    await expect(database.query({ ...built, filters: [{ field: "status", operator: "==", value: "done" }], startAfter: { values: [cursor] } }))
      .rejects.toThrow("does not match the query");
    await expect(database.query({ ...built, limit: 1, startAfter: { values: [cursor] } }))
      .rejects.toThrow("does not match the query");
    await expect(database.query({ ...built, projection: ["_id", "status"], startAfter: { values: [cursor] } }))
      .rejects.toThrow("does not match the query");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed bookmark even with every legacy binding field retained", async () => {
    const { database, fetch, built, cursor } = await firstPage();
    const forged = legacyCursor({
      a: "@dal-go/dalgo2couchdb",
      v: 2,
      m: "native",
      i: cursor.slice(4, 20),
      e: "0".repeat(16),
      c: "1".repeat(16),
      q: "2".repeat(16),
      s: "3".repeat(16),
      l: 2,
      b: "attacker-bookmark",
    });
    await expect(database.query({ ...built, startAfter: { values: [forged] } }))
      .rejects.toThrow("cursor is invalid");
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(database.query({ ...built, startAfter: { values: [tampered] } }))
      .rejects.toThrow("invalid or unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects reconstructed tokens, foreign instances and foreign endpoints", async () => {
    const { database, fetch, built, cursor } = await firstPage();
    const reconstructed = legacyCursor({
      adapter: "@dal-go/dalgo2couchdb",
      version: 2,
      bookmark: "provider-bookmark",
      cursor,
    });
    await expect(database.query({ ...built, startAfter: { values: [reconstructed] } }))
      .rejects.toThrow("cursor is invalid");

    const foreign = nativeDatabase({ permittedIndexes: [ascIndex] });
    await expect(foreign.database.query({ ...built, startAfter: { values: [cursor] } }))
      .rejects.toThrow("invalid or unknown to this adapter instance");
    expect(foreign.fetch).not.toHaveBeenCalled();

    const changedEndpoint = new NativeCouchDbDatabase({
      databaseUrl: "https://other.example.com/app",
      collection: "items",
      fetch: foreign.fetch,
      permittedIndexes: [ascIndex],
    });
    await expect(changedEndpoint.query({ ...built, startAfter: { values: [cursor] } }))
      .rejects.toThrow("invalid or unknown to this adapter instance");
    expect(foreign.fetch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("binds an implicit cursor to the credential scope and allows an explicit stable scope", async () => {
    let token = "Bearer first";
    const { database, fetch, built, cursor } = await firstPage({ headers: () => ({ authorization: token }) });
    token = "Bearer refreshed";
    await expect(database.query({ ...built, startAfter: { values: [cursor] } }))
      .rejects.toThrow("credential scope");
    expect(fetch).toHaveBeenCalledTimes(1);

    let stableToken = "Bearer first";
    const stable = await firstPage({ headers: () => ({ authorization: stableToken }), cursorScope: "synthetic-user" });
    stableToken = "Bearer refreshed";
    stable.fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "next" }));
    await expect(stable.database.query({ ...stable.built, startAfter: { values: [stable.cursor] } }))
      .resolves.toMatchObject({ records: [] });
  });

  it("continues multiple pages and rejects replay after consumption", async () => {
    const { database, fetch, built, cursor } = await firstPage();
    fetch.mockResolvedValueOnce(response(200, {
      docs: [{ _id: "c", status: "open" }, { _id: "d", status: "open" }],
      bookmark: "second-bookmark",
    }));
    const second = await database.query({ ...built, startAfter: { values: [cursor] } });
    const secondCursor = second.nextCursor?.values[0];
    if (typeof secondCursor !== "string") throw new Error("expected a second cursor");
    expect(secondCursor).not.toBe(cursor);

    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "third-bookmark" }));
    await expect(database.query({ ...built, startAfter: { values: [secondCursor] } }))
      .resolves.toMatchObject({ records: [] });

    await expect(database.query({ ...built, startAfter: { values: [cursor] } }))
      .rejects.toThrow("already been used");
    await expect(database.query({ ...built, startAfter: { values: [secondCursor] } }))
      .rejects.toThrow("already been used");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds issued cursor state and retires only the oldest pending handle", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, { db_name: "app", doc_count: 0 }));
    fetch.mockResolvedValueOnce(response(200, { indexes: [] }));
    fetch.mockResolvedValueOnce(response(200, { rows: [] }));
    const limits = (await database.describe()).limits;
    expect(limits.maxIssuedCursors).toBeGreaterThan(0);
    expect(limits.maxConservedCursors).toBeGreaterThan(0);

    fetch.mockImplementation(() => Promise.resolve(response(200, { docs: [{ _id: "a" }], bookmark: "bookmark" })));
    let oldest: string | undefined;
    let newest: string | undefined;
    for (let index = 0; index < limits.maxIssuedCursors + 1; index += 1) {
      const page = await database.query(query(items.query().limit(1).build()));
      const token = page.nextCursor?.values[0];
      if (typeof token !== "string") throw new Error("expected a cursor");
      if (index === 0) oldest = token;
      newest = token;
    }
    if (oldest === undefined || newest === undefined) throw new Error("expected cursors");
    await expect(database.query({ ...items.query().limit(1).build(), startAfter: { values: [oldest] } }))
      .rejects.toThrow("invalid or unknown to this adapter instance");
    const continued = await database.query({ ...items.query().limit(1).build(), startAfter: { values: [newest] } });
    expect(continued.records).toHaveLength(1);
  });

  it("rejects malformed/forged tokens and non-single cursor values", async () => {
    const { database, fetch, built } = await firstPage();
    await expect(database.query({ ...built, startAfter: { values: ["not-a-cursor"] } }))
      .rejects.toThrow("cursor is invalid");
    await expect(database.query({ ...built, startAfter: { values: [`nc1_${"A".repeat(43)}`] } }))
      .rejects.toThrow("invalid or unknown");
    await expect(database.query({ ...built, startAfter: { values: ["x", "y"] } }))
      .rejects.toThrow("exactly one");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("NativeCouchDbDatabase response validation and bounds", () => {
  it("rejects missing/null/malformed docs arrays and full pages without a bookmark", async () => {
    const { database, fetch } = nativeDatabase();
    for (const payload of [{}, { docs: null }, { docs: [null] }, { docs: [{ _rev: "1-a" }] }]) {
      fetch.mockResolvedValueOnce(response(200, payload));
      await expect(database.query(query(items.query().limit(1).build()))).rejects.toBeInstanceOf(TypeError);
    }
    fetch.mockResolvedValueOnce(response(200, { docs: [{ _id: "milk" }] }));
    await expect(database.query(query(items.query().limit(1).build()))).rejects.toThrow("completion is unknown");
    fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }));
    await expect(database.query(query(items.query().limit(1).build()))).resolves.toMatchObject({ records: [] });
  });

  it("rejects over-limit rows and duplicate ids before decoding", async () => {
    const { database, fetch } = nativeDatabase();
    const decode = vi.fn((value: unknown) => value as { title: string });
    const coded = collection<{ title: string }>("items", { codec: { encode: (value) => value, decode } });
    fetch.mockResolvedValueOnce(response(200, { docs: [{ _id: "a" }, { _id: "b" }], bookmark: "b" }));
    await expect(database.query(query(coded.query().limit(1).build()))).rejects.toThrow("more rows");
    expect(decode).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response(200, { docs: [{ _id: "a" }, { _id: "a" }], bookmark: "b" }));
    await expect(database.query(query(coded.query().limit(2).build()))).rejects.toThrow("duplicate");
  });

  it("enforces exact page, byte and batch bounds", async () => {
    const bounded = nativeDatabase({ maxQueryLimit: 2, maxRequestBytes: 40, maxResponseBytes: 16 });
    await expect(bounded.database.query(query(items.query().limit(3).build())))
      .rejects.toBeInstanceOf(UnsupportedError);
    await expect(bounded.database.query(query(items.query().where("title", "==", "a value that is too long").build())))
      .rejects.toThrow("maxRequestBytes");
    bounded.fetch.mockResolvedValueOnce(response(200, { docs: [], bookmark: "b" }, { "content-length": "99" }));
    await expect(bounded.database.query(query(items.query().limit(2).build()))).rejects.toThrow("maxResponseBytes");

    const exact = nativeDatabase({ maxQueryLimit: 2 });
    exact.fetch.mockResolvedValueOnce(response(200, { docs: [{ _id: "a" }, { _id: "b" }], bookmark: "b" }));
    await expect(exact.database.query(query(items.query().limit(2).build()))).resolves.toMatchObject({ records: [{ key: key("items", "a") }, { key: key("items", "b") }] });
    expect(bounded.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe URLs, collection names and credentials before I/O", () => {
    expect(() => nativeDatabase({ databaseUrl: "http://couch.example.com/app" })).toThrow("HTTPS");
    expect(() => nativeDatabase({ databaseUrl: "https://user:password@couch.example.com/app" })).toThrow("credentials");
    expect(() => nativeDatabase({ databaseUrl: "https://couch.example.com/app/other" })).toThrow("exactly one");
    expect(() => nativeDatabase({ databaseUrl: "https://couch.example.com/_users" })).toThrow("management endpoint");
    expect(() => nativeDatabase({ collection: "items/nested" })).toThrow("without a path");
    expect(() => nativeDatabase({ cursorScope: "bad\nscope" })).toThrow("control-free");
    expect(() => nativeDatabase({ maxGetManyBytes: 0 })).toThrow("maxGetManyBytes");
  });
});

describe("NativeCouchDbDatabase cancellation", () => {
  it("does no header or HTTP work for an already-aborted caller", async () => {
    const { database, fetch, headers } = nativeDatabase();
    const controller = new AbortController();
    controller.abort();
    await expect(database.queryWithSignal(query(items.query().build()), controller.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a caller abort while headers are pending and never starts the request", async () => {
    let resolveHeaders: ((value: Readonly<Record<string, string>>) => void) | undefined;
    const headers = vi.fn(() => new Promise<Readonly<Record<string, string>>>((resolve) => { resolveHeaders = resolve; }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const database = new NativeCouchDbDatabase({ databaseUrl: "https://couch.example.com/app", collection: "items", fetch, headers });
    const controller = new AbortController();
    const running = database.queryWithSignal(query(items.query().build()), controller.signal);
    await vi.waitFor(() => { expect(headers).toHaveBeenCalledTimes(1); });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    resolveHeaders?.({ authorization: "Bearer late" });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops an in-flight request, cancels a late body and never returns a late page", async () => {
    const { database, fetch } = nativeDatabase();
    let resolve: ((value: Response) => void) | undefined;
    fetch.mockReturnValueOnce(new Promise<Response>((promise) => { resolve = promise; }));
    const controller = new AbortController();
    const running = database.queryWithSignal(query(items.query().build()), controller.signal);
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
    const late = response(200, { docs: [], bookmark: "b" });
    const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    resolve?.(late);
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledTimes(1); });
  });

  it("cancels a hanging body and applies one deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel });
    fetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const database = new NativeCouchDbDatabase({ databaseUrl: "https://couch.example.com/app", collection: "items", fetch, timeoutMs: 5_000 });
    const controller = new AbortController();
    const running = database.queryWithSignal(query(items.query().build()), controller.signal);
    const settled = running.catch((reason: unknown) => reason);
    await vi.waitFor(() => { expect(stream.locked).toBe(true); });
    controller.abort();
    expect(await settled).toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(cancel).toHaveBeenCalledTimes(1);

    const deadlineFetch = vi.fn<typeof globalThis.fetch>();
    const deadlineCancel = vi.fn(() => new Promise<void>(() => undefined));
    const deadlineStream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel: deadlineCancel });
    deadlineFetch.mockResolvedValueOnce(new Response(deadlineStream, { status: 200 }));
    const deadlineDatabase = new NativeCouchDbDatabase({ databaseUrl: "https://couch.example.com/app", collection: "items", fetch: deadlineFetch, timeoutMs: 250 });
    const deadline = deadlineDatabase.queryWithSignal(query(items.query().build()), new AbortController().signal);
    const deadlineError = deadline.catch((reason: unknown) => reason);
    await vi.waitFor(() => { expect(deadlineStream.locked).toBe(true); });
    expect(await deadlineError).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(deadlineCancel).toHaveBeenCalledTimes(1);
  });

  it("issues no later request after an abort and redacts transport secrets", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, { docs: [{ _id: "a" }], bookmark: "b" }));
    const controller = new AbortController();
    const page = await database.queryWithSignal(query(items.query().limit(1).build()), controller.signal);
    expect(page.nextCursor?.values).toHaveLength(1);
    controller.abort();
    await expect(database.queryWithSignal(query(items.query().startAfter(...(page.nextCursor?.values ?? [])).build()), controller.signal))
      .rejects.toBeInstanceOf(QueryCancelledError);
    expect(fetch).toHaveBeenCalledTimes(1);

    const headerFailure = nativeDatabase({ headers: () => { throw new Error("Bearer secret header"); } });
    await expect(headerFailure.database.queryWithSignal(query(items.query().build()), new AbortController().signal))
      .rejects.toBeInstanceOf(CouchDbRequestError);

    const fetchFailure = nativeDatabase();
    fetchFailure.fetch.mockRejectedValueOnce(new Error("Bearer secret fetch"));
    const error = await fetchFailure.database.queryWithSignal(query(items.query().build()), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CouchDbRequestError);
    expect(String(error)).not.toContain("secret");

    const httpFailure = nativeDatabase();
    httpFailure.fetch.mockResolvedValueOnce(response(401, { reason: "Bearer secret body" }));
    const httpError = await httpFailure.database.queryWithSignal(query(items.query().build()), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(httpError).toBeInstanceOf(CouchDbHttpError);
    expect(String(httpError)).not.toContain("secret");
  });
});

describe("NativeCouchDbDatabase read-only surface", () => {
  it("refuses every mutation entry point explicitly without I/O", async () => {
    const { database, fetch } = nativeDatabase();
    await expect(database.insert(key("items", "milk"), { title: "Milk" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.set(key("items", "milk"), { title: "Milk" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.update(key("items", "milk"), { title: "Milk" })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.delete(key("items", "milk"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(database.readOnly).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("NativeCouchDbDatabase metadata discovery", () => {
  it("tests the configured database without administration or cluster endpoints", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, {
      db_name: "app",
      doc_count: 6,
      doc_del_count: 1,
      update_seq: "12-g1AA",
      compact_running: false,
      sizes: { active: 10, external: 20, file: 30 },
    }));
    await expect(database.testConnection()).resolves.toEqual({
      ok: true,
      collection: "items",
      database: { database: "app", documentCount: 6, deletedDocumentCount: 1, updateSequence: "12-g1AA", compactRunning: false, sizes: { active: 10, external: 20, file: 30 } },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://couch.example.com/app");
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("_all_dbs");
  });

  it("reports denied, missing, malformed and unavailable metadata explicitly", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(401, { reason: "secret" }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "unauthorized", httpStatus: 401 });
    fetch.mockResolvedValueOnce(response(403, { reason: "secret" }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "forbidden", httpStatus: 403 });
    fetch.mockResolvedValueOnce(response(404, { reason: "secret" }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "not-found", httpStatus: 404 });
    fetch.mockResolvedValueOnce(response(200, { db_name: "other", doc_count: 0 }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "malformed" });
    fetch.mockResolvedValueOnce(response(200, { db_name: "app" }, { "content-length": "999999" }));
    await expect(database.testConnection()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("discovers indexes with explicit forms, partial flags and an unavailable result", async () => {
    const { database, fetch } = nativeDatabase();
    fetch.mockResolvedValueOnce(response(200, {
      total_rows: 4,
      indexes: [
        { ddoc: null, name: "_all_docs", type: "special", def: { fields: [{ _id: "asc" }] } },
        { ddoc: "_design/status", name: "status-index", type: "json", partitioned: false, def: { fields: [{ field: "status", dir: "asc" }] } },
        { ddoc: "_design/partial", name: "partial-index", type: "json", def: { fields: [{ status: "asc" }], partial_filter_selector: { status: { $eq: "open" } } } },
        { ddoc: "_design/text", name: "text-index", type: "text", def: { fields: [{ name: "title", type: "string" }] } },
      ],
    }));
    await expect(database.listIndexes()).resolves.toEqual({
      status: "available",
      total: 4,
      indexes: [
        { ddoc: null, name: "_all_docs", type: "special", fields: [{ field: "_id", direction: "asc" }], partial: false, partitioned: null },
        { ddoc: "_design/status", name: "status-index", type: "json", fields: [{ field: "status", direction: "asc" }], partial: false, partitioned: false },
        { ddoc: "_design/partial", name: "partial-index", type: "json", fields: [{ field: "status", direction: "asc" }], partial: true, partitioned: null },
        { ddoc: "_design/text", name: "text-index", type: "text", fields: [{ field: "title", direction: null, type: "string" }], partial: false, partitioned: null },
      ],
    });
    fetch.mockResolvedValueOnce(response(200, { indexes: null }));
    await expect(database.listIndexes()).resolves.toMatchObject({ status: "unavailable", reason: "malformed" });
    fetch.mockResolvedValueOnce(response(403, {}));
    await expect(database.listIndexes()).resolves.toMatchObject({ status: "unavailable", reason: "forbidden", httpStatus: 403 });
  });

  it("samples a bounded top-level field set and labels configured fields", async () => {
    const { database, fetch } = nativeDatabase({ maxSampleDocuments: 3 });
    fetch.mockResolvedValueOnce(response(200, {
      total_rows: 4,
      rows: [
        { id: "_design/no-writes", doc: { _id: "_design/no-writes", validate_doc_update: "x" } },
        { id: "milk", doc: { _id: "milk", _rev: "1-a", title: "Milk", nullable: null, nested: { a: 1 } } },
        { id: "eggs", doc: { _id: "eggs", _rev: "1-a", title: "Eggs", qty: 12 } },
      ],
    }));
    await expect(database.sampleFields()).resolves.toEqual({
      status: "sampled",
      fields: ["_id", "_rev", "nested", "nullable", "qty", "title"],
      sampleSize: 2,
      truncated: true,
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("/_all_docs?include_docs=true&limit=3");
    expect(fetch.mock.calls[0]?.[0]).not.toContain("_all_dbs");

    const configured = nativeDatabase({ configuredFields: ["_id", "title"] });
    await expect(configured.database.sampleFields()).resolves.toEqual({ status: "configured", fields: ["_id", "title"] });
    expect(configured.fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response(200, { rows: [{ id: "milk" }] }));
    await expect(database.sampleFields()).resolves.toMatchObject({ status: "unavailable", reason: "malformed" });
  });

  it("describes the configured resource, limits and both capability identities", async () => {
    const { database, fetch } = nativeDatabase({ maxSampleDocuments: 7, maxMetadataBytes: 4_096, permittedIndexes: [{ ddoc: "_design/s", name: "s", fields: [{ field: "status", direction: "asc" }, { field: "_id", direction: "asc" }] }] });
    fetch.mockResolvedValueOnce(response(200, { db_name: "app", doc_count: 0, doc_del_count: 0, update_seq: 0, compact_running: false }));
    fetch.mockResolvedValueOnce(response(200, { total_rows: 1, indexes: [{ ddoc: null, name: "_all_docs", type: "special", def: { fields: [{ _id: "asc" }] } }] }));
    fetch.mockResolvedValueOnce(response(200, { rows: [] }));
    const described = await database.describe();
    expect(described).toMatchObject({
      adapter: "@dal-go/dalgo2couchdb",
      storage: "native-rows",
      readOnly: true,
      resource: { database: "app", collection: "items" },
      database: { ok: true },
      indexes: { status: "available" },
      fields: { status: "sampled", sampleSize: 0, truncated: false },
      limits: { maxSampleDocuments: 7, maxMetadataBytes: 4_096 },
    });
    expect(database.capabilities).toBe(NATIVE_COUCHDB_READ_CAPABILITIES);
    expect(NATIVE_COUCHDB_READ_CAPABILITIES.storage).toBe("native-rows");
    expect(COUCHDB_READ_CAPABILITIES.storage).toBe("managed-envelope");
    expect(NATIVE_COUCHDB_READ_CAPABILITIES.query.sort.status).toBe("configured");
    expect(NATIVE_COUCHDB_READ_CAPABILITIES.query.native.status).toBe("unsupported");
    expect(NATIVE_COUCHDB_READ_CAPABILITIES.query.discovery.status).toBe("native");
  });
});

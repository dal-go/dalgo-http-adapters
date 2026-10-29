import { describe, expect, it, vi } from "vitest";
import { Key, UnsupportedError, type Codec } from "@dalgo/core";

import {
  TYPESENSE_READ_CAPABILITIES,
  TypesenseContinuationBoundError,
  TypesenseDatabase,
  TypesenseJsonNumberError,
  TypesenseRequestError,
  TypesenseSemanticError,
  type TypesenseDatabaseOptions,
  type TypesenseQuery,
} from "../src/index.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function options(overrides: Partial<TypesenseDatabaseOptions> = {}): TypesenseDatabaseOptions {
  return {
    baseUrl: "https://typesense.example.test:8108",
    collection: "books",
    headers: () => ({ "X-TYPESENSE-API-KEY": "search-key" }),
    timeoutMs: 5_000,
    maxQueryLimit: 10,
    maxRowsPerPage: 10,
    maxGetManyKeys: 10,
    ...overrides,
  };
}

function database(fetch: FetchMock, overrides: Partial<TypesenseDatabaseOptions> = {}): TypesenseDatabase {
  return new TypesenseDatabase({ ...options(overrides), fetch });
}

function searchHits(found: number, documents: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown {
  return {
    found,
    out_of: found,
    page: 1,
    hits: documents.map((document) => ({ document, text_match: 1, curated: false })),
    ...extra,
  };
}

function query<T>(overrides: Partial<TypesenseQuery<T>> = {}): TypesenseQuery<T> {
  return {
    source: { kind: "collection", name: "books" },
    filters: [],
    orders: [],
    limit: 2,
    ...overrides,
  };
}

function url(fetch: FetchMock, index = 0): URL {
  return new URL(String(fetch.mock.calls[index]?.[0]));
}

function header(fetch: FetchMock, index: number, name: string): string | undefined {
  const init = fetch.mock.calls[index]?.[1] as RequestInit | undefined;
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

describe("TypesenseDatabase reads", () => {
  it("uses one exact-id search for getMany, preserves requested order and missing keys, and never asks for schema", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(2, [
      { id: "1", title: "One" },
      { id: "001", title: "Zero zero one" },
    ])));
    const db = database(fetch);
    const keys = [new Key("books", "001"), new Key("books", "missing"), new Key("books", "1"), new Key("books", "001")];

    await expect(db.getMany(keys)).resolves.toEqual([
      { key: keys[0], exists: true, data: { id: "001", title: "Zero zero one" } },
      { key: keys[1], exists: false },
      { key: keys[2], exists: true, data: { id: "1", title: "One" } },
      { key: keys[3], exists: true, data: { id: "001", title: "Zero zero one" } },
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(url(fetch).pathname).toBe("/collections/books/documents/search");
    expect(url(fetch).searchParams.get("filter_by")).toBe("id:=[`001`,`missing`,`1`]");
    expect(url(fetch).searchParams.get("limit")).toBe("3");
    expect(url(fetch).searchParams.get("enable_curations")).toBe("false");
    expect(url(fetch).searchParams.get("filter_curated_hits")).toBe("true");
    expect(header(fetch, 0, "x-typesense-api-key")).toBe("search-key");
  });

  it("refuses unsafe ids and negative document-id probes before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch);
    await expect(db.get(new Key("books", 1))).rejects.toThrow("string Typesense id");
    await expect(db.get(new Key("books", "has`backtick"))).rejects.toThrow("backtick");
    await expect(db.getMany([new Key("books", "ok"), new Key("other", "x")])).rejects.toThrow("configured for collection");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("projects exact fields, hides predicate helpers and keeps missing distinct from explicit null", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(2, [{
      id: "004",
      title: "Neuromancer",
      genre: "cyberpunk",
    }, {
      id: "005",
      title: "Foundation",
      genre: "cyberpunk",
      note: null,
    }])));
    const db = database(fetch);
    const page = await db.query<{ title: string; note?: string | null }>(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      projection: ["title", "note"],
      limit: 2,
    }));

    expect(page.records).toHaveLength(2);
    expect(page.records[0]?.key).toEqual(new Key("books", "004"));
    expect(page.records[0]?.data).toEqual({ title: "Neuromancer" });
    expect(page.records[0]?.data).not.toHaveProperty("note");
    expect(page.records[1]?.data).toEqual({ title: "Foundation", note: null });
    expect(page.records[1]?.data).toHaveProperty("note");
    expect(page.records[0]?.data).not.toHaveProperty("id");
    expect(page.records[0]?.data).not.toHaveProperty("genre");
    expect(url(fetch).searchParams.get("filter_by")).toBe("genre:=`cyberpunk`");
    expect(url(fetch).searchParams.get("include_fields")).toBe("id,title,note,genre");
    expect(url(fetch).searchParams.get("q")).toBe("*");
    expect(url(fetch).searchParams.get("num_typos")).toBe("0");
    expect(url(fetch).searchParams.get("prefix")).toBe("false");
    expect(url(fetch).searchParams.get("drop_tokens_threshold")).toBe("0");
    expect(url(fetch).searchParams.get("typo_tokens_threshold")).toBe("0");
  });

  it("refuses a later-prefix candidate mismatch before exposing any row", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(2, [
      { id: "004", title: "Neuromancer", genre: "cyberpunk" },
      { id: "001", title: "Dune", genre: "science fiction" },
    ])));
    const db = database(fetch);
    await expect(db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      offset: 1,
      limit: 1,
    }))).rejects.toBeInstanceOf(TypesenseSemanticError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("verifies the full prefix on a later cursor page and commits the handle only after success", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "004", title: "A", genre: "cyberpunk" },
        { id: "006", title: "B", genre: "cyberpunk" },
      ])))
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "004", title: "A", genre: "cyberpunk" },
        { id: "006", title: "B", genre: "cyberpunk" },
      ])))
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "009", title: "C", genre: "cyberpunk" },
      ])));
    const db = database(fetch, { maxRowsPerPage: 2 });
    const first = await db.query(query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }] }));
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const second = await db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      startAfter: { values: [token] },
    }));
    expect(second.records.map((record) => record.key.id)).toEqual(["009"]);
    expect(second.nextCursor).toBeUndefined();
    expect(url(fetch, 1).searchParams.get("offset")).toBeNull();
    expect(url(fetch, 2).searchParams.get("offset")).toBe("2");

    await expect(db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      startAfter: { values: [token] },
    }))).rejects.toMatchObject({ reason: "used" });
  });
});

describe("Typesense continuation transactions", () => {
  it("cancels a real continuation request and retries the same handle", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    const db = database(fetch, { identityScope: "reader-1" });
    const plan = query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }] });
    const first = await db.query(plan);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");

    // The actual continuation, not the initial query, is canceled in flight.
    const controller = new AbortController();
    fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new DOMException("aborted", "AbortError"));
      }, 5);
    }));
    await expect(db.queryWithSignal({ ...plan, startAfter: { values: [token] } }, controller.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });

    fetch.mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
      { id: "009", genre: "cyberpunk" },
    ])));
    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["009"]);
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
  });

  it("preserves the original handle when the next handle cannot be generated at the cache bound", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(5, [
      { id: "001" },
      { id: "002" },
    ])));
    const db = database(fetch, { identityScope: "reader-1", maxRowsPerPage: 2, maxIssuedCursors: 1 });
    const plan = query({ limit: 2 });
    const first = await db.query(plan);
    expect(first.records.map((record) => record.key.id)).toEqual(["001", "002"]);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      random.mockImplementationOnce(() => { throw new RangeError("random failure"); });
      fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
      await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toThrow("random failure");
    } finally {
      random.mockRestore();
    }

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["003", "004"]);
    const next = retried.nextCursor?.values[0];
    expect(typeof next).toBe("string");

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "005" }])));
    const final = await db.query({ ...plan, startAfter: { values: [next] } });
    expect(final.records.map((record) => record.key.id)).toEqual(["005"]);
    expect(final.nextCursor).toBeUndefined();
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("preserves the original handle when cancellation happens during next-handle generation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(5, [
      { id: "001" },
      { id: "002" },
    ])));
    const db = database(fetch, { identityScope: "reader-1", maxRowsPerPage: 2, maxIssuedCursors: 1 });
    const plan = query({ limit: 2 });
    const token = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const controller = new AbortController();
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      random.mockImplementationOnce((bytes) => {
        controller.abort();
        return bytes;
      });
      fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
      await expect(db.queryWithSignal({ ...plan, startAfter: { values: [token] } }, controller.signal))
        .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    } finally {
      random.mockRestore();
    }

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["003", "004"]);
    const next = retried.nextCursor?.values[0];
    expect(typeof next).toBe("string");

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "005" }])));
    const final = await db.query({ ...plan, startAfter: { values: [next] } });
    expect(final.records.map((record) => record.key.id)).toEqual(["005"]);
    expect(final.nextCursor).toBeUndefined();
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not evict an outstanding handle when a fresh page cannot issue its next handle", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(5, [
      { id: "001" },
      { id: "002" },
    ])));
    const db = database(fetch, { identityScope: "reader-1", maxRowsPerPage: 2, maxIssuedCursors: 1 });
    const plan = query({ limit: 2 });
    const token = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      random.mockImplementationOnce(() => { throw new RangeError("random failure"); });
      fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
      await expect(db.query(plan)).rejects.toThrow("random failure");
    } finally {
      random.mockRestore();
    }

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["003", "004"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("frees the resumed slot before publishing its replacement at the cache bound", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch, { identityScope: "reader-1", maxRowsPerPage: 2, maxIssuedCursors: 2 });
    const plan = query({ limit: 2 });

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "001" }, { id: "002" }])));
    const handleA = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof handleA).toBe("string");

    // A second fresh page issues a second outstanding handle at the cache bound.
    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "001" }, { id: "002" }])));
    const handleB = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof handleB).toBe("string");
    expect(handleB).not.toBe(handleA);

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
    const resumedB = await db.query({ ...plan, startAfter: { values: [handleB] } });
    expect(resumedB.records.map((record) => record.key.id)).toEqual(["003", "004"]);
    const handleC = resumedB.nextCursor?.values[0];
    expect(typeof handleC).toBe("string");
    expect(handleC).not.toBe(handleB);

    // Resuming B consumed B only: A must still be outstanding and usable.
    await expect(db.query({ ...plan, startAfter: { values: [handleB] } })).rejects.toMatchObject({ reason: "used" });
    expect(fetch).toHaveBeenCalledTimes(3);

    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "003" }, { id: "004" }])));
    const resumedA = await db.query({ ...plan, startAfter: { values: [handleA] } });
    expect(resumedA.records.map((record) => record.key.id)).toEqual(["003", "004"]);
    const handleD = resumedA.nextCursor?.values[0];
    expect(typeof handleD).toBe("string");
    expect(handleD).not.toBe(handleA);
    await expect(db.query({ ...plan, startAfter: { values: [handleA] } })).rejects.toMatchObject({ reason: "used" });

    // C was published by the B resume and survived A's resume.
    fetch.mockResolvedValueOnce(response(searchHits(5, [{ id: "005" }])));
    const resumedC = await db.query({ ...plan, startAfter: { values: [handleC] } });
    expect(resumedC.records.map((record) => record.key.id)).toEqual(["005"]);
    expect(resumedC.nextCursor).toBeUndefined();
    await expect(db.query({ ...plan, startAfter: { values: [handleC] } })).rejects.toMatchObject({ reason: "used" });

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(url(fetch, 0).searchParams.get("offset")).toBeNull();
    expect(url(fetch, 1).searchParams.get("offset")).toBeNull();
    expect(url(fetch, 2).searchParams.get("offset")).toBe("2");
    expect(url(fetch, 3).searchParams.get("offset")).toBe("2");
    expect(url(fetch, 4).searchParams.get("offset")).toBe("4");
  });

  it("releases the lease when a codec synchronously aborts the operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    const db = database(fetch, { identityScope: "reader-1" });
    const plan = query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }] });
    const token = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const controller = new AbortController();
    fetch.mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
      { id: "009", genre: "cyberpunk" },
    ])));
    const abortingCodec: Codec<unknown> = {
      decode(data) { controller.abort(); return data; },
      encode(value) { return value; },
    };
    await expect(db.queryWithSignal({
      ...plan,
      source: { kind: "collection", name: "books", codec: abortingCodec },
      startAfter: { values: [token] },
    }, controller.signal)).rejects.toMatchObject({ name: "QueryCancelledError" });

    fetch.mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
      { id: "009", genre: "cyberpunk" },
    ])));
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).resolves.toBeDefined();
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
  });

  it("binds the exact admitted predicate, so > and >= with one native filter cannot share a handle", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ name: "books", fields: [{ name: "year", type: "int32", facet: true }] }))
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "004", year: 1984 },
        { id: "006", year: 1992 },
      ])))
      .mockResolvedValueOnce(response({ name: "books", fields: [{ name: "year", type: "int32", facet: true }] }))
      .mockResolvedValueOnce(response({ name: "books", fields: [{ name: "year", type: "int32", facet: true }] }))
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "004", year: 1984 },
        { id: "006", year: 1992 },
      ])))
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "009", year: 1995 },
      ])));
    const db = database(fetch, { maxRowsPerPage: 2 });
    const base = query<{ year: number }>({ filters: [{ field: "year", operator: ">", value: 1965 }] });
    const first = await db.query(base);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");
    expect(url(fetch, 1).searchParams.get("filter_by")).toBe("year:>=1965");

    await expect(db.query(query({
      filters: [{ field: "year", operator: ">=", value: 1965 }],
      startAfter: { values: [token] },
    }))).rejects.toMatchObject({ reason: "changed-query" });
    // The widened neighbour was refused before it could issue a search request.
    expect(fetch).toHaveBeenCalledTimes(3);
    // The original strict handle was never consumed by the refusal.
    const retried = await db.query({ ...base, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["009"]);
  });

  it("releases the lease after a scope mismatch during execute", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    let key = "reader-a";
    const db = database(fetch, { headers: () => ({ "X-TYPESENSE-API-KEY": key }) });
    const plan = query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }] });
    const token = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof token).toBe("string");

    key = "reader-b";
    fetch.mockResolvedValueOnce(response(searchHits(2, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "changed-query" });

    key = "reader-a";
    fetch.mockResolvedValueOnce(response(searchHits(2, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).resolves.toBeDefined();
  });

  it("refuses an unusable next position instead of returning a dead handle", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(5, [
      { id: "001" },
      { id: "002" },
    ])));
    const db = database(fetch, { maxQueryLimit: 2, maxQueryOffset: 3, maxQueryPages: 5, maxRowsPerPage: 2 });
    await expect(db.query(query({ limit: 2 }))).rejects.toBeInstanceOf(TypesenseContinuationBoundError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the handle retryable after a planning failure that happens after its lookup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(searchHits(4, [
        { id: "004", genre: "cyberpunk" },
        { id: "006", genre: "cyberpunk" },
      ])))
      .mockResolvedValueOnce(response(searchHits(4, [
        { id: "004", genre: "cyberpunk" },
        { id: "006", genre: "cyberpunk" },
      ])))
      .mockResolvedValueOnce(response(searchHits(4, [
        { id: "009", genre: "cyberpunk" },
        { id: "010", genre: "cyberpunk" },
      ])));
    const db = database(fetch, { identityScope: "reader-1", maxRowsPerPage: 2 });
    const plan = query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }], limit: 2 });
    const token = (await db.query(plan)).nextCursor?.values[0];
    expect(typeof token).toBe("string");

    // The token is found, then a later planning dimension (the page limit)
    // fails. That failure must not strand the lease or consume the handle.
    await expect(db.query({ ...plan, limit: 3, startAfter: { values: [token] } }))
      .rejects.toMatchObject({ reason: "changed-query" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(retried.records.map((record) => record.key.id)).toEqual(["009", "010"]);
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
  });
});

describe("Typesense physical page bounds", () => {
  it("pages an unfiltered request through maxRowsPerPage without dropping or duplicating rows", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(searchHits(5, [{ id: "a" }, { id: "b" }])))
      .mockResolvedValueOnce(response(searchHits(5, [{ id: "c" }, { id: "d" }])))
      .mockResolvedValueOnce(response(searchHits(5, [{ id: "e" }])));
    const db = database(fetch, { maxRowsPerPage: 2, maxQueryLimit: 10 });
    const page = await db.query(query({ limit: 5 }));
    expect(page.records.map((record) => record.key.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(page.nextCursor).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(url(fetch, 0).searchParams.get("limit")).toBe("2");
    expect(url(fetch, 0).searchParams.get("offset")).toBeNull();
    expect(url(fetch, 1).searchParams.get("limit")).toBe("2");
    expect(url(fetch, 1).searchParams.get("offset")).toBe("2");
    expect(url(fetch, 2).searchParams.get("limit")).toBe("1");
    expect(url(fetch, 2).searchParams.get("offset")).toBe("4");
  });

  it("refuses an unfiltered page that needs more requests than maxQueryPages before I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch, { maxRowsPerPage: 2, maxQueryPages: 1, maxQueryLimit: 10 });
    await expect(db.query(query({ limit: 5 }))).rejects.toThrow("maxQueryPages");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Typesense verification cadence", () => {
  it("yields a real macrotask so a caller timer can abort a bounded verification", async () => {
    const documents = Array.from({ length: 100 }, (_, index) => ({ id: `d${String(index)}`, genre: "cyberpunk" }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(100, documents)));
    const db = database(fetch, { maxRowsPerPage: 100, maxQueryLimit: 100 });
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 0);
    await expect(db.queryWithSignal(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      limit: 100,
    }), controller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  });
});

describe("Typesense structured refusals", () => {
  it.each([
    ["!=", [{ field: "genre", operator: "!=", value: "cyberpunk" }]],
    ["not-in", [{ field: "genre", operator: "not-in", value: ["cyberpunk"] }]],
    ["array-contains", [{ field: "tags", operator: "array-contains", value: ["classic"] }]],
    ["array-contains-any", [{ field: "tags", operator: "array-contains-any", value: ["classic"] }]],
  ] as const)("refuses %s before I/O", async (_label, filters) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch);
    await expect(db.query(query({ filters: [...filters] }))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses null tests, joined fields, nested groups and unsafe literals before I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch);
    await expect(db.query(query({
      where: { kind: "is-null", operand: { kind: "field", field: { field: "note", source: "" } } },
    }))).rejects.toThrow("null tests");
    await expect(db.query(query({
      where: {
        kind: "and",
        conditions: [{
          left: { kind: "field", field: { field: "title", source: "other" } },
          operator: "==",
          right: { kind: "literal", value: "x" },
        }],
      },
    }))).rejects.toThrow("unqualified");
    await expect(db.query(query({
      filters: [{ field: "title", operator: "==", value: "back`tick" }],
    }))).rejects.toThrow("control-free");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the same per-request header callback for schema and search, and refuses a pure search key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({
        name: "books",
        fields: [{ name: "year", type: "int32", facet: true }],
      }))
      .mockResolvedValueOnce(response(searchHits(1, [{ id: "001", year: 1966 }])));
    const db = database(fetch, { headers: () => ({ "X-TYPESENSE-API-KEY": "scoped-key" }) });
    const page = await db.query<{ year: number }>(query({
      filters: [{ field: "year", operator: ">", value: 1965 }],
      projection: ["year"],
      limit: 1,
    }));
    expect(page.records[0]?.data).toEqual({ year: 1966 });
    expect(url(fetch, 0).pathname).toBe("/collections/books");
    expect(header(fetch, 0, "x-typesense-api-key")).toBe("scoped-key");
    expect(url(fetch, 1).searchParams.get("filter_by")).toBe("year:>=1965");
    expect(header(fetch, 1, "x-typesense-api-key")).toBe("scoped-key");

    const denied = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ message: "secret" }, 401));
    await expect(database(denied, { headers: () => ({ "X-TYPESENSE-API-KEY": "pure-search" }) }).query(query({
      filters: [{ field: "year", operator: ">", value: 1965 }],
    }))).rejects.toThrow("require readable collection schema");
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("refuses a string range before the search request even when schema is readable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({
      name: "books",
      fields: [{ name: "title", type: "string" }],
    }));
    const db = database(fetch);
    await expect(db.query(query({ filters: [{ field: "title", operator: ">", value: "M" }] }))).rejects.toThrow("numeric");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe numbers and unsafe native IDs in responses", async () => {
    const unsafe = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(
      '{"found":1,"out_of":1,"hits":[{"document":{"id":"x","big":9007199254740993}}]}',
      { status: 200 },
    ));
    await expect(database(unsafe).get(new Key("books", "x"))).rejects.toBeInstanceOf(TypesenseJsonNumberError);

    const badID = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(1, [{ id: 1 }])));
    await expect(database(badID).get(new Key("books", "1"))).rejects.toThrow("document id");
  });
});

describe("Typesense native score representation", () => {
  it("returns a safe text_match as an exact decimal string", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(1, [{ id: "004", title: "x" }])));
    const result = await database(fetch).search({ q: "x", queryBy: ["title"], limit: 1 });
    expect(result.hits[0]?.textMatch).toBe("1");
    expect(typeof result.hits[0]?.textMatch).toBe("string");
  });

  it("accepts an unsafe uint64 text_match only at its exact protocol path as a decimal string", async () => {
    const body = '{"found":1,"out_of":1,"hits":[{"document":{"id":"004","title":"x"},"text_match":578730123365187584,"text_match_info":{"score":"578730123365187584"}}]}';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(rawResponse(body));
    const result = await database(fetch).search({ q: "x", queryBy: ["title"], limit: 1 });
    expect(result.hits[0]?.textMatch).toBe("578730123365187584");
    expect(typeof result.hits[0]?.textMatch).toBe("string");
  });

  it("refuses an unsafe score disagreement, an unsafe application field and duplicate keys", async () => {
    const disagree = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(rawResponse(
      '{"found":1,"out_of":1,"hits":[{"document":{"id":"x"},"text_match":578730123365187584,"text_match_info":{"score":"1"}}]}',
    ));
    await expect(database(disagree).search({ q: "x", queryBy: ["title"], limit: 1 })).rejects.toThrow("disagree");

    const documentScore = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(rawResponse(
      '{"found":1,"out_of":1,"hits":[{"document":{"id":"x","text_match":578730123365187584}}]}',
    ));
    await expect(database(documentScore).search({ q: "x", queryBy: ["title"], limit: 1 })).rejects.toBeInstanceOf(TypesenseJsonNumberError);

    const duplicate = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(rawResponse(
      '{"found":1,"out_of":1,"found":1,"hits":[]}',
    ));
    await expect(database(duplicate).search({ q: "x", queryBy: ["title"], limit: 1 })).rejects.toThrow("malformed JSON");
  });
});

describe("Typesense header redaction", () => {
  it.each([
    ["a throwing provider", (): never => { throw new RangeError("secret-sentinel-value"); }],
    ["a throwing enumerable getter", (): Record<string, string> => {
      const headers: Record<string, string> = {};
      Object.defineProperty(headers, "X-TYPESENSE-API-KEY", {
        enumerable: true,
        get() { throw new RangeError("secret-sentinel-value"); },
      });
      return headers;
    }],
    ["invalid headers", (): Record<string, string> => ({ "X-Other": "secret-sentinel-value" })],
    ["a non-object", (): null => null],
  ] as const)("redacts %s into one fixed public error", async (_label, headers) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch, { headers: headers as unknown as NonNullable<TypesenseDatabaseOptions["headers"]> });
    const error = await db.get(new Key("books", "x")).then(() => undefined, (value: unknown) => value);
    expect(error).toBeInstanceOf(TypesenseRequestError);
    expect((error as Error).name).toBe("TypesenseRequestError");
    expect((error as Error).message).toBe("Typesense request could not be completed");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify({ message: (error as Error).message })).not.toContain("secret-sentinel-value");
    expect(String(error)).not.toContain("secret-sentinel-value");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives canonical cancellation precedence over header failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = database(fetch, {
      headers: () => new Promise(() => { /* never settles */ }),
    });
    const controller = new AbortController();
    const pending = db.getManyWithSignal([new Key("books", "x")], controller.signal);
    setTimeout(() => { controller.abort(); }, 0);
    await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Typesense listener ownership", () => {
  it("removes every registered abort listener on success, error, cancel and close", async () => {
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    let added = 0;
    let removed = 0;
    EventTarget.prototype.addEventListener = function patchedAdd(this: EventTarget, ...args: Parameters<EventTarget["addEventListener"]>) {
      if (this instanceof AbortSignal) added += 1;
      return originalAdd.call(this, ...args);
    } as EventTarget["addEventListener"];
    EventTarget.prototype.removeEventListener = function patchedRemove(this: EventTarget, ...args: Parameters<EventTarget["removeEventListener"]>) {
      if (this instanceof AbortSignal) removed += 1;
      return originalRemove.call(this, ...args);
    } as EventTarget["removeEventListener"];
    try {
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockImplementation(() => Promise.resolve(response(searchHits(1, [{ id: "x" }]))));
      const db = database(fetch);
      for (let index = 0; index < 3; index += 1) await db.get(new Key("books", "x"));
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(db.queryWithSignal(query(), cancelled.signal)).rejects.toMatchObject({ name: "QueryCancelledError" });
      const failing = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("transport"));
      await expect(database(failing).get(new Key("books", "x"))).rejects.toBeInstanceOf(TypesenseRequestError);
      db.close();
      expect(removed).toBe(added);
    } finally {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
    }
  });

  it("still aborts an owned in-flight operation on close", async () => {
    let reject: ((error: unknown) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise<Response>((_resolve, failure) => {
      reject = failure;
    }));
    const db = database(fetch);
    const pending = db.get(new Key("books", "x"));
    db.close();
    reject?.(new DOMException("aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  });
});

describe("Typesense native search and metadata", () => {
  it("keeps native typo/negative semantics, forces curation safety and returns honest facets", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(2, [
      { id: "004", title: "Neuromancer", year: 1984 },
    ], {
      facet_counts: [{
        field_name: "year",
        counts: [{ value: "1984", count: 1 }],
        stats: { min: 1984, max: 1984, sum: 1984, avg: 1984, total_values: 1 },
      }],
      search_cutoff: true,
    })));
    const db = database(fetch);
    const result = await db.search({
      q: "Neuromancr",
      queryBy: ["title"],
      filterBy: "year:!=1950 && genre:=`cyberpunk`",
      facetBy: ["year"],
      maxFacetValues: 5,
      limit: 5,
    });
    expect(result).toMatchObject({
      found: 2,
      returned: 1,
      partial: true,
      complete: false,
      truncated: true,
      provenance: "typesense-native-search",
    });
    expect(result.hits[0]?.document).toMatchObject({ id: "004", year: 1984 });
    expect(result.facets[0]).toEqual({
      field: "year",
      counts: [{ value: "1984", count: 1 }],
      stats: { min: 1984, max: 1984, sum: 1984, avg: 1984, totalValues: 1 },
    });
    const params = url(fetch).searchParams;
    expect(params.get("q")).toBe("Neuromancr");
    expect(params.get("filter_by")).toBe("year:!=1950 && genre:=`cyberpunk`");
    expect(params.get("enable_curations")).toBe("false");
    expect(params.get("filter_curated_hits")).toBe("true");
    expect(params.has("num_typos")).toBe(false);
    expect(params.has("prefix")).toBe(false);
  });

  it("rejects malformed or unrequested facets instead of exposing them", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(0, [], {
      facet_counts: [{ field_name: "year", counts: [] }],
    })));
    await expect(database(fetch).search({ q: "*", limit: 5 })).rejects.toThrow("not requested");
  });

  it("reports a pure search-key metadata denial explicitly and normalises the real schema id", async () => {
    const denial = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ message: "secret denial body" }, 401));
    const denied = database(denial);
    await expect(denied.testConnection()).resolves.toEqual({
      ok: false,
      collection: "books",
      status: "unauthorized",
      httpStatus: 401,
    });
    const deniedAgain = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ message: "secret denial body" }, 401));
    await expect(database(deniedAgain).schema()).resolves.toEqual({ status: "unavailable", reason: "unauthorized", httpStatus: 401 });

    const available = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({
      name: "books",
      fields: [
        { name: "title", type: "string" },
        { name: "tags", type: "string[]", optional: true },
        { name: "id", type: "string", optional: true },
      ],
      num_documents: 12,
    }));
    const discovery = await database(available).schema();
    expect(discovery).toEqual({
      status: "available",
      schema: {
        name: "books",
        fields: [
          { name: "title", type: "string", facet: false, optional: false, index: true, sort: false, infix: false },
          { name: "tags", type: "string[]", facet: false, optional: true, index: true, sort: false, infix: false },
          { name: "id", type: "string", facet: false, optional: false, index: true, sort: false, infix: false },
        ],
        numDocuments: 12,
      },
    });
    if (discovery.status !== "available") throw new Error("expected schema");
    expect(discovery.schema.fields.filter((field) => field.name === "id")).toHaveLength(1);
  });

  it("accepts the official empty default_sorting_field sentinel and refuses malformed values", async () => {
    const empty = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({
      name: "books",
      fields: [{ name: "title", type: "string" }],
      default_sorting_field: "",
    }));
    await expect(database(empty).schema()).resolves.toMatchObject({
      status: "available",
      schema: { name: "books", defaultSortingField: "" },
    });

    const malformed = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({
      name: "books",
      fields: [{ name: "title", type: "string" }],
      default_sorting_field: 42,
    }));
    await expect(database(malformed).schema()).resolves.toEqual({ status: "unavailable", reason: "malformed" });
  });

  it("exposes truthful configured capabilities and refuses transactions before the callback", async () => {
    const db = database(vi.fn<typeof globalThis.fetch>(), { maxQueryLimit: 7, maxRowsPerPage: 3 });
    expect(db.capabilities.bounds.maxQueryLimit).toEqual({ default: 7, maximum: 10_000 });
    expect(db.capabilities.bounds.maxRowsPerPage).toEqual({ default: 3, maximum: 250 });
    expect(TYPESENSE_READ_CAPABILITIES.bounds.filterOperators).toEqual(["==", "<", "<=", ">", ">=", "in"]);
    const callback = vi.fn(async () => "ran");
    await expect(db.runReadwriteTransaction(callback)).rejects.toBeInstanceOf(UnsupportedError);
    expect(callback).not.toHaveBeenCalled();
  });
});

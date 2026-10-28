import { describe, expect, it, vi } from "vitest";
import { Key, UnsupportedError } from "@dalgo/core";

import {
  TYPESENSE_READ_CAPABILITIES,
  TypesenseDatabase,
  TypesenseJsonNumberError,
  TypesenseSemanticError,
  type TypesenseDatabaseOptions,
  type TypesenseQuery,
} from "../src/index.js";

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function options(overrides: Partial<TypesenseDatabaseOptions> = {}): TypesenseDatabaseOptions {
  return {
    baseUrl: "https://typesense.example.test:8108",
    collection: "books",
    headers: () => ({ "X-TYPESENSE-API-KEY": "search-key" }),
    timeoutMs: 2_000,
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
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(1, [{
      id: "004",
      title: "Neuromancer",
      genre: "cyberpunk",
      note: null,
    }])));
    const db = database(fetch);
    const page = await db.query(query<{ title: string; note: string | null }>({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      projection: ["title", "note"],
      limit: 1,
    }));

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.key).toEqual(new Key("books", "004"));
    expect(page.records[0]?.data).toEqual({ title: "Neuromancer", note: null });
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

  it("keeps a canceled cursor retryable and rejects a changed query", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(searchHits(3, [
      { id: "004", genre: "cyberpunk" },
      { id: "006", genre: "cyberpunk" },
    ])));
    const db = database(fetch, { identityScope: "reader-1" });
    const plan = query({ filters: [{ field: "genre", operator: "==", value: "cyberpunk" }] });
    const first = await db.query(plan);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");

    await expect(db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      limit: 3,
      startAfter: { values: [token] },
    }))).rejects.toMatchObject({ reason: "changed-query" });

    const controller = new AbortController();
    fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new DOMException("aborted", "AbortError"));
      }, 5);
    }));
    const pending = db.queryWithSignal(plan, controller.signal);
    await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });

    fetch
      .mockResolvedValueOnce(response(searchHits(3, [
        { id: "004", genre: "cyberpunk" },
        { id: "006", genre: "cyberpunk" },
        { id: "009", genre: "cyberpunk" },
      ])));
    await expect(db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      startAfter: { values: [token] },
    }))).resolves.toBeDefined();

    await expect(db.query(query({
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      startAfter: { values: [token] },
    }))).rejects.toMatchObject({ reason: "used" });
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

  it("requires readable schema for numeric ranges and uses an inclusive native superset with the original verifier", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({
        name: "books",
        fields: [{ name: "year", type: "int32", facet: true }],
      }))
      .mockResolvedValueOnce(response(searchHits(1, [{ id: "001", year: 1966 }])));
    const db = database(fetch, { metadataHeaders: () => ({ "X-TYPESENSE-API-KEY": "metadata-key" }) });
    const page = await db.query<{ year: number }>(query({
      filters: [{ field: "year", operator: ">", value: 1965 }],
      projection: ["year"],
      limit: 1,
    }));
    expect(page.records[0]?.data).toEqual({ year: 1966 });
    expect(url(fetch, 0).pathname).toBe("/collections/books");
    expect(header(fetch, 0, "x-typesense-api-key")).toBe("metadata-key");
    expect(url(fetch, 1).searchParams.get("filter_by")).toBe("year:>=1965");
    expect(header(fetch, 1, "x-typesense-api-key")).toBe("search-key");
  });

  it("refuses a string range before the search request even when schema is readable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({
      name: "books",
      fields: [{ name: "title", type: "string" }],
    }));
    const db = database(fetch, { metadataHeaders: () => ({ "X-TYPESENSE-API-KEY": "metadata-key" }) });
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

import { Key, UnsupportedError } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import {
  TypesenseDatabase,
  TypesenseJsonNumberError,
  TypesenseSemanticError,
  type TypesenseDatabaseOptions,
  type TypesenseNativeSearchResult,
  type TypesenseQuery,
} from "../src/index.js";

const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const endpoint = environment.TYPESENSE_TEST_URL;
const searchKey = environment.TYPESENSE_TEST_SEARCH_KEY;
const metadataKey = environment.TYPESENSE_TEST_METADATA_KEY;
const RAW_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Every raw/setup request in this suite carries its own finite deadline. The
 * signal stays attached to the fetch while the response body is read, so a
 * provider that stops writing a body cannot hang the suite behind an outer loop.
 */
function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(RAW_REQUEST_TIMEOUT_MS) });
}

function configured(): { url: string; search: string; metadata: string } {
  if (endpoint === undefined || searchKey === undefined || metadataKey === undefined) {
    throw new Error("real Typesense test environment is not configured");
  }
  return { url: endpoint, search: searchKey, metadata: metadataKey };
}

/**
 * The approved contract has exactly one per-physical-request header callback.
 * A pure `documents:search` credential and a scoped `collections:get`/`list`
 * credential are therefore two separate adapter instances that share the same
 * option shape and never a fallback or admin path.
 */
function database(collection: string, key: string, overrides: Partial<TypesenseDatabaseOptions> = {}): TypesenseDatabase {
  const env = configured();
  return new TypesenseDatabase({
    baseUrl: env.url,
    allowInsecureLoopbackHttp: true,
    collection,
    headers: () => ({ "X-TYPESENSE-API-KEY": key }),
    timeoutMs: 15_000,
    maxQueryLimit: 20,
    maxRowsPerPage: 20,
    maxGetManyKeys: 20,
    ...overrides,
  });
}

function query<T>(collection: string, overrides: Partial<TypesenseQuery<T>> = {}): TypesenseQuery<T> {
  return { source: { kind: "collection", name: collection }, filters: [], orders: [], limit: 10, ...overrides };
}

function ids(page: { records: readonly { key: Key }[] }): string[] {
  return page.records.map((record) => String(record.key.id));
}

function hitIDs(result: TypesenseNativeSearchResult): string[] {
  return result.hits.map((hit) => hit.id);
}

async function rawSearch(collection: string, parameters: Record<string, string>): Promise<{ hits: { document: { id: string } }[] }> {
  const response = await rawFetch(`${configured().url}/collections/${collection}/documents/search?${new URLSearchParams(parameters).toString()}`, {
    redirect: "error",
    headers: { "X-TYPESENSE-API-KEY": configured().search },
  });
  if (!response.ok) throw new Error(`raw Typesense search failed with HTTP ${String(response.status)}`);
  return await response.json() as { hits: { document: { id: string } }[] };
}

async function rawSearchText(collection: string, parameters: Record<string, string>): Promise<string> {
  const response = await rawFetch(`${configured().url}/collections/${collection}/documents/search?${new URLSearchParams(parameters).toString()}`, {
    redirect: "error",
    headers: { "X-TYPESENSE-API-KEY": configured().search },
  });
  if (!response.ok) throw new Error(`raw Typesense search failed with HTTP ${String(response.status)}`);
  return await response.text();
}

describe.skipIf(endpoint === undefined || searchKey === undefined || metadataKey === undefined)("real pinned Typesense 30.2", () => {
  it("reads native documents with a pure search key, preserves string ids and refuses metadata", async () => {
    const db = database("books", configured().search);
    const records = await db.getMany([new Key("books", "001"), new Key("books", "1"), new Key("books", "missing")]);
    expect(records.map((record) => record.exists ? record.key.id : `missing:${record.key.id}`)).toEqual(["001", "1", "missing:missing"]);
    expect(records[0]?.exists && records[0].data).toMatchObject({ id: "001", title: "Dune", year: 1965, tags: ["classic", "desert"] });
    expect(records[1]?.exists && records[1].data).toMatchObject({ id: "1", title: "Numeric One" });

    await expect(db.schema()).resolves.toMatchObject({ status: "unavailable", reason: "unauthorized" });
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized" });

    const writeProbe = await rawFetch(`${configured().url}/collections/books/documents`, {
      method: "POST",
      redirect: "error",
      headers: { "X-TYPESENSE-API-KEY": configured().search, "content-type": "application/json" },
      body: JSON.stringify({ id: "forbidden", title: "write probe" }),
    });
    expect([401, 403]).toContain(writeProbe.status);
  });

  it("never requests metadata for a pure search key query without ranges", async () => {
    const paths: string[] = [];
    const db = database("books", configured().search, {
      fetch: (input, init) => {
        paths.push(new URL(String(input)).pathname);
        return globalThis.fetch(input, init);
      },
    });
    const page = await db.query(query("books", {
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      orders: [{ field: "seq", direction: "asc" }],
    }));
    expect(ids(page)).toEqual(["004", "006"]);
    expect(paths).toEqual(["/collections/books/documents/search"]);
  });

  it("reads the real collection schema, keeps native array types and reports id exactly once", async () => {
    const db = database("books", configured().metadata);
    const discovery = await db.schema();
    expect(discovery.status).toBe("available");
    if (discovery.status !== "available") return;
    const { schema } = discovery;
    expect(schema.name).toBe("books");
    expect(schema.defaultSortingField).toBe("rank");
    expect(schema.numDocuments).toBe(13);
    expect(schema.fields.filter((field) => field.name === "id")).toEqual([
      { name: "id", type: "string", facet: false, optional: false, index: true, sort: false, infix: false },
    ]);
    expect(schema.fields.find((field) => field.name === "tags")).toMatchObject({ type: "string[]", facet: true });
    await expect(db.testConnection()).resolves.toMatchObject({ ok: true, status: "connected" });
    const collections = await db.listCollections();
    expect(collections).toEqual({
      status: "available",
      collections: ["books", "bulk", "nodesort", "semantics", "unsafe"],
      truncated: false,
    });
  });

  it("accepts the official empty default_sorting_field from a real collection created without one", async () => {
    const db = database("nodesort", configured().metadata);
    const discovery = await db.schema();
    expect(discovery.status).toBe("available");
    if (discovery.status !== "available") return;
    expect(discovery.schema.name).toBe("nodesort");
    // Typesense 30.2 always includes the summary field and uses "" when the
    // collection was created without a default sorting field.
    expect(discovery.schema.defaultSortingField).toBe("");
    await expect(db.testConnection()).resolves.toMatchObject({ ok: true, status: "connected" });
    const page = await db.query(query("nodesort", {
      filters: [{ field: "label", operator: "==", value: "a" }],
      projection: ["label"],
    }));
    expect(ids(page)).toEqual(["n1"]);
  });

  it("forces curation safety before and after a real native filter", async () => {
    const vulnerable = await rawSearch("books", {
      q: "*",
      filter_by: "genre:=cyberpunk",
      limit: "10",
      enable_curations: "true",
      filter_curated_hits: "true",
    });
    // The premise is non-vacuous only when the curated document is excluded by
    // filter_curated_hits; a default query would promote 001 despite the filter.
    const defaultCuration = await rawSearch("books", { q: "*", filter_by: "genre:=cyberpunk", limit: "10" });
    expect(defaultCuration.hits.map((hit) => hit.document.id)).toContain("001");
    expect(vulnerable.hits.map((hit) => hit.document.id).sort()).toEqual(["004", "006"]);

    const db = database("books", configured().search);
    const result = await db.search({ q: "*", filterBy: "genre:=cyberpunk", limit: 10 });
    expect(hitIDs(result).sort()).toEqual(["004", "006"]);
    expect(result.complete).toBe(true);

    const structured = await db.query(query("books", {
      filters: [{ field: "genre", operator: "==", value: "cyberpunk" }],
      orders: [{ field: "seq", direction: "asc" }],
    }));
    expect(ids(structured)).toEqual(["004", "006"]);
  });

  it("keeps native typo, prefix and drop-token semantics while facets remain the server's values", async () => {
    const db = database("books", configured().search);
    const neu = await db.search({
      q: "Neuromancer",
      queryBy: ["title", "author"],
      filterBy: "genre:=cyberpunk",
      sortBy: [{ field: "seq", direction: "desc" }],
      facetBy: ["year"],
      maxFacetValues: 10,
      limit: 5,
    });
    expect(neu).toMatchObject({ found: 1, returned: 1, partial: false, complete: true, truncated: false, provenance: "typesense-native-search" });
    expect(neu.hits[0]?.document).toMatchObject({ id: "004", title: "Neuromancer", author: "William Gibson", year: 1984 });
    expect(neu.facets[0]?.field).toBe("year");
    expect(neu.facets[0]?.counts.map(({ value, count }) => ({ value, count }))).toEqual([{ value: "1984", count: 1 }]);
    expect(neu.facets[0]?.counts[0]?.highlighted).toBe("1984");
    expect(neu.facets[0]?.stats).toMatchObject({ min: 1984, max: 1984, sum: 1984 });

    for (const q of ["Neuromanc", "Neuromancr"]) {
      const result = await db.search({ q, queryBy: ["title"], limit: 5 });
      expect(hitIDs(result)).toEqual(["004"]);
    }
    const dropped = await db.search({ q: "Dune Herbert", queryBy: ["title"], limit: 5 });
    expect(hitIDs(dropped).sort()).toEqual(["001", "002", "003"]);

    const author = await db.search({
      q: "Frank Herbert",
      queryBy: ["author"],
      sortBy: [{ field: "seq", direction: "asc" }],
      facetBy: ["genre", "year"],
      maxFacetValues: 10,
      limit: 5,
    });
    expect(hitIDs(author)).toEqual(["001", "002", "003"]);
    expect(author.facets.find((facet) => facet.field === "genre")?.counts.map(({ value, count }) => ({ value, count })))
      .toEqual([{ value: "science fiction", count: 3 }]);
    expect(author.facets.find((facet) => facet.field === "year")?.counts).toHaveLength(3);
  });

  it("returns the ordinary native full-text score as its exact decimal string", async () => {
    const raw = await rawSearchText("books", {
      q: "Neuromancer",
      query_by: "title,author",
      filter_by: "genre:=cyberpunk",
      limit: "1",
      enable_curations: "false",
      filter_curated_hits: "true",
    });
    const match = /"text_match"\s*:\s*(\d+)/u.exec(raw);
    expect(match).not.toBeNull();
    const exact = match?.[1];
    expect(typeof exact).toBe("string");
    expect(exact).toMatch(/^(?:0|[1-9]\d*)$/u);
    const info = /"score"\s*:\s*"(\d+)"/u.exec(raw);
    expect(info?.[1]).toBe(exact);

    const db = database("books", configured().search);
    const result = await db.search({
      q: "Neuromancer",
      queryBy: ["title", "author"],
      filterBy: "genre:=cyberpunk",
      limit: 1,
    });
    expect(hitIDs(result)).toEqual(["004"]);
    expect(result.hits[0]?.textMatch).toBe(exact);
    expect(typeof result.hits[0]?.textMatch).toBe("string");
  });

  it("verifies exact structured predicates, projections and a filtered offset", async () => {
    const db = database("books", configured().search);
    const projected = await db.query<{ title: string; note?: string | null }>(query("books", {
      filters: [{ field: "id", operator: "in", value: ["001", "003", "005"] }],
      projection: ["title", "note"],
      orders: [{ field: "seq", direction: "asc" }],
    }));
    expect(ids(projected)).toEqual(["001", "003", "005"]);
    expect(projected.records[0]?.data).toEqual({ title: "Dune" });
    expect(projected.records[0]?.data).not.toHaveProperty("note");
    expect(projected.records[1]?.data).toEqual({ title: "Children of Dune", note: "a b (c) && d" });
    // Typesense 30.2 stores an imported explicit-null optional field as absent
    // on the wire. The adapter preserves that absence exactly; the explicit
    // null preservation itself is covered by the focused unit regression.
    expect(projected.records[2]?.data).toEqual({ title: "Foundation" });
    expect(projected.records[2]?.data).not.toHaveProperty("note");
    expect(projected.records[0]?.data).not.toHaveProperty("note");
    expect(projected.records[0]?.data).not.toHaveProperty("id");

    const offset = await db.query(query("books", {
      filters: [{ field: "genre", operator: "==", value: "science fiction" }],
      orders: [{ field: "seq", direction: "asc" }],
      offset: 1,
      limit: 2,
    }));
    expect(ids(offset)).toEqual(["002", "003"]);
  });

  it("pages a filtered query by re-verifying the whole prefix and committing single-use cursors", async () => {
    const db = database("books", configured().search, { maxRowsPerPage: 2 });
    const plan = query("books", {
      filters: [{ field: "genre", operator: "==", value: "science fiction" }],
      orders: [{ field: "seq", direction: "asc" }],
      limit: 2,
    });
    const first = await db.query(plan);
    expect(ids(first)).toEqual(["001", "002"]);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");
    const second = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(ids(second)).toEqual(["003", "005"]);
    await expect(db.query({ ...plan, startAfter: { values: [token] } })).rejects.toMatchObject({ reason: "used" });
  });

  it("pages an unfiltered query within the configured physical page bound", async () => {
    const db = database("bulk", configured().search, { maxRowsPerPage: 2, maxQueryLimit: 20, maxQueryOffset: 20_000 });
    const plan = query("bulk", { orders: [{ field: "rank", direction: "asc" }], limit: 5 });
    const page = await db.query(plan);
    expect(page.records.map((record) => record.key.id)).toEqual(["b0000", "b0001", "b0002", "b0003", "b0004"]);
    const token = page.nextCursor?.values[0];
    expect(typeof token).toBe("string");
    const next = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(next.records.map((record) => record.key.id)).toEqual(["b0005", "b0006", "b0007", "b0008", "b0009"]);
  });

  it("proves the numeric inclusive-candidate superset and refuses a real boundary or array candidate", async () => {
    const db = database("semantics", configured().metadata);
    const inclusive = await db.query<{ m: number }>(query("semantics", {
      filters: [{ field: "m", operator: ">=", value: 12 }],
      orders: [{ field: "m", direction: "asc" }],
      projection: ["m"],
      limit: 10,
    }));
    expect(ids(inclusive)).toEqual(["f5", "f6", "f7", "f8", "f9", "f10"]);
    expect(inclusive.records.map((record) => record.data.m)).toEqual([12, 13, 14, 15, 16, 17]);

    await expect(db.query(query("semantics", {
      filters: [{ field: "m", operator: ">", value: 9 }],
    }))).rejects.toBeInstanceOf(TypesenseSemanticError);

    await expect(db.query(query("semantics", {
      filters: [{ field: "tags", operator: "in", value: ["classic"] }],
    }))).rejects.toBeInstanceOf(TypesenseSemanticError);

    const stringRange = await db.query(query("semantics", {
      filters: [{ field: "label", operator: ">", value: "b" }],
    })).then(() => "accepted", (error: unknown) => error);
    expect(stringRange).toBeInstanceOf(UnsupportedError);
  });

  it("supports a bounded AND/OR where tree and flat filters together", async () => {
    const db = database("semantics", configured().metadata);
    const page = await db.query(query("semantics", {
      filters: [{ field: "m", operator: ">=", value: 4 }],
      where: {
        kind: "or",
        conditions: [
          {
            left: { kind: "field", field: { field: "id", source: "" } },
            operator: "==",
            right: { kind: "literal", value: "f0" },
          },
          {
            left: { kind: "field", field: { field: "id", source: "" } },
            operator: "==",
            right: { kind: "literal", value: "f6" },
          },
        ],
      },
      orders: [{ field: "m", direction: "asc" }],
      limit: 10,
    }));
    expect(ids(page)).toEqual(["f0", "f6"]);
  });

  it("refuses unsafe JSON before exposing a document", async () => {
    const db = database("unsafe", configured().search);
    await expect(db.get(new Key("unsafe", "u1"))).rejects.toBeInstanceOf(TypesenseJsonNumberError);
  });

  it("enforces row, page and facet budgets without returning a successful prefix", async () => {
    await expect(database("books", configured().search, { maxRowBytes: 32 }).get(new Key("books", "004")))
      .rejects.toBeInstanceOf(RangeError);

    const pages = database("books", configured().search, { maxQueryPages: 1, maxRowsPerPage: 1 });
    await expect(pages.query(query("books", {
      filters: [{ field: "genre", operator: "==", value: "science fiction" }],
      limit: 2,
    }))).rejects.toThrow("maxQueryPages");

    const facets = database("books", configured().search, { maxFacetValues: 2 });
    await expect(facets.search({ q: "*", facetBy: ["year"], maxFacetValues: 3, limit: 1 }))
      .rejects.toThrow("maxFacetValues");
  });

  it("cancels a real acknowledged continuation response and retries the same handle", async () => {
    let currentFetch = globalThis.fetch.bind(globalThis);
    const db = database("books", configured().search, {
      identityScope: "real-reader",
      maxRowsPerPage: 2,
      fetch: (input, init) => currentFetch(input, init),
    });
    const plan = query("books", {
      filters: [{ field: "genre", operator: "==", value: "science fiction" }],
      orders: [{ field: "seq", direction: "asc" }],
      limit: 2,
    });
    const first = await db.query(plan);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");

    const controller = new AbortController();
    const acknowledgement = { status: 0, contentType: "" };
    currentFetch = async (input, init) => {
      // Issue the genuine continuation to the pinned server and await the
      // provider's real response before canceling. The response is returned
      // untouched: this is request acknowledgement, not body receipt and not a
      // completed buffered verification.
      const response = await globalThis.fetch(input, init);
      acknowledgement.status = response.status;
      acknowledgement.contentType = response.headers.get("content-type") ?? "";
      controller.abort();
      return response;
    };
    await expect(db.queryWithSignal({ ...plan, startAfter: { values: [token] } }, controller.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(acknowledgement.status).toBe(200);
    expect(acknowledgement.contentType).toContain("application/json");

    currentFetch = globalThis.fetch.bind(globalThis);
    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(ids(retried)).toEqual(["003", "005"]);
  });

  it("refuses an already-aborted continuation before any request and keeps the handle usable", async () => {
    let requests = 0;
    const db = database("books", configured().search, {
      identityScope: "pre-io-reader",
      maxRowsPerPage: 2,
      fetch: (input, init) => {
        requests += 1;
        return globalThis.fetch(input, init);
      },
    });
    const plan = query("books", {
      filters: [{ field: "genre", operator: "==", value: "science fiction" }],
      orders: [{ field: "seq", direction: "asc" }],
      limit: 2,
    });
    const first = await db.query(plan);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");
    expect(requests).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(db.queryWithSignal({ ...plan, startAfter: { values: [token] } }, controller.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(requests).toBe(1);

    const retried = await db.query({ ...plan, startAfter: { values: [token] } });
    expect(ids(retried)).toEqual(["003", "005"]);
  });
});

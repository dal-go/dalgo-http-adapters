import { UnsupportedError, collection, type StructuredQuery } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { PostgrestDatabase } from "../src/index.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

function database(maxQueryLimit = 1) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    fetch,
    database: new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      maxQueryLimit,
    }),
  };
}

type QueryMethod = "query" | "queryWithSignal";

const methods: readonly QueryMethod[] = ["query", "queryWithSignal"];

function run<T>(method: QueryMethod, db: PostgrestDatabase, query: StructuredQuery<T>) {
  return method === "query" ? db.query(query) : db.queryWithSignal(query, new AbortController().signal);
}

describe("PostgrestDatabase query cardinality", () => {
  it.each(methods)("%s rejects a page above the requested limit before decoding", async (method) => {
    const { database: db, fetch } = database(1);
    const decode = vi.fn((value: unknown) => value as { done: boolean });
    const items = collection<{ done: boolean }>("items", {
      codec: { encode: (value) => ({ ...value }), decode },
    });
    fetch.mockResolvedValueOnce(response(200, [
      { id: "milk", done: false },
      { id: "eggs", done: true },
    ]));

    await expect(run(method, db, items.query().limit(1).build()))
      .rejects.toThrow("PostgREST response returned more rows than the requested query limit");
    expect(decode).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("%s accepts a page that exactly matches the requested limit", async (method) => {
    const { database: db, fetch } = database(2);
    const decode = vi.fn((value: unknown) => value as { done: boolean });
    const items = collection<{ done: boolean }>("items", {
      codec: { encode: (value) => ({ ...value }), decode },
    });
    fetch.mockResolvedValueOnce(response(200, [
      { id: "milk", done: false },
      { id: "eggs", done: true },
    ]));

    const page = await run(method, db, items.query().limit(2).build());

    expect(page.records).toHaveLength(2);
    expect(page.records.map((record) => record.key.id)).toEqual(["milk", "eggs"]);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it.each(methods)("%s rejects a malformed limit before fetch", async (method) => {
    const { database: db, fetch } = database(10);
    const items = collection<{ done: boolean }>("items");
    const malformed = { ...items.query().build(), limit: Number.NaN };

    await expect(run(method, db, malformed)).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

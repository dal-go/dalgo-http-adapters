import { UnsupportedError, collection, type StructuredQuery } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { CouchDbDatabase } from "../src/index.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

function storageId(collectionName: string, id: string): string {
  const encoded = new TextEncoder().encode(JSON.stringify([collectionName, id]));
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function document(id: string) {
  return {
    _id: storageId("items", id),
    _rev: "1-a",
    __dalgo_collection: "items",
    __dalgo_id: id,
    data: { done: false },
  };
}

function database(maxQueryLimit = 1) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    fetch,
    database: new CouchDbDatabase({
      databaseUrl: "https://couch.example.com/app",
      fetch,
      maxQueryLimit,
    }),
  };
}

type QueryMethod = "query" | "queryWithSignal";

const methods: readonly QueryMethod[] = ["query", "queryWithSignal"];

function run<T>(method: QueryMethod, db: CouchDbDatabase, query: StructuredQuery<T>) {
  return method === "query" ? db.query(query) : db.queryWithSignal(query, new AbortController().signal);
}

describe("CouchDbDatabase query cardinality", () => {
  it.each(methods)("%s rejects a page above the requested limit before decoding", async (method) => {
    const { database: db, fetch } = database(1);
    const decode = vi.fn((value: unknown) => value as { done: boolean });
    const items = collection<{ done: boolean }>("items", {
      codec: { encode: (value) => ({ ...value }), decode },
    });
    fetch.mockResolvedValueOnce(response(200, { docs: [document("milk"), document("eggs")] }));

    await expect(run(method, db, items.query().limit(1).build()))
      .rejects.toThrow("CouchDB response returned more rows than the requested query limit");
    expect(decode).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("%s accepts a page that exactly matches the requested limit", async (method) => {
    const { database: db, fetch } = database(2);
    const decode = vi.fn((value: unknown) => value as { done: boolean });
    const items = collection<{ done: boolean }>("items", {
      codec: { encode: (value) => ({ ...value }), decode },
    });
    fetch.mockResolvedValueOnce(response(200, { docs: [document("milk"), document("eggs")] }));

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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1])(
    "rejects unsafe query limit %s before fetch",
    async (limit) => {
      const { database: db, fetch } = database(10);
      const items = collection<{ done: boolean }>("items");
      const malformed = { ...items.query().build(), limit };

      await expect(db.query(malformed)).rejects.toBeInstanceOf(UnsupportedError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

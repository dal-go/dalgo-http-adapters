import { UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { POSTGREST_READ_CAPABILITIES, PostgrestCursorError, PostgrestDatabase } from "../src/index.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

/** A body supplied as raw JSON so a 9007199254740993 ID is not rounded by JSON.stringify first. */
function rawResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function database(options: Partial<ConstructorParameters<typeof PostgrestDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    fetch,
    database: new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      ...options,
    }),
  };
}

function url(fetch: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(fetch.mock.calls[call]?.[0].toString() ?? "");
}

const items = collection<{ priority: number; score: number | null; done: boolean }>("items");

describe("PostgrestDatabase queryWithSignal cursor", () => {
  it("returns an opaque cursor for a full page and continues with a keyset filter", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [
      { id: "c", priority: 2, score: 3, done: false },
      { id: "a", priority: 2, score: 1, done: false },
    ]));

    const first = await db.queryWithSignal(
      items.query().where("done", "==", false).orderBy("priority", "desc").limit(2).build(),
      new AbortController().signal,
    );

    expect(first.records.map((record) => record.key.id)).toEqual(["c", "a"]);
    expect(first.records[0]?.data).toEqual({ priority: 2, score: 3, done: false });
    expect(url(fetch).searchParams.get("order")).toBe("priority.desc,id.asc");
    expect(url(fetch).searchParams.get("limit")).toBe("2");
    expect(url(fetch).searchParams.get("offset")).toBeNull();
    const cursor = first.nextCursor?.values[0];
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") throw new Error("cursor missing");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain("items");
    expect(cursor).not.toContain("priority");

    fetch.mockResolvedValueOnce(response(200, []));
    const second = await db.queryWithSignal(
      items.query().where("done", "==", false).orderBy("priority", "desc").limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(second).toEqual({ records: [] });
    expect(url(fetch, 1).searchParams.get("or")).toContain("priority.lt.2");
    expect(url(fetch, 1).searchParams.get("or")).toContain("and(priority.eq.2,id.gt.\"a\")");
    expect(url(fetch, 1).searchParams.get("offset")).toBeNull();
    expect(url(fetch, 1).searchParams.get("limit")).toBe("2");
  });

  it("adds the configured primary key as a deterministic tie-breaker", async () => {
    const { database: db, fetch } = database({ idColumn: "item_id" });
    fetch.mockResolvedValueOnce(response(200, [{ item_id: 10, priority: 1, score: null, done: false }]));
    const page = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    expect(url(fetch).searchParams.get("order")).toBe("item_id.asc");
    expect(url(fetch).searchParams.get("or")).toBeNull();
    expect(page.nextCursor).toBeDefined();
    expect(page.records[0]?.key).toEqual(key("items", 10));

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().limit(1).startAfter(page.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or")).toBe("(item_id.gt.10)");
  });

  it("quotes a control name used as the configured primary key in order and keyset terms", async () => {
    const { database: db, fetch } = database({ idColumn: "order" });
    fetch.mockResolvedValueOnce(response(200, [{ order: "a", priority: 1, score: null, done: false }]));
    const page = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    expect(url(fetch).searchParams.get("order")).toBe("\"order\".asc");
    expect(page.nextCursor).toBeDefined();
    expect(page.records[0]?.key).toEqual(key("items", "a"));
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or")).toBe("(\"order\".gt.\"a\")");
    expect(url(fetch, 1).searchParams.get("order")).toBe("\"order\".asc");
  });

  it("quotes a control name used as an order field in the keyset expression", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "z", priority: 1, score: null, done: false, order: 5 }]));
    const page = await db.queryWithSignal(
      items.query().orderBy("order").limit(1).build(),
      new AbortController().signal,
    );
    expect(url(fetch).searchParams.get("order")).toBe("\"order\".asc,id.asc");
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().orderBy("order").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or")).toBe("(\"order\".gt.5,\"order\".is.null,and(\"order\".eq.5,id.gt.\"z\"))");
  });

  it("does not duplicate an explicit primary-key order", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "z", priority: 1, score: null, done: false }]));
    await db.queryWithSignal(
      items.query().orderBy("score").orderBy("id", "desc").limit(1).build(),
      new AbortController().signal,
    );
    expect(url(fetch).searchParams.get("order")).toBe("score.asc,id.desc");
  });

  it("continues after a short non-empty page and ends on the empty page", async () => {
    const { database: db, fetch } = database();
    // A provider cap below the requested limit makes every page short. A
    // short page must not be mistaken for end-of-data.
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const short = await db.queryWithSignal(items.query().orderBy("priority").limit(5).build(), new AbortController().signal);
    expect(short.records.map((record) => record.key.id)).toEqual(["a"]);
    const shortCursor = short.nextCursor?.values[0];
    expect(typeof shortCursor).toBe("string");
    if (typeof shortCursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, [{ id: "b", priority: 2, score: null, done: false }]));
    const alsoShort = await db.queryWithSignal(
      items.query().orderBy("priority").limit(5).startAfter(shortCursor).build(),
      new AbortController().signal,
    );
    expect(alsoShort.records.map((record) => record.key.id)).toEqual(["b"]);
    expect(alsoShort.nextCursor).toBeDefined();
    expect(url(fetch, 1).searchParams.get("limit")).toBe("5");
    expect(url(fetch, 1).searchParams.get("or"))
      .toBe("(priority.gt.1,priority.is.null,and(priority.eq.1,id.gt.\"a\"))");

    fetch.mockResolvedValueOnce(response(200, []));
    const empty = await db.queryWithSignal(
      items.query().orderBy("priority").limit(5).startAfter(alsoShort.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(empty).toEqual({ records: [] });
  });

  it("keeps the legacy query offset contract as one request without a cursor", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const page = await db.query(items.query().limit(2).offset(1).build());
    expect(page).toEqual({
      records: [{ key: key("items", "a"), exists: true, data: { priority: 1, score: null, done: false } }],
    });
    expect(url(fetch).searchParams.get("limit")).toBe("2");
    expect(url(fetch).searchParams.get("offset")).toBe("1");
    expect(url(fetch).searchParams.get("or")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsafe integer ID from raw JSON instead of rounding it", async () => {
    const { database: db, fetch } = database();
    const decode = vi.fn((value: unknown) => value as { priority: number });
    const coded = collection<{ priority: number }>("items", { codec: { encode: (value) => ({ ...value }), decode } });
    // 9007199254740993 is intentionally a raw string: a JS literal would
    // already have been rounded to ...992 before the adapter saw it.
    fetch.mockResolvedValueOnce(rawResponse(200, "[{\"id\":9007199254740993,\"priority\":1}]"));

    const error = await db.queryWithSignal(coded.query().limit(1).build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PostgrestRequestError" });
    expect(String(error)).not.toContain("9007199254740993");
    expect(String(error)).not.toContain("priority");
    expect(decode).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsafe integer order value and emits no continuation cursor", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(rawResponse(200, "[{\"id\":\"a\",\"priority\":9007199254740993,\"score\":null,\"done\":false}]"));

    const error = await db.queryWithSignal(
      items.query().orderBy("priority").limit(1).build(),
      new AbortController().signal,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PostgrestRequestError" });
    expect(String(error)).not.toContain("9007199254740993");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsafe native number before emitting a record or cursor", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 2 ** 53, score: null, done: false }]));
    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(1).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestRequestError" });
    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(1).where("priority", "==", 2 ** 53).build(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a high-precision decimal order value and emits no continuation cursor", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(rawResponse(200, "[{\"id\":\"a\",\"priority\":1,\"score\":0.10000000000000001,\"done\":false}]"));
    const error = await db.queryWithSignal(
      items.query().orderBy("score").limit(1).build(),
      new AbortController().signal,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PostgrestRequestError" });
    expect(String(error)).not.toContain("0.10000000000000001");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an underflowing exponent token in a row instead of emitting zero", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(rawResponse(200, "[{\"id\":\"a\",\"priority\":1,\"score\":1e-400,\"done\":false}]"));
    const error = await db.queryWithSignal(
      items.query().orderBy("score").limit(1).build(),
      new AbortController().signal,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PostgrestRequestError" });
    expect(String(error)).not.toContain("1e-400");
  });

  it("refuses a crafted cursor containing a high-precision decimal as malformed", async () => {
    const { database: db, fetch } = database();
    const payload = Buffer.from(
      "{\"adapter\":\"@dalgo/dalgo2postgrest\",\"version\":1,"
      + "\"endpoint\":\"https://api.example.com/rest/v1/\","
      + "\"collection\":\"items\",\"relation\":\"items\",\"idColumn\":\"id\",\"select\":\"*\","
      + "\"filters\":[],\"orders\":[{\"field\":\"score\",\"direction\":\"asc\"}],"
      + "\"limit\":1,\"page\":2,\"values\":[0.10000000000000001]}",
      "utf8",
    ).toString("base64url");

    await expect(db.queryWithSignal(
      items.query().orderBy("score").limit(1).startAfter(payload).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a canonical decimal cursor literal exactly as the row reported it", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(rawResponse(200, "[{\"id\":\"a\",\"priority\":1,\"score\":0.1,\"done\":false}]"));
    const page = await db.queryWithSignal(
      items.query().orderBy("score").limit(1).build(),
      new AbortController().signal,
    );
    expect(page.records[0]?.data.score).toBe(0.1);
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().orderBy("score").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or"))
      .toBe("(score.gt.0.1,score.is.null,and(score.eq.0.1,id.gt.\"a\"))");
  });

  it("rejects a crafted cursor containing an unsafe integer as malformed", async () => {
    const { database: db, fetch } = database();
    // Written as raw JSON text: a JS literal would already be rounded.
    const payload = Buffer.from(
      "{\"adapter\":\"@dalgo/dalgo2postgrest\",\"version\":1,"
      + "\"endpoint\":\"https://api.example.com/rest/v1/\","
      + "\"collection\":\"items\",\"relation\":\"items\",\"idColumn\":\"id\",\"select\":\"*\","
      + "\"filters\":[],\"orders\":[{\"field\":\"id\",\"direction\":\"asc\"}],"
      + "\"limit\":1,\"page\":2,\"values\":[9007199254740993]}",
      "utf8",
    ).toString("base64url");

    await expect(db.queryWithSignal(
      items.query().limit(1).startAfter(payload).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a foreign cursor, a changed query, a changed order, a changed limit and a malformed token", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const page = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    const notes = collection<{ done: boolean }>("notes");
    await expect(db.queryWithSignal(
      notes.query().limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "foreign" });

    await expect(db.queryWithSignal(
      items.query().where("done", "==", true).limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      items.query().limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      items.query().limit(1).startAfter("not-a-cursor").build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "malformed" });

    await expect(db.queryWithSignal(
      items.query().limit(1).startAfter("e30").build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "foreign" });

    const otherEndpoint = new PostgrestDatabase({
      baseUrl: "https://other.example.com/rest/v1",
      fetch,
    });
    await expect(otherEndpoint.queryWithSignal(
      items.query().limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "foreign" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects cursor and offset together and keeps legacy query cursors refused", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const page = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    await expect(db.queryWithSignal(
      items.query().limit(1).offset(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(UnsupportedError);

    await expect(db.query(
      items.query().limit(1).startAfter(cursor).build(),
    )).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves numeric and null order values while continuing past nulls", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [
      { id: "a", priority: 1, score: 2.5, done: false },
      { id: "b", priority: 2, score: null, done: false },
    ]));
    const page = await db.queryWithSignal(
      items.query().orderBy("score", "asc").limit(2).build(),
      new AbortController().signal,
    );
    expect(page.records.map((record) => record.data.score)).toEqual([2.5, null]);
    expect(typeof page.records[0]?.data.priority).toBe("number");
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().orderBy("score", "asc").limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or")).toBe("(and(score.is.null,id.gt.\"b\"))");
  });

  it("starts after nulls-first descending order honestly", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [
      { id: "a", priority: 1, score: null, done: false },
    ]));
    const page = await db.queryWithSignal(
      items.query().orderBy("score", "desc").limit(1).build(),
      new AbortController().signal,
    );
    expect(page.nextCursor).toBeDefined();
    const cursor = page.nextCursor?.values[0];
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await db.queryWithSignal(
      items.query().orderBy("score", "desc").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    );
    expect(url(fetch, 1).searchParams.get("or"))
      .toBe("(score.not.is.null,and(score.is.null,id.gt.\"a\"))");
  });

  it("bounds offsets, pages and cursor size before decoding or fetching", async () => {
    const { database: db, fetch } = database({ maxQueryOffset: 3, maxQueryPages: 2 });
    await expect(db.queryWithSignal(
      items.query().limit(1).offset(4).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "UnsupportedError", capability: expect.stringContaining("offset") });
    await expect(db.query(items.query().limit(1).offset(4).build()))
      .rejects.toMatchObject({ name: "UnsupportedError", capability: expect.stringContaining("offset") });
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const first = await db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    const page2 = first.nextCursor?.values[0];
    if (typeof page2 !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, [{ id: "b", priority: 2, score: null, done: false }]));
    const second = await db.queryWithSignal(
      items.query().limit(1).startAfter(page2).build(),
      new AbortController().signal,
    );
    const page3 = second.nextCursor?.values[0];
    if (typeof page3 !== "string") throw new Error("cursor missing");

    await expect(db.queryWithSignal(
      items.query().limit(1).startAfter(page3).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "UnsupportedError", capability: expect.stringContaining("page") });
    expect(fetch).toHaveBeenCalledTimes(2);

    const tiny = database({ maxCursorBytes: 20 });
    tiny.fetch.mockResolvedValueOnce(response(200, [
      { id: "a-very-long-identifier-that-does-not-fit-in-a-cursor-token", priority: 1, score: null, done: false },
    ]));
    await expect(tiny.database.queryWithSignal(
      items.query().limit(1).build(),
      new AbortController().signal,
    )).rejects.toThrow("maxCursorBytes");
  });

  it("refuses an out-of-contract projection instead of silently dropping it", async () => {
    const { database: db, fetch } = database();
    const projected = { ...items.query().limit(1).build(), projection: ["id", "title"] };
    await expect(db.queryWithSignal(projected, new AbortController().signal))
      .rejects.toMatchObject({ name: "UnsupportedError", capability: "PostgREST query projection" });
    await expect(db.query(projected))
      .rejects.toMatchObject({ name: "UnsupportedError", capability: "PostgREST query projection" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects rows above the requested page before decoding", async () => {
    const { database: db, fetch } = database();
    const decode = vi.fn((value: unknown) => value as { done: boolean });
    const coded = collection<{ done: boolean }>("items", { codec: { encode: (value) => ({ ...value }), decode } });
    fetch.mockResolvedValueOnce(response(200, [
      { id: "a", done: false },
      { id: "b", done: true },
    ]));
    await expect(db.queryWithSignal(coded.query().limit(1).build(), new AbortController().signal))
      .rejects.toThrow("more rows than the requested query limit");
    expect(decode).not.toHaveBeenCalled();
  });

  it("publishes capability rows and configured bounds for the new semantics", () => {
    expect(POSTGREST_READ_CAPABILITIES.query.projection.status).toBe("unsupported");
    expect(POSTGREST_READ_CAPABILITIES.query.pagination.status).toBe("native");
    expect(POSTGREST_READ_CAPABILITIES.query.pagination.detail).toContain("opaque keyset cursor");
    expect(POSTGREST_READ_CAPABILITIES.query.discovery.status).toBe("native");
    expect(POSTGREST_READ_CAPABILITIES.query.discovery.detail).toContain("OpenAPI");
    expect(POSTGREST_READ_CAPABILITIES.bounds).toMatchObject({
      maxQueryLimit: { default: 100, maximum: 1_000 },
      maxQueryOffset: { default: 100_000, maximum: 10_000_000 },
      maxQueryPages: { default: 10_000, maximum: 1_000_000 },
      maxDiscoveryRelations: { default: 100, maximum: 10_000 },
      maxDiscoveryFieldsPerRelation: { default: 200, maximum: 10_000 },
      maxDiscoveryBytes: { default: 524_288, maximum: 16_777_216 },
      maxCursorBytes: { default: 8_192, maximum: 65_536 },
      maxSchemaDepth: { default: 4, maximum: 16 },
    });
  });
});

describe("PostgrestCursorError", () => {
  it("is a deliberate unsupported error with no row or token text", () => {
    const error = new PostgrestCursorError("foreign");
    expect(error).toBeInstanceOf(UnsupportedError);
    expect(error).toMatchObject({ name: "PostgrestCursorError", reason: "foreign" });
    expect(String(error)).not.toContain("Bearer");
  });
});

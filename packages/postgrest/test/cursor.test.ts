import { UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { POSTGREST_READ_CAPABILITIES, PostgrestCursorError, PostgrestDatabase } from "../src/index.js";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
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

  it("does not duplicate an explicit primary-key order", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "z", priority: 1, score: null, done: false }]));
    await db.queryWithSignal(
      items.query().orderBy("score").orderBy("id", "desc").limit(1).build(),
      new AbortController().signal,
    );
    expect(url(fetch).searchParams.get("order")).toBe("score.asc,id.desc");
  });

  it("ends honestly: a short page has no cursor and an empty follow-up has no cursor", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "a", priority: 1, score: null, done: false }]));
    const short = await db.queryWithSignal(items.query().limit(2).build(), new AbortController().signal);
    expect(short.nextCursor).toBeUndefined();

    fetch.mockResolvedValueOnce(response(200, [
      { id: "a", priority: 1, score: null, done: false },
      { id: "b", priority: 2, score: null, done: false },
    ]));
    const full = await db.queryWithSignal(items.query().limit(2).build(), new AbortController().signal);
    expect(full.nextCursor).toBeDefined();

    fetch.mockResolvedValueOnce(response(200, []));
    const empty = await db.queryWithSignal(
      items.query().limit(2).startAfter(full.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(empty).toEqual({ records: [] });
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

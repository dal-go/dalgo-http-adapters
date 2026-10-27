import { collection, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import {
  LibSQLRequestError,
  NativeLibSQLDatabase,
  type NativeLibSQLDatabaseOptions,
} from "../src/index.js";
import {
  blob,
  executed,
  firstStatement,
  float,
  integer,
  mockFetch,
  never,
  nullValue,
  ok,
  response,
  text,
  type Call,
} from "./helpers.js";

const itemProjection = ["__dalgo_key", "title", "rank", "score"];
const textProjection = ["__dalgo_key", "label"];
const realProjection = ["__dalgo_key", "label"];

function options(overrides: Partial<NativeLibSQLDatabaseOptions> = {}): NativeLibSQLDatabaseOptions {
  return {
    serverUrl: "https://libsql.example.test",
    allowInsecureLoopbackHttp: false,
    headers: () => ({ authorization: "Bearer reader-token" }),
    identityScope: "user-42",
    maxGetManyKeys: 5,
    maxGetManyBytes: 10_000,
    maxQueryLimit: 5,
    maxResponseBytes: 10_000,
    maxRequestBytes: 10_000,
    timeoutMs: 1_000,
    tables: {
      items: {
        table: "items",
        uniqueKey: true,
        key: { column: "id", type: "integer" },
        columns: {
          title: { column: "title", nullable: false },
          rank: { column: "rank", nullable: true },
          score: { column: "score", nullable: true },
        },
      },
      labels: {
        table: "labels",
        uniqueKey: true,
        key: { column: "code", type: "text" },
        columns: { label: { column: "label", nullable: true } },
      },
      metrics: {
        table: "metrics",
        uniqueKey: true,
        key: { column: "ratio", type: "real" },
        columns: { label: { column: "label", nullable: true } },
      },
    },
    ...overrides,
  };
}

function database(responses: readonly Response[], calls: Call[], overrides: Partial<NativeLibSQLDatabaseOptions> = {}): NativeLibSQLDatabase {
  return new NativeLibSQLDatabase({ ...options(overrides), fetch: mockFetch(responses, calls) });
}

const items = collection<{ title: string; rank: number | null; score: number | null }, number>("items");

describe("NativeLibSQLDatabase", () => {
  it("preserves native integer, text and real IDs and returns non-key fields without an envelope", async () => {
    const calls: Call[] = [];
    const db = database([
      response([ok(executed(itemProjection, [[integer(7), text("Seven"), nullValue(), float(2.5)]]) )]),
      response([ok(executed(textProjection, [[text("a1"), text("Alpha")]]) )]),
      response([ok(executed(realProjection, [[float(0.1), text("Tenth")]]) )]),
    ], calls);

    await expect(db.get(items.key(7))).resolves.toEqual({
      key: items.key(7),
      exists: true,
      data: { title: "Seven", rank: null, score: 2.5 },
      metadata: { id: 7 },
    });
    await expect(db.get(key("labels", "a1"))).resolves.toEqual({
      key: key("labels", "a1"),
      exists: true,
      data: { label: "Alpha" },
      metadata: { id: "a1" },
    });
    await expect(db.get(key("metrics", 0.1))).resolves.toEqual({
      key: key("metrics", 0.1),
      exists: true,
      data: { label: "Tenth" },
      metadata: { id: 0.1 },
    });
    expect(firstStatement(calls[0]).args).toEqual([integer(7)]);
    expect(firstStatement(calls[2]).args).toEqual([float(0.1)]);
  });

  it("never coerces a wrong native key type and refuses unsafe integers and blobs", async () => {
    const textForInteger = database([response([ok(executed(itemProjection, [[text("7"), text("Seven"), nullValue(), nullValue()]]))])], []);
    await expect(textForInteger.get(items.key(7))).rejects.toThrow("numbers for a integer key column");

    const unsafe = database([response([ok(executed(itemProjection, [[integer("9007199254740992"), text("Huge"), nullValue(), nullValue()]]))])], []);
    await expect(unsafe.get(items.key(7))).rejects.toThrow("safe-integer");

    const blobbed = database([response([ok(executed(itemProjection, [[integer(7), text("Seven"), blob(), nullValue()]]))])], []);
    await expect(blobbed.get(items.key(7))).rejects.toThrow("blob");

    const calls: Call[] = [];
    const wrongInput = database([], calls);
    await expect(wrongInput.get(key("labels", 7))).rejects.toThrow("strings for a text key column");
    await expect(wrongInput.get(items.key("7" as unknown as number))).rejects.toThrow("numbers for a integer key column");
    expect(calls).toHaveLength(0);
  });

  it("refuses every mutation and callback transaction before any request", async () => {
    const calls: Call[] = [];
    const db = database([], calls);
    await expect(db.insert(items.key(1), { title: "x", rank: null, score: null })).rejects.toThrow("read-only: insert");
    await expect(db.set(items.key(1), { title: "x", rank: null, score: null })).rejects.toThrow("read-only: set");
    await expect(db.update(items.key(1), { title: "x" })).rejects.toThrow("read-only: update");
    await expect(db.delete(items.key(1))).rejects.toThrow("read-only: delete");
    await expect(db.runReadwriteTransaction(async () => "x")).rejects.toThrow("read-only: callback transactions");
    expect(db.readOnly).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects foreign collections, unsupported queries and duplicate point rows before or without costly work", async () => {
    const calls: Call[] = [];
    const db = database([response([ok(executed(itemProjection, [[integer(1), text("One"), nullValue(), nullValue()], [integer(1), text("One again"), nullValue(), nullValue()]]))])], calls);
    await expect(db.get(key("not-allowed", 1))).rejects.toThrow("not allowlisted");
    await expect(db.get(items.key(1))).rejects.toThrow("more than one record");

    const unsupported = [
      db.query({ ...items.query().build(), offset: 1 }),
      db.query({ ...items.query().build(), startAt: { values: [1] } }),
      db.query({ ...items.query().build(), source: { kind: "collection-group", name: "items" } }),
      db.query({ ...items.query().build(), projection: ["title"] } as never),
      db.query({ ...items.query().limit(99).build() }),
    ];
    for (const operation of unsupported) await expect(operation).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("pages with an opaque single-use cursor and keeps a short non-empty page open", async () => {
    const calls: Call[] = [];
    const db = database([
      response([ok(executed(itemProjection, [[integer(1), text("One"), integer(2), nullValue()]]) )]),
      response([ok(executed(itemProjection, []))]),
    ], calls);
    const first = await db.queryWithSignal(items.query().orderBy("rank").limit(5).build(), new AbortController().signal);
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor?.values[0]).toMatch(/^nls1_[A-Za-z0-9_-]{43}$/u);
    expect(firstStatement(calls[0]).sql).toContain('ORDER BY t."rank" ASC NULLS FIRST, t."id" ASC NULLS FIRST LIMIT 5');
    expect(firstStatement(calls[0]).sql).toContain('__dalgo_key"');

    const end = await db.queryWithSignal(
      items.query().orderBy("rank").limit(5).startAfter(first.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(end).toEqual({ records: [] });
    const continuation = firstStatement(calls[1]).sql;
    expect(continuation).toContain('t."rank" > ?');
    expect(continuation).toContain('t."rank" = ? AND t."id" > ?');
  });

  it("handles nullable order values honestly for both directions", async () => {
    const ascCalls: Call[] = [];
    const asc = database([
      response([ok(executed(itemProjection, [[integer(1), text("Null rank"), nullValue(), nullValue()]]) )]),
      response([ok(executed(itemProjection, []))]),
    ], ascCalls);
    const first = await asc.queryWithSignal(items.query().orderBy("rank").limit(2).build(), new AbortController().signal);
    await asc.queryWithSignal(
      items.query().orderBy("rank").limit(2).startAfter(first.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(firstStatement(ascCalls[1]).sql).toContain('t."rank" IS NOT NULL');

    const descCalls: Call[] = [];
    const desc = database([
      response([ok(executed(itemProjection, [[integer(1), text("Ranked"), integer(2), nullValue()]]) )]),
      response([ok(executed(itemProjection, []))]),
    ], descCalls);
    const descFirst = await desc.queryWithSignal(items.query().orderBy("rank", "desc").limit(2).build(), new AbortController().signal);
    await desc.queryWithSignal(
      items.query().orderBy("rank", "desc").limit(2).startAfter(descFirst.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    const sql = firstStatement(descCalls[1]).sql;
    expect(sql).toContain('ORDER BY t."rank" DESC NULLS LAST, t."id" ASC NULLS FIRST');
    expect(sql).toContain('(t."rank" < ? OR t."rank" IS NULL)');
  });

  it("binds cursors to the query and scope and rejects replay", async () => {
    let tokenValue = "scope-a";
    const { identityScope, ...unscoped } = options();
    void identityScope;
    const db = new NativeLibSQLDatabase({
      ...unscoped,
      headers: () => ({ authorization: `Bearer ${tokenValue}` }),
      fetch: mockFetch([
        response([ok(executed(itemProjection, [[integer(1), text("One"), integer(1), nullValue()]]) )]),
        response([ok(executed(itemProjection, []))]),
      ], []),
    });
    const first = await db.queryWithSignal(items.query().orderBy("rank").limit(1).build(), new AbortController().signal);
    const cursor = first.nextCursor?.values[0];
    tokenValue = "scope-b";
    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "changed-query" }));
    tokenValue = "scope-a";
    await expect(db.queryWithSignal(
      items.query().orderBy("title").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "changed-query" }));
    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter("nls1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "foreign" }));

    const scoped = database([
      response([ok(executed(itemProjection, [[integer(1), text("One"), integer(1), nullValue()]]) )]),
      response([ok(executed(itemProjection, []))]),
    ], []);
    const page = await scoped.queryWithSignal(items.query().orderBy("rank").limit(1).build(), new AbortController().signal);
    await scoped.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(page.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    await expect(scoped.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(page.nextCursor?.values[0]).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "replayed" }));
  });

  it("bounds getMany concurrency and bytes and honours caller cancellation", async () => {
    let active = 0;
    let maximum = 0;
    const many = new NativeLibSQLDatabase({
      ...options({ maxParallelReads: 2 }),
      fetch: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return response([ok(executed(itemProjection, [[integer(1), text("One"), nullValue(), nullValue()]]))]);
      },
    });
    const snapshots = await many.getMany([items.key(1), items.key(1), items.key(1), items.key(1)]);
    expect(snapshots.map((snapshot) => snapshot.key.id)).toEqual([1, 1, 1, 1]);
    expect(maximum).toBeLessThanOrEqual(2);

    await expect(database([], [], { maxGetManyKeys: 2 }).getMany([items.key(1), items.key(2), items.key(3)]))
      .rejects.toThrow("maxGetManyKeys");

    const pending = database([], [], { fetch: () => never<Response>() });
    const controller = new AbortController();
    const result = pending.queryWithSignal(items.query().limit(1).build(), controller.signal);
    controller.abort();
    await expect(result).rejects.toEqual(expect.objectContaining({ name: "QueryCancelledError", reason: "caller" }));
    await expect(pending.get(items.key(1), undefined, controller.signal)).rejects.toEqual(
      expect.objectContaining({ name: "QueryCancelledError", reason: "caller" }),
    );

    const failing = database([], [], { headers: () => Promise.reject(new Error("secret header")) });
    const failure = await failing.get(items.key(1)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LibSQLRequestError);
    expect(String(failure)).not.toContain("secret");
  });

  it("reports provider metadata, allowlisting and configured contracts", async () => {
    const db = database([
      response([ok(executed(["name", "type", "wr"], [
        [text("items"), text("table"), integer(0)],
        [text("items_view"), text("view"), integer(0)],
      ]))]),
      response([
        ok(executed(["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], [
          [integer(0), text("id"), text("INTEGER"), integer(0), nullValue(), integer(1), integer(0)],
          [integer(1), text("title"), text("TEXT"), integer(1), nullValue(), integer(0), integer(0)],
        ])),
        ok(executed(["index_name", "is_unique", "origin", "partial", "seqno", "column_name"], [])),
        ok(executed(["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], [
          [integer(0), text("id"), text("INTEGER"), integer(0), nullValue(), integer(0), integer(0)],
        ])),
        ok(executed(["index_name", "is_unique", "origin", "partial", "seqno", "column_name"], [])),
      ]),
    ], []);
    const description = await db.describe();
    expect(description).toMatchObject({
      adapter: "@dal-go/dalgo2libsql",
      storage: "native-rows",
      readOnly: true,
      connection: { ok: true, status: "connected", tableCount: 2 },
      discovery: { status: "available", tableCount: 2 },
    });
    const itemsTable = description.discovery.tables.find((table) => table.name === "items");
    expect(itemsTable).toMatchObject({
      allowlisted: true,
      kind: "table",
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      unique: { status: "declared-primary-key" },
      configuredKey: { collection: "items", column: "id", type: "integer" },
      adapterQueryable: true,
    });
    expect(itemsTable?.fields.find((field) => field.name === "id")).toMatchObject({
      declaredType: "INTEGER",
      affinity: "integer",
      // SQLite reports notnull=0 for an INTEGER PRIMARY KEY rowid alias; the
      // uniqueness calculation, not this flag, proves the non-null ID.
      nullable: true,
      primaryKeyPosition: 1,
    });
    const view = description.discovery.tables.find((table) => table.name === "items_view");
    expect(view).toMatchObject({ allowlisted: false, adapterQueryable: false });
    expect(description.limits.maxQueryLimit).toBe(5);
  });

  it("rejects a configured key type that contradicts metadata", async () => {
    const db = new NativeLibSQLDatabase({
      ...options({
        tables: {
          items: {
            table: "items",
            uniqueKey: true,
            key: { column: "id", type: "text" },
            columns: { title: { column: "title", nullable: true } },
          },
        },
      }),
      fetch: mockFetch([
        response([ok(executed(["name", "type", "wr"], [[text("items"), text("table"), integer(0)]]))]),
        response([
          ok(executed(["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], [
            [integer(0), text("id"), text("INTEGER"), integer(0), nullValue(), integer(1), integer(0)],
          ])),
          ok(executed(["index_name", "is_unique", "origin", "partial", "seqno", "column_name"], [])),
        ]),
      ], []),
    });
    const discovery = await db.discover();
    const table = discovery.tables[0];
    expect(table?.adapterQueryable).toBe(false);
    expect(table?.adapterQueryableReason).toContain("key type");
  });
});

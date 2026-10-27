import { AlreadyExistsError, collection } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import {
  LibSQLBatchSizeError,
  LibSQLDatabase,
  LibSQLRequestError,
  type LibSQLDatabaseOptions,
} from "../src/index.js";
import {
  blob,
  executed,
  failed,
  firstStatement,
  float,
  integer,
  json,
  mockFetch,
  never,
  nullValue,
  ok,
  response,
  text,
  type Call,
} from "./helpers.js";

const projection = ["__dalgo_key", "title", "rank"];
const one = [text("one"), text("Milk"), integer(10)];
const two = [text("two"), text("Tea"), integer(11)];

function options(overrides: Partial<LibSQLDatabaseOptions> = {}): LibSQLDatabaseOptions {
  return {
    serverUrl: "https://libsql.example.test",
    headers: () => ({ authorization: "Bearer rotating-token", "x-deployment-header": "example" }),
    maxRows: 10,
    maxResponseBytes: 10_000,
    maxRequestBytes: 10_000,
    timeoutMs: 1_000,
    tables: {
      items: {
        table: "items",
        uniqueKey: true,
        keyColumn: { column: "id", nullable: false },
        columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
      },
    },
    ...overrides,
  };
}

function database(responses: readonly Response[], calls: Call[], overrides: Partial<LibSQLDatabaseOptions> = {}): LibSQLDatabase {
  return new LibSQLDatabase({ ...options(overrides), fetch: mockFetch(responses, calls) });
}

const items = collection<{ title: string; rank: number }>("items");
const numericItems = collection<{ title: string; rank: number }, number>("items");

describe("LibSQLDatabase managed tables", () => {
  it("uses one close-ended v3 pipeline with header injection, redirect refusal and positional binding", async () => {
    const calls: Call[] = [];
    const db = database([response([ok(executed(projection, [one, two]))])], calls);
    const page = await db.query(items.query().where("rank", ">=", 10).orderBy("rank").limit(1).build());

    expect(page.records).toEqual([{ key: items.key("one"), exists: true, data: { title: "Milk", rank: 10 } }]);
    expect(page.nextCursor).toEqual({ values: [10, "one"] });
    expect(calls[0]?.url).toBe("https://libsql.example.test/v3/pipeline");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer rotating-token",
      "x-deployment-header": "example",
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(calls[0]?.init?.redirect).toBe("error");
    const sent = firstStatement(calls[0]);
    expect(sent.sql).toContain('t."rank" >= ?');
    expect(sent.sql).toContain('ORDER BY t."rank" ASC, t."id" ASC LIMIT 2');
    expect(sent.args).toEqual([integer(10)]);
    expect(sent.want_rows).toBe(true);
  });

  it("preserves integer and finite real native IDs instead of stringifying them", async () => {
    const calls: Call[] = [];
    const db = database([
      response([ok(executed(projection, [[integer(7), text("Seven"), integer(1)]]))]),
      response([ok(executed(projection, [[float(0.1), text("Tenth"), float(2.5)]]))]),
      response([ok(executed(projection, []))]),
    ], calls, {
      tables: {
        items: {
          table: "items",
          uniqueKey: true,
          keyColumn: { column: "id", nullable: false },
          columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
        },
      },
    });

    await expect(db.get(numericItems.key(7))).resolves.toEqual({ key: numericItems.key(7), exists: true, data: { title: "Seven", rank: 1 } });
    await expect(db.get(numericItems.key(0.1))).resolves.toEqual({ key: numericItems.key(0.1), exists: true, data: { title: "Tenth", rank: 2.5 } });
    await expect(db.get(items.key("missing"))).resolves.toEqual({ key: items.key("missing"), exists: false });
    expect(firstStatement(calls[0]).args).toEqual([integer(7)]);
    expect(firstStatement(calls[1]).args).toEqual([float(0.1)]);
    expect(projection).toHaveLength(3);
  });

  it("performs parameterized CRUD only with an explicitly unique key mapping", async () => {
    const calls: Call[] = [];
    const db = database([
      response([ok(executed([], [], 1))]),
      response([ok(executed([], [], 1))]),
      response([ok(executed([], [], 1))]),
      response([ok(executed([], [], 1))]),
    ], calls);
    await db.insert(numericItems.key(7), { title: "Milk", rank: 10 });
    await db.set(numericItems.key(7), { title: "Tea", rank: 11 });
    await db.update(numericItems.key(7), { title: "Coffee" });
    await db.delete(numericItems.key(7));

    expect(firstStatement(calls[0]).sql).toContain('INSERT INTO "items" ("id", "title", "rank") VALUES (?, ?, ?)');
    expect(firstStatement(calls[0]).args).toEqual([integer(7), text("Milk"), integer(10)]);
    expect(firstStatement(calls[1]).sql).toContain('ON CONFLICT("id") DO UPDATE SET "title" = excluded."title", "rank" = excluded."rank"');
    expect(firstStatement(calls[2]).sql).toContain('UPDATE "items" SET "title" = ? WHERE "id" = ?');
    expect(firstStatement(calls[3]).sql).toContain('DELETE FROM "items" WHERE "id" = ?');
    expect(firstStatement(calls[1]).want_rows).toBe(false);

    const blocked = database([], [], {
      tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
    });
    await expect(blocked.insert(items.key("one"), { title: "Milk", rank: 10 })).rejects.toThrow("uniqueKey: true");
  });

  it("maps only unique and primary-key insert constraint codes to AlreadyExistsError", async () => {
    const calls: Call[] = [];
    const db = database([response([failed("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE")])], calls);
    await expect(db.insert(items.key("one"), { title: "Milk", rank: 10 })).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("rejects unproven transactions, unsafe URLs, invalid mappings and credential leaking", async () => {
    const calls: Call[] = [];
    const db = database([response([], 403), response([failed("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT")])], calls);
    await expect(db.get(items.key("one"))).rejects.toEqual(expect.objectContaining({ name: "LibSQLHttpError", status: 403 }));
    const failure = await db.get(items.key("one")).catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ name: "LibSQLPipelineError", code: "SQLITE_CONSTRAINT" }));
    expect(String(failure)).not.toContain("secret server text");
    await expect(db.runReadwriteTransaction(async () => "nope")).rejects.toThrow("not implemented");
    expect(calls).toHaveLength(2);

    expect(() => database([], [], { serverUrl: "http://libsql.example.test" })).toThrow("HTTPS");
    expect(() => database([], [], { serverUrl: "http://127.0.0.1:8080" })).toThrow("allowInsecureLoopbackHttp");
    expect(() => database([], [], { serverUrl: "http://127.0.0.1:8080", allowInsecureLoopbackHttp: true })).not.toThrow();
    expect(() => database([], [], { serverUrl: "https://user:pass@libsql.example.test" })).toThrow("credentials");
    expect(() => database([], [], { tables: { items: { table: "items; DROP", keyColumn: { column: "id" }, columns: {} } } })).toThrow("identifier");
    expect(() => database([], [], {
      tables: {
        a: { table: "shared", keyColumn: { column: "id" }, columns: { title: { column: "title" } } },
        b: { table: "shared", keyColumn: { column: "id" }, columns: { title: { column: "title" } } },
      },
    })).toThrow("duplicate libSQL table mapping");
  });

  it("bounds response and request bytes and refuses blobs and unsafe integers explicitly", async () => {
    const oversized = database([response([], 200, { "content-length": "10001" })], []);
    await expect(oversized.get(items.key("one"))).rejects.toThrow("maxResponseBytes");

    const unsafe = database([response([ok(executed(projection, [[text("one"), text("Milk"), integer("9007199254740992")]]))])], []);
    await expect(unsafe.get(items.key("one"))).rejects.toThrow("safe-integer");

    const blobbed = database([response([ok(executed(projection, [[text("one"), text("Milk"), blob()]]))])], []);
    await expect(blobbed.get(items.key("one"))).rejects.toThrow("blob");

    const calls: Call[] = [];
    const tooLarge = database([], calls, { maxRequestBytes: 10 });
    await expect(tooLarge.get(items.key("one"))).rejects.toThrow("maxRequestBytes");
    expect(calls).toHaveLength(0);

    const rowOverflow = database([response([ok(executed(projection, [one, two, [text("three"), text("X"), integer(1)], [text("four"), text("Y"), integer(2)]]) )])], []);
    await expect(rowOverflow.queryWithSignal(items.query().limit(2).build(), new AbortController().signal)).rejects.toThrow("more rows");
  });

  it("emits only explicit deterministic legacy cursors and rejects nullable or offset paging", async () => {
    const calls: Call[] = [];
    const db = database([response([ok(executed(projection, [one, two]))]), response([ok(executed(projection, []))])], calls);
    const unordered = await db.query(items.query().limit(1).build());
    expect(unordered.nextCursor).toBeUndefined();

    await db.query(items.query().orderBy("rank", "desc").orderBy("title", "asc").startAfter(11, "Tea", "two").limit(1).build());
    const sent = firstStatement(calls[1]);
    expect(sent.sql).toContain('ORDER BY t."rank" DESC, t."title" ASC, t."id" ASC');
    expect(sent.sql).toContain('((t."rank" < ?) OR (t."rank" = ? AND t."title" > ?) OR (t."rank" = ? AND t."title" = ? AND t."id" > ?))');
    expect(sent.args).toEqual([integer(11), integer(11), text("Tea"), integer(11), text("Tea"), text("two")]);

    const ambiguous = database([], [], {
      tables: { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" }, rank: { column: "rank", nullable: false } } } },
    });
    await expect(ambiguous.query(items.query().orderBy("title").limit(1).build())).rejects.toThrow("nullable: false");
    await expect(ambiguous.query(items.query().offset(1).build())).rejects.toThrow("offsets");
    await expect(ambiguous.query(items.query().where("rank", "in", [1, 2]).build())).rejects.toThrow("operator");
  });

  it("scopes caller cancellation and deadline to one operation through headers, fetch and body", async () => {
    const calls: Call[] = [];
    const db = database([], calls);
    const aborted = new AbortController();
    aborted.abort();
    await expect(db.queryWithSignal(items.query().build(), aborted.signal)).rejects.toEqual(
      expect.objectContaining({ name: "QueryCancelledError", reason: "caller" }),
    );
    expect(calls).toHaveLength(0);

    const pending = database([], [], { fetch: () => never<Response>() });
    const controller = new AbortController();
    const result = pending.get(items.key("one"), undefined, controller.signal);
    controller.abort();
    await expect(result).rejects.toEqual(expect.objectContaining({ name: "QueryCancelledError", reason: "caller" }));

    const bodyPending = new Response(new ReadableStream<Uint8Array>({ pull: () => never<void>() }));
    const bodyDb = database([], [], { fetch: async () => bodyPending });
    const bodyController = new AbortController();
    const bodyResult = bodyDb.get(items.key("one"), undefined, bodyController.signal);
    bodyController.abort();
    await expect(bodyResult).rejects.toEqual(expect.objectContaining({ name: "QueryCancelledError", reason: "caller" }));

    const slowHeaders = database([], [], { timeoutMs: 5, headers: () => never<Readonly<Record<string, string>>>() });
    await expect(slowHeaders.get(items.key("one"))).rejects.toThrow("configured timeout");
    await expect(slowHeaders.get(items.key("one"), undefined, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ name: "QueryCancelledError", reason: "deadline" }),
    );

    const failingHeaders = database([], [], { headers: () => Promise.reject(new Error("secret header failure")) });
    const headerFailure = await failingHeaders.get(items.key("one")).catch((error: unknown) => error);
    expect(headerFailure).toBeInstanceOf(LibSQLRequestError);
    expect(String(headerFailure)).not.toContain("secret");

    const malformed = database([new Response("secret non-JSON server response")], []);
    const parseFailure = await malformed.get(items.key("one")).catch((error: unknown) => error);
    expect(String(parseFailure)).not.toContain("secret non-JSON");
    expect(parseFailure).not.toHaveProperty("cause");
  });

  it("returns opaque single-use cursors bound to the exact query", async () => {
    const calls: Call[] = [];
    const db = database([
      response([ok(executed(projection, [one, two]))]),
      response([ok(executed(projection, []))]),
    ], calls);
    const first = await db.queryWithSignal(items.query().orderBy("rank").limit(2).build(), new AbortController().signal);
    const token = first.nextCursor?.values[0];
    expect(typeof token).toBe("string");
    expect(String(token)).toMatch(/^nls1_[A-Za-z0-9_-]{43}$/u);
    expect(first.records).toHaveLength(2);

    const empty = await db.queryWithSignal(
      items.query().orderBy("rank").limit(2).startAfter(token).build(),
      new AbortController().signal,
    );
    expect(empty).toEqual({ records: [] });
    expect(firstStatement(calls[1]).sql).toContain('(t."rank" = ? AND t."id" > ?)');

    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(2).startAfter(token).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "replayed" }));
    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(2).where("title", "==", "Milk").startAfter("nls1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "foreign" }));
    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(2).startAfter("not-a-handle").build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "malformed" }));
  });

  it("rejects changed queries and credential scopes, and honours an explicit identity scope", async () => {
    let tokenValue = "scope-a";
    const calls: Call[] = [];
    const db = new LibSQLDatabase({
      ...options(),
      headers: () => ({ authorization: `Bearer ${tokenValue}` }),
      fetch: mockFetch([
        response([ok(executed(projection, [one]))]),
        response([ok(executed(projection, []))]),
        response([ok(executed(projection, [one]))]),
        response([ok(executed(projection, []))]),
      ], calls),
    });
    const first = await db.queryWithSignal(items.query().orderBy("rank").limit(1).build(), new AbortController().signal);
    const cursor = first.nextCursor?.values[0];
    tokenValue = "scope-b";
    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "changed-query" }));

    await expect(db.queryWithSignal(
      items.query().orderBy("rank").limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ name: "LibSQLCursorError", reason: "changed-query" }));

    let identityHeaders = { authorization: "Bearer first", "x-user": "42" };
    const scoped = new LibSQLDatabase({
      ...options(),
      identityScope: "user-42",
      headers: () => identityHeaders,
      fetch: mockFetch([
        response([ok(executed(projection, [one]))]),
        response([ok(executed(projection, []))]),
      ], []),
    });
    const scopedFirst = await scoped.queryWithSignal(items.query().orderBy("rank").limit(1).build(), new AbortController().signal);
    identityHeaders = { authorization: "Bearer rotated", "x-user": "42" };
    await expect(scoped.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(scopedFirst.nextCursor?.values[0]).build(),
      new AbortController().signal,
    )).resolves.toEqual({ records: [] });
  });

  it("bounds cursor pages, rejects duplicate keys, and never treats a non-empty page as end", async () => {
    const db = database([
      response([ok(executed(projection, [one]))]),
    ], []);
    const first = await db.queryWithSignal(items.query().orderBy("rank").limit(2).build(), new AbortController().signal);
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();

    const limited = database([
      response([ok(executed(projection, [one]))]),
    ], [], { maxQueryPages: 1 });
    const page = await limited.queryWithSignal(items.query().orderBy("rank").limit(1).build(), new AbortController().signal);
    await expect(limited.queryWithSignal(
      items.query().orderBy("rank").limit(1).startAfter(page.nextCursor?.values[0]).build(),
      new AbortController().signal,
    )).rejects.toThrow("maxQueryPages");

    const duplicate = database([response([ok(executed(projection, [one, one]))])], []);
    await expect(duplicate.queryWithSignal(
      items.query().orderBy("rank").limit(2).build(),
      new AbortController().signal,
    )).rejects.toThrow("duplicate record keys");
  });

  it("bounds getMany keys, parallel reads and cumulative bytes without Promise.all fan-out", async () => {
    await expect(database([], [], { maxGetManyKeys: 2 }).getMany([items.key("a"), items.key("b"), items.key("c")]))
      .rejects.toThrow("maxGetManyKeys");

    let active = 0;
    let maximum = 0;
    const many = new LibSQLDatabase({
      ...options({ maxParallelReads: 2, maxGetManyKeys: 5 }),
      fetch: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return response([ok(executed(projection, [one]))]);
      },
    });
    const snapshots = await many.getMany([items.key("one"), items.key("one"), items.key("one"), items.key("one"), items.key("one")]);
    expect(snapshots).toHaveLength(5);
    expect(maximum).toBeLessThanOrEqual(2);

    const small = database([response([ok(executed(projection, [one]))])], [], { maxGetManyBytes: 1 });
    await expect(small.getMany([items.key("one")])).rejects.toBeInstanceOf(LibSQLBatchSizeError);
  });

  it("rejects malformed pipeline envelopes, closes and projections", async () => {
    const baton = database([json({ baton: "bat-on", results: [] })], []);
    await expect(baton.get(items.key("one"))).rejects.toThrow("baton");

    const badClose = database([json({ baton: null, results: [ok(executed(projection, [])), { type: "ok", response: { type: "not-close" } }] })], []);
    await expect(badClose.get(items.key("one"))).rejects.toThrow("close");

    const wrongProjection = database([response([ok(executed(["id", "title", "rank"], []))])], []);
    await expect(wrongProjection.get(items.key("one"))).rejects.toThrow("projection");

    expect(() => new LibSQLDatabase({ ...options(), tables: { items: { table: "items", keyColumn: { column: "id" }, columns: {} } } }))
      .toThrow("at least one");
    expect(() => new LibSQLDatabase({ ...options(), tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { __dalgo_key: { column: "x" } } } } }))
      .toThrow("reserved");
  });

  it("does not launch a request for unsupported operations", async () => {
    const calls: Call[] = [];
    const db = database([], calls);
    const group = collection("items");
    const unsupported = [
      db.query({ ...group.query().build(), offset: 1 }),
      db.query({ ...group.query().build(), source: { kind: "collection-group", name: "items" } }),
      db.query({ ...group.query().build(), startAt: { values: [1] } }),
      db.queryWithSignal({ ...group.query().build(), projection: ["title"] } as never, new AbortController().signal),
      db.update(items.key("one"), { unknown: 1 }),
    ];
    for (const operation of unsupported) {
      await expect(operation).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("reports metadata unavailable separately from an empty database and maps auth failures", async () => {
    const unavailable = database([response([], 401), response([], 401)], []);
    await expect(unavailable.discover()).resolves.toMatchObject({ status: "unavailable", reason: "unauthorized", httpStatus: 401 });
    await expect(unavailable.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });

    const empty = database([
      response([ok(executed(["name", "type", "wr"], []))]),
      response([ok(executed(["name", "type", "wr"], []))]),
    ], []);
    const discovery = await empty.discover();
    expect(discovery).toMatchObject({ status: "available", tableCount: 0, truncated: false });
    expect(discovery.detail).toContain("no user tables");
    await expect(empty.testConnection()).resolves.toMatchObject({ ok: true, status: "connected", tableCount: 0 });

    const malformed = database([response([ok(executed(["name", "type", "wr"], [[text("items"), text("bogus"), integer(0)]]))])], []);
    await expect(malformed.discover()).resolves.toMatchObject({ status: "unavailable", reason: "malformed-metadata" });
  });

  it("truncates the table inventory explicitly and never presents it as empty", async () => {
    const db = database([
      response([ok(executed(["name", "type", "wr"], [
        [text("a"), text("table"), integer(0)],
        [text("b"), text("table"), integer(0)],
        [text("c"), text("table"), integer(0)],
      ]))]),
      response([
        ok(executed(["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], [[integer(0), text("id"), text("INTEGER"), integer(0), nullValue(), integer(1), integer(0)]])),
        ok(executed(["index_name", "is_unique", "origin", "partial", "seqno", "column_name"], [])),
        ok(executed(["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], [[integer(0), text("id"), text("INTEGER"), integer(0), nullValue(), integer(1), integer(0)]])),
        ok(executed(["index_name", "is_unique", "origin", "partial", "seqno", "column_name"], [])),
      ]),
    ], [], { maxMetadataTables: 2 });
    const discovery = await db.discover();
    expect(discovery).toMatchObject({ status: "available", tableCount: 2, truncated: true, omittedTables: 1 });
    expect(discovery.tables.map((table) => table.name)).toEqual(["a", "b"]);
  });
});

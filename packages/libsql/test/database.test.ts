import { AlreadyExistsError, collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { LibSQLDatabase, type LibSQLDatabaseOptions } from "../src/index.js";

interface Call { readonly url: string; readonly init: RequestInit | undefined; }

function response(result: unknown, status = 200, headers: HeadersInit = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(result), { status, headers });
}

function statement(columns: readonly string[], rows: readonly (readonly unknown[])[], affected = 0): unknown {
  return {
    baton: null,
    base_url: null,
    results: [
      { type: "ok", response: { type: "execute", result: { cols: columns.map((name) => ({ name })), rows, affected_row_count: affected } } },
      { type: "ok", response: { type: "close" } },
    ],
  };
}

const projection = ["__dalgo_key", "title", "rank"];
const one = [{ type: "text", value: "one" }, { type: "text", value: "Milk" }, { type: "integer", value: "10" }];
const two = [{ type: "text", value: "two" }, { type: "text", value: "Tea" }, { type: "integer", value: "11" }];

function database(responses: readonly Response[], calls: Call[], overrides: Partial<LibSQLDatabaseOptions> = {}): LibSQLDatabase {
  return new LibSQLDatabase({
    serverUrl: "https://libsql.example.test",
    headers: () => ({ authorization: "Bearer rotating-token", "x-deployment-header": "example" }),
    maxRows: 10,
    maxResponseBytes: 10_000,
    timeoutMs: 1_000,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error("unexpected fetch");
      return next;
    },
    tables: {
      items: {
        table: "items",
        uniqueKey: true,
        keyColumn: { column: "id", nullable: false },
        columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
      },
    },
    ...overrides,
  });
}

function request(call: Call | undefined): { readonly sql: string; readonly args: readonly { readonly type: string; readonly value?: unknown }[]; readonly wantRows: boolean } {
  const body = JSON.parse(String(call?.init?.body)) as { requests: readonly { readonly stmt: { readonly sql: string; readonly args: readonly { readonly type: string; readonly value?: unknown }[]; readonly want_rows: boolean } }[] };
  const statementRequest = body.requests[0]?.stmt;
  if (statementRequest === undefined) throw new Error("pipeline execute request missing");
  return { sql: statementRequest.sql, args: statementRequest.args, wantRows: statementRequest.want_rows };
}

describe("LibSQLDatabase", () => {
  it("uses one close-ended v3 pipeline with header injection and positional parameter binding", async () => {
    const calls: Call[] = [];
    const db = database([response(statement(projection, [one, two]))], calls);
    const items = collection<{ title: string; rank: number }>("items");
    const page = await db.query(items.query().where("rank", ">=", 10).orderBy("rank").limit(1).build());

    expect(page.records).toEqual([{ key: items.key("one"), exists: true, data: { title: "Milk", rank: 10 } }]);
    expect(page.nextCursor).toEqual({ values: [10, "one"] });
    expect(calls[0]?.url).toBe("https://libsql.example.test/v3/pipeline");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer rotating-token", "x-deployment-header": "example", accept: "application/json", "content-type": "application/json" });
    expect(calls[0]?.init?.redirect).toBe("error");
    const sent = request(calls[0]);
    expect(sent.sql).toContain('t."rank" >= ?');
    expect(sent.sql).toContain('ORDER BY t."rank" ASC, t."id" ASC LIMIT 2');
    expect(sent.args).toEqual([{ type: "integer", value: "10" }]);
    expect(sent.wantRows).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ baton: null, requests: [{ type: "execute" }, { type: "close" }] });
  });

  it("supports point reads, missing snapshots, and bounded getMany", async () => {
    const calls: Call[] = [];
    const db = database([response(statement(projection, [one])), response(statement(projection, [])), response(statement(projection, [one])), response(statement(projection, []))], calls);
    const items = collection<{ title: string; rank: number }>("items");
    await expect(db.get(items.key("one"))).resolves.toEqual({ key: items.key("one"), exists: true, data: { title: "Milk", rank: 10 } });
    await expect(db.get(items.key("none"))).resolves.toEqual({ key: items.key("none"), exists: false });
    await expect(db.getMany([items.key("one"), items.key("none")])).resolves.toEqual([
      { key: items.key("one"), exists: true, data: { title: "Milk", rank: 10 } }, { key: items.key("none"), exists: false },
    ]);
    expect(request(calls[0]).args).toEqual([{ type: "text", value: "one" }]);
  });

  it("performs parameterized CRUD only with an explicitly unique key mapping", async () => {
    const calls: Call[] = [];
    const db = database([response(statement([], [], 1)), response(statement([], [], 1)), response(statement([], [], 1)), response(statement([], [], 1))], calls);
    const items = collection<{ title: string; rank: number }>("items");
    await db.insert(items.key("one"), { title: "Milk", rank: 10 });
    await db.set(items.key("one"), { title: "Tea", rank: 11 });
    await db.update(items.key("one"), { title: "Coffee" });
    await db.delete(items.key("one"));

    expect(request(calls[0]).sql).toContain('INSERT INTO "items" ("id", "title", "rank") VALUES (?, ?, ?)');
    expect(request(calls[0]).args).toEqual([{ type: "text", value: "one" }, { type: "text", value: "Milk" }, { type: "integer", value: "10" }]);
    expect(request(calls[1]).sql).toContain('ON CONFLICT("id") DO UPDATE SET "title" = excluded."title", "rank" = excluded."rank"');
    expect(request(calls[2]).sql).toContain('UPDATE "items" SET "title" = ? WHERE "id" = ?');
    expect(request(calls[3]).sql).toContain('DELETE FROM "items" WHERE "id" = ?');
    expect(request(calls[1]).wantRows).toBe(false);

    const blocked = database([], [], { tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } } });
    await expect(blocked.insert(items.key("one"), { title: "Milk", rank: 10 })).rejects.toThrow("uniqueKey: true");
  });

  it("maps only unique and primary-key insert constraint codes to AlreadyExistsError", async () => {
    const calls: Call[] = [];
    const duplicate = {
      baton: null,
      results: [
        { type: "error", error: { code: "SQLITE_CONSTRAINT", extended_code: "SQLITE_CONSTRAINT_UNIQUE", message: "do not expose me" } },
        { type: "ok", response: { type: "close" } },
      ],
    };
    const db = database([response(duplicate)], calls);
    const items = collection<{ title: string; rank: number }>("items");
    await expect(db.insert(items.key("one"), { title: "Milk", rank: 10 })).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("rejects unproven transactions, invalid mappings, and responses without leaking bodies or server messages", async () => {
    const calls: Call[] = [];
    const db = database([response({ error: "secret HTTP error body" }, 403), response({ baton: null, results: [{ type: "error", error: { code: "SQLITE_CONSTRAINT", message: "secret SQL text" } }, { type: "ok", response: { type: "close" } }] })], calls);
    const items = collection<{ title: string; rank: number }>("items");
    await expect(db.get(items.key("one"))).rejects.toEqual(expect.objectContaining({ name: "LibSQLHttpError", status: 403 }));
    const failure = await db.get(items.key("one")).catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ name: "LibSQLPipelineError", code: "SQLITE_CONSTRAINT" }));
    expect(String(failure)).not.toContain("secret SQL text");
    await expect(db.runReadwriteTransaction(async () => "nope")).rejects.toThrow("not implemented");
    expect(calls).toHaveLength(2);

    expect(() => database([], [], { serverUrl: "http://libsql.example.test" })).toThrow("HTTPS");
    expect(() => database([], [], { tables: { items: { table: "items; DROP", keyColumn: { column: "id" }, columns: {} } } })).toThrow("identifier");
  });

  it("bounds response size and rejects unsafe integer results and ambiguous paging", async () => {
    const items = collection<{ title: string; rank: number }>("items");
    const oversized = database([response(statement(projection, [one]), 200, { "content-length": "10001" })], []);
    await expect(oversized.get(items.key("one"))).rejects.toThrow("maxResponseBytes");
    const unsafe = database([response(statement(projection, [[one[0], one[1], { type: "integer", value: "9007199254740992" }]]))], []);
    await expect(unsafe.get(items.key("one"))).rejects.toThrow("safe-integer");
    const ambiguous = database([], [], { tables: { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" }, rank: { column: "rank", nullable: false } } } } });
    await expect(ambiguous.query(items.query().orderBy("title").limit(1).build())).rejects.toThrow("nullable: false");
    await expect(ambiguous.query(items.query().offset(1).build())).rejects.toThrow("offsets");
  });

  it("emits cursors only for explicit, deterministic orders and binds descending multi-column cursors", async () => {
    const calls: Call[] = [];
    const db = database([response(statement(projection, [one, two])), response(statement(projection, []))], calls);
    const items = collection<{ title: string; rank: number }>("items");
    const unordered = await db.query(items.query().limit(1).build());
    expect(unordered.nextCursor).toBeUndefined();

    await db.query(items.query().orderBy("rank", "desc").orderBy("title", "asc").startAfter(11, "Tea", "two").limit(1).build());
    const sent = request(calls[1]);
    expect(sent.sql).toContain('ORDER BY t."rank" DESC, t."title" ASC, t."id" ASC');
    expect(sent.sql).toContain('((t."rank" < ?) OR (t."rank" = ? AND t."title" > ?) OR (t."rank" = ? AND t."title" = ? AND t."id" > ?))');
    expect(sent.args).toEqual([
      { type: "integer", value: "11" }, { type: "integer", value: "11" }, { type: "text", value: "Tea" },
      { type: "integer", value: "11" }, { type: "text", value: "Tea" }, { type: "text", value: "two" },
    ]);
  });

  it("rejects empty projections, unsafe integral inputs, malformed close responses, and deadline escapes", async () => {
    const items = collection<{ title: string; rank: number }>("items");
    expect(() => database([], [], { tables: { items: { table: "items", keyColumn: { column: "id" }, columns: {} } } })).toThrow("at least one");

    const unsafeInput = database([], []);
    await expect(unsafeInput.query(items.query().where("rank", "==", 9_007_199_254_740_992).build())).rejects.toThrow("safe integers");
    await expect(unsafeInput.update(items.key("one"), { rank: 9_007_199_254_740_992 })).rejects.toThrow("safe integers");
    await expect(unsafeInput.query(items.query().orderBy("rank").startAfter(9_007_199_254_740_992, "one").build())).rejects.toThrow("safe integers");

    const malformed = database([response({ baton: "not-null", results: [{ type: "ok", response: { type: "execute", result: { cols: [], rows: [] } }, }, { type: "ok", response: { type: "not-close" } }] })], []);
    await expect(malformed.get(items.key("one"))).rejects.toThrow("baton");

    const badClose = database([response({ baton: null, results: [{ type: "ok", response: { type: "execute", result: { cols: [], rows: [] } }, }, { type: "ok", response: { type: "not-close" } }] })], []);
    await expect(badClose.get(items.key("one"))).rejects.toThrow("close");

    const timedOut = database([], [], {
      timeoutMs: 1,
      headers: async () => new Promise<Readonly<Record<string, string>>>(() => undefined),
    });
    await expect(timedOut.get(items.key("one"))).rejects.toThrow("configured timeout");
  });

  it("bounds the header provider, fetch, and body read without exposing remote parsing failures", async () => {
    const items = collection<{ title: string; rank: number }>("items");
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
    const fetchTimedOut = database([], [], { timeoutMs: 5, fetch: () => never<Response>() });
    await expect(fetchTimedOut.get(items.key("one"))).rejects.toThrow("configured timeout");

    const pendingBody = new Response(new ReadableStream<Uint8Array>({ pull: () => never<void>() }));
    const bodyTimedOut = database([], [], { timeoutMs: 5, fetch: async () => pendingBody });
    await expect(bodyTimedOut.get(items.key("one"))).rejects.toThrow("configured timeout");

    const malformedJson = database([new Response("secret non-JSON server response")], []);
    const failure = await malformedJson.get(items.key("one")).catch((error: unknown) => error);
    expect(String(failure)).not.toContain("secret non-JSON");
    expect(failure).not.toHaveProperty("cause");
  });
});

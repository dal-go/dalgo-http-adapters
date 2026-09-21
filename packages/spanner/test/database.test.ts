import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { SpannerDatabase, type SpannerDatabaseOptions } from "../src/index.js";

interface Call { readonly url: string; readonly init: RequestInit | undefined; }
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function database(responses: readonly Response[], calls: Call[], overrides: Partial<SpannerDatabaseOptions> = {}): SpannerDatabase {
  return new SpannerDatabase({ projectId: "project", instanceId: "instance", databaseId: "database", accessToken: () => "rotating-token", timeoutMs: 1_000, maxRows: 5,
    tables: { items: { table: "Items", keyColumn: { column: "ItemId", type: "STRING", nullable: false }, columns: { title: { column: "Title", type: "STRING" }, done: { column: "Done", type: "BOOL" } } } },
    fetch: async (input, init) => { calls.push({ url: String(input), init }); const next = responses[calls.length - 1]; if (next === undefined) throw new Error("unexpected fetch"); return next; }, ...overrides });
}
const session = { name: "projects/project/instances/instance/databases/database/sessions/session1" };
const rows = { metadata: { rowType: { fields: [{ name: "__dalgo_key", type: { code: "STRING" } }, { name: "title", type: { code: "STRING" } }, { name: "done", type: { code: "BOOL" } }] } }, rows: [["one", "Milk", false]] };

describe("SpannerDatabase", () => {
  it("uses a session and parameterized SQL for a bounded point read", async () => {
    const calls: Call[] = []; const db = database([response(session), response(rows), response({})], calls); const items = collection<{ title: string; done: boolean }>("items");
    await expect(db.get(items.key("one"))).resolves.toEqual({ key: items.key("one"), exists: true, data: { title: "Milk", done: false } });
    expect(calls[0]?.url).toBe("https://spanner.googleapis.com/v1/projects/project/instances/instance/databases/database/sessions");
    expect(calls[1]?.url).toContain("/sessions/session1:executeSql");
    expect(calls[1]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ session: {} });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ params: { key: "one" }, paramTypes: { key: { code: "STRING" } } });
    expect(String(calls[1]?.init?.body)).toContain("WHERE `ItemId` = @key");
  });
  it("uses native atomic mutations and rejects incomplete replacement", async () => {
    const calls: Call[] = []; const db = database([response(session), response({ commitTimestamp: "2026-01-01T00:00:00Z" }), response({})], calls); const items = collection<{ title: string; done: boolean }>("items");
    await db.insert(items.key("one"), { title: "Milk", done: false });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ singleUseTransaction: { readWrite: {} }, mutations: [{ insert: { table: "Items", columns: ["ItemId", "Title", "Done"], values: [["one", "Milk", false]] } }] });
    await expect(db.set(items.key("one"), { title: "Milk" } as { title: string; done: boolean })).rejects.toThrow("every mapped");
  });
  it("redacts failed HTTP response bodies", async () => {
    const missingCalls: Call[] = []; const missing = database([response(session), response({ secret: "no" }, 404), response({})], missingCalls); const items = collection<{ title: string }>("items");
    await expect(missing.get(items.key("one"))).rejects.toMatchObject({ name: "SpannerHttpError", status: 404 });
    const conflictCalls: Call[] = []; const conflict = database([response(session), response({ secret: "no" }, 409), response({})], conflictCalls);
    await expect(conflict.insert(items.key("one"), { title: "Milk", done: false })).rejects.toMatchObject({ name: "AlreadyExistsError" });
  });
  it("rejects unsupported cursor/transaction semantics before a network request", async () => {
    const calls: Call[] = []; const db = database([], calls); const items = collection<{ title: string }>("items");
    await expect(db.query(items.query().orderBy("title").startAfter("Milk", "one").build())).rejects.toThrow("cursors");
    await expect(db.runReadwriteTransaction(async () => "no")).rejects.toThrow("callback transactions");
    expect(calls).toHaveLength(0);
  });
  it("validates result metadata and decodes INT64 and JSON wire values", async () => {
    const calls: Call[] = [];
    const typed = { metadata: { rowType: { fields: [{ name: "__dalgo_key", type: { code: "INT64" } }, { name: "count", type: { code: "INT64" } }, { name: "payload", type: { code: "JSON" } }] } }, rows: [["9007199254740993", "42", "{\"ok\":true}"]] };
    const db = database([response(session), response(typed), response({})], calls, { tables: { items: { table: "Items", keyColumn: { column: "ItemId", type: "INT64", nullable: false }, columns: { count: { column: "Count", type: "INT64" }, payload: { column: "Payload", type: "JSON" } } } } });
    const items = collection<{ count: string; payload: { ok: boolean } }>("items");
    await expect(db.query(items.query().limit(1).build())).resolves.toMatchObject({ records: [{ key: items.key("9007199254740993"), data: { count: "42", payload: { ok: true } } }] });
    const bad = database([response(session), response({ ...typed, metadata: { rowType: { fields: [{ name: "__dalgo_key", type: { code: "INT64" } }, { name: "count", type: { code: "STRING" } }, { name: "payload", type: { code: "JSON" } }] } } }), response({})], []);
    await expect(bad.get(items.key("42"))).rejects.toThrow("projection");
  });
  it("rejects a query that needs continuation and malformed commit responses", async () => {
    const calls: Call[] = [];
    const twoRows = { ...rows, rows: [["one", "Milk", false], ["two", "Tea", true]] };
    const db = database([response(session), response(twoRows), response({})], calls); const items = collection<{ title: string; done: boolean }>("items");
    await expect(db.query(items.query().limit(1).build())).rejects.toThrow("continuation");
    const badCommit = database([response(session), response({}), response({})], []);
    await expect(badCommit.delete(items.key("one"))).rejects.toThrow("commit response");
  });
  it("bounds streamed response reads before parsing", async () => {
    const calls: Call[] = [];
    const oversized = new Response("{}", { headers: { "content-type": "application/json", "content-length": "99" } });
    const db = database([response(session), oversized, response({})], calls, { maxResponseBytes: 4 });
    const items = collection<{ title: string }>("items");
    await expect(db.get(items.key("one"))).rejects.toMatchObject({ name: "SpannerRequestError" });
  });
});

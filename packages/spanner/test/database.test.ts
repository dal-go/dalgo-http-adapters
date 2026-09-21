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
const rows = { metadata: { rowType: { fields: [{ name: "__dalgo_key" }, { name: "title" }, { name: "done" }] } }, rows: [["one", "Milk", false]] };

describe("SpannerDatabase", () => {
  it("uses a session and parameterized SQL for a bounded point read", async () => {
    const calls: Call[] = []; const db = database([response(session), response(rows), response({})], calls); const items = collection<{ title: string; done: boolean }>("items");
    await expect(db.get(items.key("one"))).resolves.toEqual({ key: items.key("one"), exists: true, data: { title: "Milk", done: false } });
    expect(calls[0]?.url).toBe("https://spanner.googleapis.com/v1/projects/project/instances/instance/databases/database/sessions");
    expect(calls[1]?.url).toContain("/sessions/session1:executeSql");
    expect(calls[1]?.init?.redirect).toBe("error");
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
});

import { ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { RdsDataDatabase } from "../src/index.js";

const table = { schema: "public", table: "todos", keyColumn: "id", keyType: "integer", uniqueKey: true, columns: { title: "title", done: "done" } } as const;
const metadata = [{ name: "__dalgo_key" }, { name: "title" }, { name: "done" }];
function db(responses: unknown[], overrides: Partial<ConstructorParameters<typeof RdsDataDatabase>[0]> = {}): { readonly database: RdsDataDatabase; readonly commands: unknown[] } {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown): Promise<unknown> => { commands.push(command); const output = responses.shift(); if (output instanceof Error) throw output; return output; } };
  return { database: new RdsDataDatabase({ client: client as never, resourceArn: "arn:aws:rds:eu-west-1:123:cluster:db", secretArn: "arn:aws:secretsmanager:eu-west-1:123:secret:db", dialect: "postgresql", tables: { todos: table }, ...overrides }), commands };
}
const row = [{ longValue: 1 }, { stringValue: "first" }, { booleanValue: false }];

describe("RdsDataDatabase", () => {
  it("queries an explicit mapped projection with bound values", async () => {
    const fixture = db([{ columnMetadata: metadata, records: [row] }]);
    await expect(fixture.database.query(collection("todos").query().where("title", "==", "a'quoted").limit(1).build())).resolves.toEqual({ records: [{ key: key("todos", 1), exists: true, data: { title: "first", done: false } }] });
    const command = fixture.commands[0] as ExecuteStatementCommand;
    expect(command.input.sql).toContain('FROM "public"."todos"');
    expect(command.input.sql).not.toContain("quoted");
    expect(command.input.parameters).toEqual([{ name: "p0", value: { stringValue: "a'quoted" } }]);
    expect(command.input.includeResultMetadata).toBe(true);
  });

  it("uses MySQL backtick quoting and honors limit and offset", async () => {
    const fixture = db([{ columnMetadata: metadata, records: [] }], { dialect: "mysql" });
    await fixture.database.query(collection("todos").query().limit(1).offset(2).build());
    expect((fixture.commands[0] as ExecuteStatementCommand).input.sql).toContain("FROM `public`.`todos`");
    expect((fixture.commands[0] as ExecuteStatementCommand).input.sql).toContain("LIMIT 1 OFFSET 2");
  });

  it("returns a missing snapshot and rejects mismatched point reads", async () => {
    await expect(db([{ columnMetadata: metadata, records: [] }]).database.get(key("todos", 1))).resolves.toEqual({ key: key("todos", 1), exists: false });
    await expect(db([{ columnMetadata: metadata, records: [[{ longValue: 2 }, { stringValue: "no" }, { booleanValue: false }]] }]).database.get(key("todos", 1))).rejects.toThrow("requested key");
  });

  it("writes only through confirmed unique key mappings and validates affected rows", async () => {
    const inserted = db([{ numberOfRecordsUpdated: 1 }]);
    await inserted.database.insert(key("todos", 1), { title: "new", done: false });
    const insert = inserted.commands[0] as ExecuteStatementCommand;
    expect(insert.input.sql).toContain("INSERT INTO");
    expect(insert.input.parameters).toEqual([{ name: "key", value: { longValue: 1 } }, { name: "vtitle", value: { stringValue: "new" } }, { name: "vdone", value: { booleanValue: false } }]);
    await expect(db([], { tables: { todos: { ...table, uniqueKey: false } } }).database.delete(key("todos", 1))).rejects.toThrow(UnsupportedError);
    await expect(db([{ numberOfRecordsUpdated: 2 }]).database.delete(key("todos", 1))).rejects.toThrow("multiple");
  });

  it("keeps dialect-dependent set and callback transactions explicitly unsupported", async () => {
    const subject = db([]).database;
    await expect(subject.set(key("todos", 1), { title: "x", done: false })).rejects.toThrow(UnsupportedError);
    await expect(subject.runReadwriteTransaction(async () => "no")).rejects.toThrow(UnsupportedError);
  });

  it("bounds operations before a request and rejects unsafe keys/results", async () => {
    const fixture = db([], { maxGetManyKeys: 1 });
    await expect(fixture.database.getMany([key("todos", 1), key("todos", 2)])).rejects.toThrow(UnsupportedError);
    expect(fixture.commands).toHaveLength(0);
    await expect(db([]).database.get(key("todos", Number.MAX_SAFE_INTEGER + 1))).rejects.toThrow("key type mismatch");
    await expect(db([{ columnMetadata: metadata, records: [[{ longValue: Number.MAX_SAFE_INTEGER + 1 }, { stringValue: "x" }, { booleanValue: true }]] }]).database.query(collection("todos").query().build())).rejects.toThrow("invalid field union variant");
  });

  it("fails closed on malformed metadata, malformed field unions, and redacts service errors", async () => {
    await expect(db([{ columnMetadata: [], records: [] }]).database.query(collection("todos").query().build())).rejects.toThrow("metadata");
    await expect(db([{ columnMetadata: metadata, records: [[{ longValue: 1, stringValue: "x" }, { stringValue: "x" }, { booleanValue: true }]] }]).database.query(collection("todos").query().build())).rejects.toThrow("field union");
    try { await db([new Error("server SQL secret")]).database.get(key("todos", 1)); } catch (error) { expect(String(error)).toContain("request failed"); expect(String(error)).not.toContain("secret"); }
  });

  it("aborts a non-responsive SDK call at the configured deadline", async () => {
    const client = { send: async (): Promise<never> => new Promise<never>(() => {}) };
    const subject = new RdsDataDatabase({ client: client as never, resourceArn: "cluster", secretArn: "secret", dialect: "postgresql", tables: { todos: table }, timeoutMs: 1 });
    await expect(subject.get(key("todos", 1))).rejects.toThrow("exceeded timeout");
  });
});

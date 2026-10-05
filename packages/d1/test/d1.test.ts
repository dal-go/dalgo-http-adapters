import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { executeJoinedDTQLQuery, isJoinedDTQLQuery, Key, parseDTQL } from "@dalgo/core";
import { D1HttpDatabase, D1QueryDatabase, compileD1Query, createD1ReadHandler, type D1Binding, type D1PreparedStatement, type D1Table } from "../src/index.js";

type Row = Readonly<Record<string, unknown>>;
interface FixtureState { readonly tables: Readonly<Record<string, readonly Row[]>>; readonly calls: { sql: string; args: readonly unknown[] }[]; }

class FixtureStatement implements D1PreparedStatement {
  readonly #state: FixtureState;
  readonly #sql: string;
  readonly #args: readonly unknown[];
  public constructor(state: FixtureState, sql: string, args: readonly unknown[] = []) { this.#state = state; this.#sql = sql; this.#args = args; }
  public bind(...values: (string | number | null | ArrayBuffer | ArrayBufferView)[]): D1PreparedStatement { return new FixtureStatement(this.#state, this.#sql, values); }
  public all(): Promise<{ readonly results: readonly Row[]; readonly success: boolean }> {
    this.#state.calls.push({ sql: this.#sql, args: this.#args });
    const tableMatch = /FROM "([A-Za-z_][A-Za-z0-9_]*)" AS t/u.exec(this.#sql);
    const table = tableMatch?.[1];
    if (table === undefined) throw new Error("fixture received non-generated SQL");
    const selected = [...this.#sql.matchAll(/ AS "([A-Za-z_][A-Za-z0-9_]*)"/gu)].map((item) => item[1]).filter((field): field is string => field !== undefined);
    let rows = [...(this.#state.tables[table] ?? [])];
    const where = this.#sql.split(" WHERE ")[1]?.split(" ORDER BY ")[0]?.split(" LIMIT ")[0];
    if (where !== undefined) {
      const conditions = [...where.matchAll(/t\."([A-Za-z_][A-Za-z0-9_]*)" (=|!=|<|<=|>|>=|IS NULL|IS NOT NULL|IN|NOT IN)(?: \?| \(([^)]*)\))?/gu)];
      let argument = 0;
      for (const condition of conditions) {
        const field = condition[1];
        const operator = condition[2];
        if (field === undefined || operator === undefined) continue;
        if (operator === "IS NULL") { rows = rows.filter((row) => row[field] === null); continue; }
        if (operator === "IS NOT NULL") { rows = rows.filter((row) => row[field] !== null); continue; }
        if (operator === "IN" || operator === "NOT IN") {
          const count = condition[3]?.split(",").length ?? 0;
          const values = this.#args.slice(argument, argument + count);
          argument += count;
          rows = rows.filter((row) => (values.some((value) => Object.is(row[field], value))) === (operator === "IN"));
          continue;
        }
        const value = this.#args[argument];
        argument += 1;
        rows = rows.filter((row) => {
          const actual = row[field];
          switch (operator) {
            case "=": return Object.is(actual, value);
            case "!=": return actual !== null && !Object.is(actual, value);
            case "<": return typeof actual === "number" && typeof value === "number" && actual < value;
            case "<=": return typeof actual === "number" && typeof value === "number" && actual <= value;
            case ">": return typeof actual === "number" && typeof value === "number" && actual > value;
            case ">=": return typeof actual === "number" && typeof value === "number" && actual >= value;
            default: return false;
          }
        });
      }
    }
    const order = this.#sql.split(" ORDER BY ")[1]?.split(" LIMIT ")[0];
    if (order !== undefined) {
      const fields = [...order.matchAll(/t\."([A-Za-z_][A-Za-z0-9_]*)" (ASC|DESC)/gu)];
      rows.sort((left, right) => {
        for (const item of fields) {
          const field = item[1];
          if (field === undefined) continue;
          const a = left[field]; const b = right[field];
          if (Object.is(a, b)) continue;
          const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
          return item[2] === "DESC" ? -comparison : comparison;
        }
        return 0;
      });
    }
    const paging = /LIMIT (\d+) OFFSET (\d+)$/u.exec(this.#sql);
    const limit = Number(paging?.[1] ?? rows.length);
    const offset = Number(paging?.[2] ?? 0);
    return Promise.resolve({ success: true, results: rows.slice(offset, offset + limit).map((row) => Object.fromEntries(selected.map((field) => [field, row[field]]))) });
  }
}

class FixtureD1 implements D1Binding {
  readonly state: FixtureState;
  public constructor(tables: FixtureState["tables"]) { this.state = { tables, calls: [] }; }
  public prepare(sql: string): D1PreparedStatement { return new FixtureStatement(this.state, sql); }
}

const schema: Readonly<Record<string, D1Table>> = {
  Items: { table: "items", primaryKey: ["id"], columns: { id: { column: "id" }, groupId: { column: "group_id" }, amount: { column: "amount" }, label: { column: "label" }, nullable: { column: "nullable" }, payload: { column: "payload" } } },
  Groups: { table: "groups", primaryKey: ["id"], columns: { id: { column: "id" }, name: { column: "name" } } },
  Pairs: { table: "pairs", primaryKey: ["a", "b"], columns: { a: { column: "a" }, b: { column: "b" }, value: { column: "value" } } },
  ItemsView: { table: "items_view", primaryKey: [], columns: { label: { column: "label" }, amount: { column: "amount" } } },
};
const itemsTable = schema.Items;
if (itemsTable === undefined) throw new Error("Items fixture schema missing");

const items = Array.from({ length: 251 }, (_, index) => ({ id: index + 1, groupId: index % 2, amount: index + 1, label: `item-${String(index + 1)}`, nullable: index === 0 ? null : "present", payload: new Uint8Array([index % 256, 0, 255]) }));
const groups = [{ id: 0, name: "even" }, { id: 1, name: "odd" }];
const fixture = (): FixtureD1 => new FixtureD1({ items, groups, pairs: [{ a: "x", b: 7, value: "pair" }], items_view: items.map(({ label, amount }) => ({ label, amount })) });

class SQLiteStatement implements D1PreparedStatement {
  readonly #database: DatabaseSync;
  readonly #sql: string;
  readonly #values: readonly (string | number | null | ArrayBuffer | ArrayBufferView)[];
  public constructor(database: DatabaseSync, sql: string, values: readonly (string | number | null | ArrayBuffer | ArrayBufferView)[] = []) {
    this.#database = database;
    this.#sql = sql;
    this.#values = values;
  }
  public bind(...values: (string | number | null | ArrayBuffer | ArrayBufferView)[]): D1PreparedStatement { return new SQLiteStatement(this.#database, this.#sql, values); }
  public all(): Promise<{ readonly results: readonly Row[]; readonly success: boolean }> {
    const values = this.#values.map((value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
      if (ArrayBuffer.isView(value)) {
        const copy = new Uint8Array(value.byteLength);
        copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        return copy;
      }
      return value;
    });
    const results = this.#database.prepare(this.#sql).all(...values).map((row) => ({ ...row }));
    return Promise.resolve({ results, success: true });
  }
}

class SQLiteD1 implements D1Binding {
  readonly #database: DatabaseSync;
  public constructor(database: DatabaseSync) { this.#database = database; }
  public prepare(sql: string): D1PreparedStatement { return new SQLiteStatement(this.#database, sql); }
}

describe("D1 adapter", () => {
  it("executes generated SQL against SQLite for physical mapping, spaced names, BLOBs, keyless views, and joined aggregates", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec('CREATE TABLE "Order Details" ("Order ID" INTEGER NOT NULL, "Product ID" INTEGER NOT NULL, "Group ID" INTEGER NOT NULL, "Quantity" INTEGER NOT NULL, "Nullable" TEXT, "Payload" BLOB, PRIMARY KEY ("Order ID", "Product ID"));');
      sqlite.exec('CREATE TABLE "Groups" ("Group ID" INTEGER PRIMARY KEY, "Group Name" TEXT NOT NULL);');
      sqlite.exec('CREATE VIEW "Orders Qry" AS SELECT "Order ID", "Product ID", "Quantity" FROM "Order Details";');
      const insertItem = sqlite.prepare('INSERT INTO "Order Details" VALUES (?, ?, ?, ?, ?, ?)');
      for (const group of groups) sqlite.prepare('INSERT INTO "Groups" VALUES (?, ?)').run(group.id, group.name);
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined) throw new Error("SQLite test item missing");
        insertItem.run(index + 1, index % 3, item.groupId, item.amount, item.nullable, item.payload);
      }
      const tables = {
        OrderDetails: { table: "Order Details", primaryKey: ["orderId", "productId"], columns: {
          orderId: { column: "Order ID" }, productId: { column: "Product ID" }, groupId: { column: "Group ID" },
          quantity: { column: "Quantity" }, nullable: { column: "Nullable" }, payload: { column: "Payload" },
        } },
        Groups: { table: "Groups", primaryKey: ["groupId"], columns: { groupId: { column: "Group ID" }, name: { column: "Group Name" } } },
        OrdersQry: { table: "Orders Qry", primaryKey: [], columns: { orderId: { column: "Order ID" }, productId: { column: "Product ID" }, quantity: { column: "Quantity" } } },
      } satisfies Readonly<Record<string, D1Table>>;
      const db = new D1QueryDatabase(new SQLiteD1(sqlite), { tables, maxQueryLimit: 100, scanPageSize: 80 });
      const composite = await db.get(new Key("OrderDetails", "[1,0]"));
      expect(composite).toMatchObject({ exists: true, data: { groupId: 0, quantity: 1, nullable: null, payload: new Uint8Array([0, 0, 255]) } });
      const blobFilter = await db.query({ source: { kind: "collection", name: "OrderDetails" }, filters: [{ field: "payload", operator: "==", value: new Uint8Array([0, 0, 255]) }], orders: [], limit: 1 });
      expect(blobFilter.records).toHaveLength(1);
      expect(blobFilter.records[0]?.key.id).toBe("[1,0]");
      const keyless = await db.query({ source: { kind: "collection", name: "OrdersQry" }, filters: [{ field: "orderId", operator: "==", value: 1 }], orders: [], limit: 1 });
      expect(keyless.records[0]?.data).toMatchObject({ orderId: 1, productId: 0, quantity: 1 });

      const document = {
        from: { name: "OrderDetails", alias: "i", joins: [{ from: { name: "Groups", alias: "g" }, on: [{ left: { field: "groupId", source: "i" }, op: "==", right: { field: "groupId", source: "g" } }] }] },
        groupBy: [{ field: "name", source: "g" }],
        columns: [
          { field: "name", source: "g", as: "group" },
          { aggregate: { function: "sum", args: [{ field: "quantity", source: "i" }] }, as: "total" },
          { aggregate: { function: "count", args: [{ star: true }] }, as: "rows" },
        ],
      };
      const parsed = parseDTQL(document, { tables: [
        { name: "OrderDetails", fields: ["orderId", "productId", "groupId", "quantity"] },
        { name: "Groups", fields: ["groupId", "name"] },
      ] });
      if (!isJoinedDTQLQuery(parsed)) throw new Error("expected SQLite-backed joined query");
      const result = await executeJoinedDTQLQuery(db, parsed, { resolveSource: (relation) => ({ kind: "collection", name: relation.name }) });
      expect(result.records.map((record) => record.data)).toEqual([
        { group: "even", total: 15_876, rows: 126 },
        { group: "odd", total: 15_750, rows: 125 },
      ]);

      const handle = createD1ReadHandler(new SQLiteD1(sqlite), {
        tables, path: "/northwind/d1/v1/query", metadataPath: "/northwind/d1/v1/metadata",
        schemaVersion: "northwind-v1", seedVersion: "seed-42",
      });
      const http = new D1HttpDatabase({
        baseUrl: "https://d1.test/northwind/d1", tables,
        expectedSchemaVersion: "northwind-v1", expectedSeedVersion: "seed-42", maxQueryLimit: 100, scanPageSize: 80,
        fetch: async (input, init) => handle(new Request(input, init)),
      });
      const httpBlob = await http.query({ source: { kind: "collection", name: "OrderDetails" }, filters: [{ field: "payload", operator: "==", value: new Uint8Array([0, 0, 255]) }], orders: [], limit: 1 });
      expect(httpBlob.records[0]?.key.id).toBe("[1,0]");
      const httpJoin = await executeJoinedDTQLQuery(http, parsed, { resolveSource: (relation) => ({ kind: "collection", name: relation.name }) });
      expect(httpJoin.records.map((record) => record.data)).toEqual(result.records.map((record) => record.data));
    } finally {
      sqlite.close();
    }
  });

  it("compiles bound scalar filters with configured identifiers only", () => {
    const compiled = compileD1Query(itemsTable, {
      source: { kind: "collection", name: "Items" }, filters: [{ field: "label", operator: "==", value: "x'); DROP TABLE items;--" }], orders: [],
    }, 5);
    expect(compiled.sql).toContain('FROM "items" AS t');
    expect(compiled.sql).not.toContain("DROP TABLE");
    expect(compiled.args).toEqual(["x'); DROP TABLE items;--"]);
  });

  it("validates mappings, rejects unsafe names and returns bounded pages and NULL/BLOB values", async () => {
    expect(() => new D1QueryDatabase(fixture(), { tables: { Items: { ...itemsTable, table: "items\u0000bad" } } })).toThrow(/configured SQLite identifier/u);
    const quoted = compileD1Query({ table: "Order Details", primaryKey: ["OrderID"], columns: { OrderID: { column: "Order ID" }, Quantity: { column: "Quantity" } } }, {
      source: { kind: "collection", name: "OrderDetails" }, filters: [], orders: [],
    }, 5);
    expect(quoted.sql).toContain('FROM "Order Details" AS t');
    expect(quoted.sql).toContain('"Order ID" AS "OrderID"');
    const binding = fixture();
    const db = new D1QueryDatabase(binding, { tables: schema, maxQueryLimit: 20, scanPageSize: 20 });
    const page = await db.query({ source: { kind: "collection", name: "Items" }, filters: [{ field: "nullable", operator: "==", value: null }], orders: [], limit: 2, offset: 0 });
    expect(page.records.map((record) => record.key.id)).toEqual([1]);
    expect(page.records[0]?.data).toMatchObject({ amount: 1, nullable: null, payload: new Uint8Array([0, 0, 255]) });
      expect(page.records[0]?.data).toMatchObject({ id: 1 });
    expect(binding.state.calls[0]?.args).toEqual([]);
    expect(binding.state.calls[0]?.sql).toContain("IS NULL");
  });

  it("reads composite keys and allows listing keyless views while rejecting get", async () => {
    const db = new D1QueryDatabase(fixture(), { tables: schema, maxQueryLimit: 25 });
    const pair = await db.get(new Key("Pairs", '["x",7]'));
    expect(pair).toMatchObject({ exists: true, data: { value: "pair" } });
    const view = await db.query({ source: { kind: "collection", name: "ItemsView" }, filters: [], orders: [], limit: 2 });
    expect(view.records.map((record) => record.data)).toEqual([{ label: "item-1", amount: 1 }, { label: "item-10", amount: 10 }]);
    await expect(db.get(new Key("ItemsView", "1"))).rejects.toThrow(/no primary key/u);
  });

  it("pages all leaf rows for the actual DALgo joined aggregate path above the default page size", async () => {
    const binding = fixture();
    const db = new D1QueryDatabase(binding, { tables: schema, maxQueryLimit: 100, scanPageSize: 80 });
    const document = {
      from: { name: "Items", alias: "i", joins: [{ from: { name: "Groups", alias: "g" }, on: [{ left: { field: "groupId", source: "i" }, op: "==", right: { field: "id", source: "g" } }] }] },
      groupBy: [{ field: "name", source: "g" }],
      columns: [
        { field: "name", source: "g", as: "group" },
        { aggregate: { function: "sum", args: [{ field: "amount", source: "i" }] }, as: "total" },
        { aggregate: { function: "count", args: [{ star: true }] }, as: "rows" },
      ],
    };
    const parsed = parseDTQL(document, { tables: [
      { name: "Items", fields: ["id", "groupId", "amount"] },
      { name: "Groups", fields: ["id", "name"] },
    ] });
    if (!isJoinedDTQLQuery(parsed)) throw new Error("expected joined query");
    const result = await executeJoinedDTQLQuery(db, parsed, { resolveSource: (relation) => ({ kind: "collection", name: relation.name }) });
    expect(result.records.map((record) => record.data)).toEqual([
      { group: "even", total: 15_876, rows: 126 },
      { group: "odd", total: 15_750, rows: 125 },
    ]);
    expect(binding.state.calls.filter(({ sql }) => sql.includes('FROM "items"')).length).toBeGreaterThan(1);
    const page150 = await db.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [], limit: 150 });
    expect(page150.records).toHaveLength(150);

    const httpBinding = fixture();
    const handle = createD1ReadHandler(httpBinding, { tables: schema, maxQueryLimit: 100 });
    const http = new D1HttpDatabase({
      baseUrl: "https://d1.test", tables: schema, maxQueryLimit: 100, scanPageSize: 80,
      fetch: async (input, init) => handle(new Request(input, init)),
    });
    const httpResult = await executeJoinedDTQLQuery(http, parsed, { resolveSource: (relation) => ({ kind: "collection", name: relation.name }) });
    expect(httpResult.records.map((record) => record.data)).toEqual(result.records.map((record) => record.data));
    expect(httpBinding.state.calls.filter(({ sql }) => sql.includes('FROM "items"')).length).toBeGreaterThan(1);
    const httpPage150 = await http.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [], limit: 150 });
    expect(httpPage150.records).toHaveLength(150);
  });

  it("fails instead of returning a partial scan when the configured row budget is exceeded", async () => {
    const db = new D1QueryDatabase(fixture(), { tables: schema, maxQueryLimit: 50, scanPageSize: 25, maxScanRows: 100 });
    await expect(db.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [] })).rejects.toThrow(/exceeds maxScanRows/u);
  });

  it("serves the versioned read protocol, BLOB codec, bounded errors, and version mismatch", async () => {
    const binding = fixture();
    const pairsTable = schema.Pairs;
    if (pairsTable === undefined) throw new Error("Pairs fixture schema missing");
    const tables = { Items: itemsTable, Pairs: pairsTable };
    const handler = createD1ReadHandler(binding, { tables, schemaVersion: "northwind-v1", seedVersion: "seed-42", allowedOrigins: ["https://example.test"], maxQueryLimit: 25 });
    const response = await handler(new Request("https://api.example.test/v1/query", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://example.test", "X-Dalgo-Schema-Version": "northwind-v1", "X-Dalgo-Seed-Version": "seed-42" },
      body: JSON.stringify({ version: 1, collection: "Items", filters: [{ field: "id", operator: "==", value: 1 }], limit: 2 }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
    expect(await response.json()).toMatchObject({ version: 1, primaryKey: ["id"], records: [{ id: 1, payload: { $type: "blob", base64: "AAD/" } }] });

    const blobFilter = await handler(new Request("https://api.example.test/v1/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, collection: "Items", filters: [{ field: "payload", operator: "==", value: { $type: "blob", base64: "AAD/" } }], limit: 2 }),
    }));
    expect(blobFilter.status).toBe(200);
    expect(binding.state.calls.at(-1)?.args[0]).toEqual(new Uint8Array([0, 0, 255]));

    const client = new D1HttpDatabase({
      baseUrl: "https://api.example.test", tables, expectedSchemaVersion: "northwind-v1", expectedSeedVersion: "seed-42",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    const record = await client.get(new Key("Items", 1));
    expect(record).toMatchObject({ exists: true, data: { amount: 1, nullable: null, payload: new Uint8Array([0, 0, 255]) } });
    const metadata = await client.metadata();
    expect(metadata).toMatchObject({ version: 1, schemaVersion: "northwind-v1", seedVersion: "seed-42" });

    const prefixedHandler = createD1ReadHandler(binding, {
      tables, path: "/northwind/d1/v1/query", metadataPath: "/northwind/d1/v1/metadata",
      schemaVersion: "northwind-v1", seedVersion: "seed-42",
    });
    const prefixed = new D1HttpDatabase({
      baseUrl: "https://api.example.test/northwind/d1", tables, expectedSchemaVersion: "northwind-v1", expectedSeedVersion: "seed-42",
      fetch: async (input, init) => prefixedHandler(new Request(input, init)),
    });
    expect((await prefixed.get(new Key("Items", 1))).exists).toBe(true);
    await prefixed.query({ source: { kind: "collection", name: "Items" }, filters: [{ field: "payload", operator: "==", value: new Uint8Array([0, 0, 255]) }], orders: [], limit: 2 });
    expect(binding.state.calls.at(-1)?.args[0]).toEqual(new Uint8Array([0, 0, 255]));
    expect((await prefixed.metadata()).seedVersion).toBe("seed-42");

    const mismatch = await handler(new Request("https://api.example.test/v1/metadata", { headers: { "X-Dalgo-Schema-Version": "old", "X-Dalgo-Seed-Version": "seed-42" } }));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: "version_mismatch" } });
    expect((await handler(new Request("https://api.example.test/v1/metadata"))).status).toBe(200);
    const malicious = await handler(new Request("https://api.example.test/v1/query", {
      method: "POST", headers: { "content-type": "application/json", "X-Dalgo-Schema-Version": "northwind-v1", "X-Dalgo-Seed-Version": "seed-42" },
      body: JSON.stringify({ version: 1, collection: "Items; DROP TABLE items;--", sql: "SELECT * FROM items" }),
    }));
    expect(malicious.status).toBe(400);
    const inheritedName = await handler(new Request("https://api.example.test/v1/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, collection: "toString", filters: [], limit: 1 }),
    }));
    expect(inheritedName.status).toBe(422);
    const maliciousOperator = await handler(new Request("https://api.example.test/v1/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, collection: "Items", filters: [{ field: "id", operator: "= 1; DROP TABLE items;--", value: 1 }], limit: 1 }),
    }));
    expect(maliciousOperator.status).toBe(400);
    expect(binding.state.calls.every(({ sql }) => !sql.includes("DROP TABLE"))).toBe(true);
  });

  it("rejects unsupported joins, malformed numbers, and projections before binding", async () => {
    const binding = fixture();
    const db = new D1QueryDatabase(binding, { tables: schema, maxQueryLimit: 10 });
    await expect(db.query({ source: { kind: "collection-group", name: "Items" }, filters: [], orders: [] })).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    const abortedHttp = new D1HttpDatabase({ baseUrl: "https://d1.test", tables: schema, signal: aborted.signal, fetch: () => Promise.reject(new Error("must not fetch")) });
    await expect(abortedHttp.metadata()).rejects.toThrow(/could not be completed/u);
    expect(() => compileD1Query(itemsTable, { source: { kind: "collection", name: "Items" }, filters: [{ field: "amount", operator: "==", value: 9_007_199_254_740_992 }], orders: [] }, 1)).toThrow(/safe integers/u);
    expect(() => compileD1Query(itemsTable, { source: { kind: "collection", name: "Items" }, filters: [{ field: "amount); DROP TABLE items;--", operator: "==", value: 1 }], orders: [] }, 1)).toThrow();
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ field: "amount", operator: "==" as const, value: index }));
    expect(() => compileD1Query(itemsTable, { source: { kind: "collection", name: "Items" }, filters: tooMany, orders: [] }, 1)).toThrow(/at most 100 bound values/u);
    expect(binding.state.calls).toHaveLength(0);

    const columns = Object.keys(itemsTable.columns);
    const fullWireRow = { id: 1, groupId: 0, amount: 1, label: { metadata: { source: "sqlite" } }, nullable: null, payload: { $type: "blob", base64: "AAD/" } };
    const fullResponse = { version: 1, columns, primaryKey: ["id"], records: [fullWireRow] };
    const objectClient = new D1HttpDatabase({ baseUrl: "https://d1.test", tables: schema, fetch: () => Promise.resolve(Response.json(fullResponse)) });
    const objectPage = await objectClient.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [], limit: 1 });
    expect(objectPage.records[0]?.data).toMatchObject({ label: { metadata: { source: "sqlite" } } });

    const partialClient = new D1HttpDatabase({ baseUrl: "https://d1.test", tables: schema, fetch: () => Promise.resolve(Response.json({ version: 1, columns: ["id"], primaryKey: ["id"], records: [{ id: 1 }] })) });
    await expect(partialClient.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [], limit: 1 })).rejects.toThrow(/projection/u);

    const taggedRow = { ...fullWireRow, payload: { $type: "other", base64: "AQ==" } };
    const taggedClient = new D1HttpDatabase({ baseUrl: "https://d1.test", tables: schema, fetch: () => Promise.resolve(Response.json({ ...fullResponse, records: [taggedRow] })) });
    await expect(taggedClient.query({ source: { kind: "collection", name: "Items" }, filters: [], orders: [], limit: 1 })).rejects.toThrow(/reserved wire tag/u);
  });
});

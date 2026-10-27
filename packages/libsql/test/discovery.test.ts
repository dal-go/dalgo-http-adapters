import { describe, expect, it } from "vitest";

import { LibSQLDatabase } from "../src/index.js";
import {
  executed,
  failed,
  integer,
  mockFetch,
  nullValue,
  ok,
  response,
  text,
  type Call,
} from "./helpers.js";

const COLUMNS = ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"];
const INDEXES = ["index_name", "is_unique", "origin", "partial", "seqno", "column_name"];

interface ColumnSpec {
  readonly name: string;
  readonly type?: string;
  readonly notNull?: boolean;
  readonly pk?: number;
  readonly defaultValue?: string | null;
  readonly hidden?: number;
}

interface IndexSpec {
  readonly name: string;
  readonly unique?: boolean;
  readonly partial?: boolean;
  readonly columns: readonly string[];
}

function columnRows(columns: readonly ColumnSpec[]): readonly (readonly unknown[])[] {
  return columns.map((column, cid) => [
    integer(cid),
    text(column.name),
    text(column.type ?? ""),
    integer(column.notNull === true ? 1 : 0),
    column.defaultValue === undefined || column.defaultValue === null ? nullValue() : text(column.defaultValue),
    integer(column.pk ?? 0),
    integer(column.hidden ?? 0),
  ]);
}

function indexRows(indexes: readonly IndexSpec[]): readonly (readonly unknown[])[] {
  return indexes.flatMap((index) => index.columns.map((column, seqno) => [
    text(index.name),
    integer(index.unique === false ? 0 : 1),
    text("c"),
    integer(index.partial === true ? 1 : 0),
    integer(seqno),
    integer(seqno),
    text(column),
  ]));
}

function discoveryResponses(
  tables: readonly {
    readonly name: string;
    readonly kind?: "table" | "view";
    readonly withoutRowid?: boolean;
    readonly columns: readonly ColumnSpec[];
    readonly indexes?: readonly IndexSpec[];
  }[],
  describeCount = tables.length,
): Response[] {
  const list = tables.map((table) => [text(table.name), text(table.kind ?? "table"), integer(table.withoutRowid === true ? 1 : 0)]);
  const parts: Record<string, unknown>[] = [];
  for (const table of tables.slice(0, describeCount)) {
    parts.push(ok(executed(COLUMNS, columnRows(table.columns))));
    parts.push(ok(executed(INDEXES, indexRows(table.indexes ?? []))));
  }
  return [
    response([ok(executed(["name", "type", "wr"], list))]),
    response(parts),
  ];
}

describe("libSQL bounded schema discovery", () => {
  it("proves a single non-null primary key and exposes declared type, affinity and defaults", async () => {
    const calls: Call[] = [];
    const db = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
      fetch: mockFetch(discoveryResponses([{
        name: "items",
        columns: [
          { name: "id", type: "INTEGER", pk: 1 },
          { name: "title", type: "TEXT(120)", notNull: true, defaultValue: "'x'" },
          { name: "rank", type: "INTEGER", notNull: false, defaultValue: "0" },
          { name: "created", type: "DATETIME", notNull: true },
          { name: "generated", type: "INTEGER", hidden: 3 },
        ],
      }]), calls),
    });
    const discovery = await db.discover();
    expect(discovery).toMatchObject({ status: "available", tableCount: 1, truncated: false });
    const table = discovery.tables[0];
    expect(table).toMatchObject({
      name: "items",
      kind: "table",
      allowlisted: true,
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      unique: { status: "declared-primary-key" },
      adapterQueryable: true,
    });
    expect(table?.fields.map((field) => [field.name, field.affinity, field.nullable, field.primaryKeyPosition, field.hidden, field.defaultValue])).toEqual([
      ["id", "integer", true, 1, 0, null],
      ["title", "text", false, 0, 0, "'x'"],
      ["rank", "integer", true, 0, 0, "0"],
      ["created", "numeric", false, 0, 0, null],
      ["generated", "integer", true, 0, 3, null],
    ]);
    expect(calls).toHaveLength(2);
  });

  it("reports composite, nullable and partial uniqueness honestly and honours an explicit contract", async () => {
    const calls: Call[] = [];
    const db = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      tables: {
        composite: { table: "composite", uniqueKey: true, keyColumn: { column: "a" }, columns: { value: { column: "value" } } },
        nullable: { table: "nullable", keyColumn: { column: "code" }, columns: { value: { column: "value" } } },
        unique: { table: "unique", keyColumn: { column: "code" }, columns: { value: { column: "value" } } },
      },
      fetch: mockFetch(discoveryResponses([
        {
          name: "composite",
          columns: [{ name: "a", type: "TEXT", notNull: true, pk: 1 }, { name: "b", type: "TEXT", notNull: true, pk: 2 }, { name: "value", type: "TEXT" }],
        },
        {
          name: "nullable",
          columns: [{ name: "code", type: "TEXT", pk: 1 }, { name: "value", type: "TEXT" }],
        },
        {
          name: "unique",
          columns: [{ name: "code", type: "TEXT", notNull: true }, { name: "value", type: "TEXT" }],
          indexes: [{ name: "unique_code", columns: ["code"] }, { name: "partial_code", partial: true, columns: ["code"] }],
        },
      ]), calls),
    });
    const discovery = await db.discover();
    const composite = discovery.tables.find((table) => table.name === "composite");
    expect(composite).toMatchObject({
      primaryKey: { status: "declared", columns: ["a", "b"] },
      unique: { status: "configured-contract", columns: ["a"] },
      adapterQueryable: true,
    });
    const nullable = discovery.tables.find((table) => table.name === "nullable");
    expect(nullable).toMatchObject({ unique: { status: "not-unique" }, adapterQueryable: false });
    expect(nullable?.adapterQueryableReason).toContain("uniqueKey");
    const unique = discovery.tables.find((table) => table.name === "unique");
    expect(unique).toMatchObject({
      primaryKey: { status: "not-declared", columns: [] },
      unique: { status: "unique-index", columns: ["code"], indexName: "unique_code" },
      adapterQueryable: true,
    });
  });

  it("treats a view without metadata proof as configured-contract only and never expands the allowlist", async () => {
    const calls: Call[] = [];
    const db = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      tables: { view_items: { table: "items_view", uniqueKey: true, keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
      fetch: mockFetch(discoveryResponses([
        { name: "items_view", kind: "view", columns: [{ name: "id", type: "TEXT" }, { name: "title", type: "TEXT" }] },
        { name: "other", columns: [{ name: "id", type: "TEXT", notNull: true, pk: 1 }] },
      ]), calls),
    });
    const discovery = await db.discover();
    expect(discovery.tables.find((table) => table.name === "items_view")).toMatchObject({
      kind: "view",
      allowlisted: true,
      unique: { status: "configured-contract" },
      adapterQueryable: true,
    });
    expect(discovery.tables.find((table) => table.name === "other")).toMatchObject({
      allowlisted: false,
      adapterQueryable: false,
    });
    expect(discovery.tables.find((table) => table.name === "other")?.adapterQueryableReason).toContain("allowlist");
  });

  it("bounds fields and statements and keeps truncated metadata distinct from an empty database", async () => {
    const fieldCalls: Call[] = [];
    const fieldDb = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      maxMetadataFieldsPerTable: 2,
      tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { a: { column: "a" }, b: { column: "b" } } } },
      fetch: mockFetch(discoveryResponses([{
        name: "items",
        columns: [{ name: "id", type: "INTEGER", pk: 1 }, { name: "a", type: "TEXT" }, { name: "b", type: "TEXT" }],
      }]), fieldCalls),
    });
    const fields = await fieldDb.discover();
    expect(fields).toMatchObject({ status: "available", truncated: true });
    expect(fields.tables[0]).toMatchObject({
      fieldsStatus: "truncated",
      omittedFields: 1,
      unique: { status: "unavailable" },
      adapterQueryable: false,
    });
    expect(fields.tables[0]?.fields.map((field) => field.name)).toEqual(["id", "a"]);

    const statementDb = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      maxMetadataStatements: 4,
      tables: {},
      fetch: mockFetch(discoveryResponses([
        { name: "a", columns: [{ name: "id", type: "INTEGER", pk: 1 }] },
        { name: "b", columns: [{ name: "id", type: "INTEGER", pk: 1 }] },
        { name: "c", columns: [{ name: "id", type: "INTEGER", pk: 1 }] },
      ], 2), []),
    });
    const statements = await statementDb.discover();
    expect(statements).toMatchObject({ status: "available", tableCount: 3, truncated: true, omittedTables: 0 });
    expect(statements.tables.map((table) => [table.name, table.fieldsStatus])).toEqual([
      ["a", "declared"],
      ["b", "declared"],
      ["c", "unavailable"],
    ]);
  });

  it("reports an oversized metadata response as unavailable metadata, not as an empty database", async () => {
    const db = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      maxMetadataBytes: 20,
      tables: {},
      fetch: mockFetch([
        ...discoveryResponses([{ name: "items", columns: [{ name: "id", type: "INTEGER", pk: 1 }] }]),
        ...discoveryResponses([{ name: "items", columns: [{ name: "id", type: "INTEGER", pk: 1 }] }]),
      ], []),
    });
    await expect(db.discover()).resolves.toMatchObject({ status: "unavailable", reason: "metadata-too-large" });
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "metadata-unsupported" });
  });

  it("marks a refused per-table metadata statement unavailable without inventing a key", async () => {
    const db = new LibSQLDatabase({
      serverUrl: "https://libsql.example.test",
      tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
      fetch: mockFetch([
        response([ok(executed(["name", "type", "wr"], [[text("items"), text("table"), integer(0)]]))]),
        response([failed("SQLITE_ERROR", "SQLITE_ERROR"), failed("SQLITE_ERROR", "SQLITE_ERROR")]),
      ], []),
    });
    const discovery = await db.discover();
    expect(discovery).toMatchObject({ status: "available", truncated: true });
    expect(discovery.tables[0]).toMatchObject({
      name: "items",
      allowlisted: true,
      fieldsStatus: "unavailable",
      unique: { status: "unavailable" },
      adapterQueryable: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import type { StructuredQuery } from "@dalgo/core";
import { compileSqlQuery, fieldColumn, quoteIdentifier, sqlValue, validateIdentifier, type SqlDialect, type SqlTable } from "../src/index.js";

class TestUnsupported extends Error {}
const dialect: SqlDialect = { name: "Test", unsupported: (capability) => new TestUnsupported(capability) };
const items: SqlTable = {
  table: "items",
  primaryKey: ["id"],
  columns: { id: { column: "item_id" }, name: { column: "name" }, amount: { column: "amount" } },
};

type Row = Record<string, unknown>;
function query(overrides: Partial<StructuredQuery<Row>> = {}): StructuredQuery<Row> {
  return { source: { kind: "collection", name: "Items" }, filters: [], orders: [], ...overrides };
}

describe("identifiers", () => {
  it("validates and quotes SQLite identifiers", () => {
    expect(quoteIdentifier('we"ird', "column name")).toBe('"we""ird"');
    expect(() => { validateIdentifier("", "table name"); }).toThrow("table name is not a valid configured SQLite identifier");
    expect(() => { validateIdentifier("x".repeat(256), "table name"); }).toThrow(TypeError);
    expect(() => { validateIdentifier("a\u0000b", "field"); }).toThrow(TypeError);
    expect(() => { validateIdentifier("a\u007fb", "field"); }).toThrow(TypeError);
    expect(() => { validateIdentifier("😀ok", "field"); }).not.toThrow();
  });
});

describe("fieldColumn", () => {
  it("maps DOCUMENT_ID to the single primary key column", () => {
    expect(fieldColumn(dialect, items, "__name__")).toBe("item_id");
    expect(fieldColumn(dialect, { table: "t", primaryKey: ["id"], columns: {} }, "__name__")).toBe("id");
  });

  it("rejects DOCUMENT_ID for composite or invalid keys and unknown fields", () => {
    expect(() => fieldColumn(dialect, { ...items, primaryKey: ["id", "name"] }, "__name__")).toThrow(TestUnsupported);
    expect(() => fieldColumn(dialect, { ...items, primaryKey: new Array<string>(1) }, "__name__")).toThrow("Test primary key configuration is invalid");
    expect(() => fieldColumn(dialect, items, "missing")).toThrow("Test field is not declared in the table mapping: missing");
  });
});

describe("sqlValue", () => {
  it("binds scalars and bytes without JSON coercion", () => {
    expect(sqlValue(dialect, null, "filter")).toBeNull();
    expect(sqlValue(dialect, "x", "filter")).toBe("x");
    expect(sqlValue(dialect, true, "filter")).toBe(1);
    expect(sqlValue(dialect, false, "filter")).toBe(0);
    expect(sqlValue(dialect, 1.5, "filter")).toBe(1.5);
    const buffer = new ArrayBuffer(1);
    expect(sqlValue(dialect, buffer, "filter")).toBe(buffer);
    const view = new Uint8Array([1]);
    expect(sqlValue(dialect, view, "filter")).toBe(view);
    expect(sqlValue(dialect, { $type: "blob", base64: "AQI=" }, "filter")).toEqual(new Uint8Array([1, 2]));
  });

  it("rejects unsafe, non-scalar and malformed blob values", () => {
    expect(() => sqlValue(dialect, 2 ** 53, "filter")).toThrow("Test filter integral numbers must be JavaScript safe integers");
    expect(() => sqlValue(dialect, Number.NaN, "filter")).toThrow("Test filter values must be JSON scalars or blobs");
    expect(() => sqlValue(dialect, { $type: "blob", base64: "%%%" }, "filter")).toThrow("Test filter blob encoding is invalid");
    expect(() => sqlValue(dialect, { $type: "blob", base64: "AQ" }, "filter")).toThrow("Test filter blob encoding is invalid");
    expect(() => sqlValue(dialect, { $type: "blob", base64: 1 }, "filter")).toThrow(TestUnsupported);
    expect(() => sqlValue(dialect, { $type: "other", base64: "AQ==" }, "filter")).toThrow(TestUnsupported);
    expect(() => sqlValue(dialect, { $type: "blob", base64: "AQ==", extra: 1 }, "filter")).toThrow(TestUnsupported);
    expect(() => sqlValue(dialect, Object.create(null) as object, "filter")).toThrow(TestUnsupported);
    expect(() => sqlValue(dialect, [1], "filter")).toThrow(TestUnsupported);
  });
});

describe("compileSqlQuery", () => {
  it("compiles every supported operator with bound values and a primary-key tie break", () => {
    const compiled = compileSqlQuery(dialect, items, query({
      filters: [
        { field: "name", operator: "==", value: "a" },
        { field: "name", operator: "==", value: null },
        { field: "name", operator: "!=", value: "b" },
        { field: "name", operator: "!=", value: null },
        { field: "amount", operator: "<", value: 1 },
        { field: "amount", operator: "<=", value: 2 },
        { field: "amount", operator: ">", value: 3 },
        { field: "amount", operator: ">=", value: 4 },
        { field: "id", operator: "in", value: [1, 2] },
        { field: "id", operator: "not-in", value: [3] },
      ],
      orders: [{ field: "amount", direction: "desc" }, { field: "name", direction: "asc" }],
      offset: 5,
    }), 10, ["name"]);
    expect(compiled.sql).toBe(
      'SELECT t."name" AS "name", t."item_id" AS "id" FROM "items" AS t WHERE t."name" = ? AND t."name" IS NULL AND t."name" != ? AND t."name" IS NOT NULL' +
      ' AND t."amount" < ? AND t."amount" <= ? AND t."amount" > ? AND t."amount" >= ? AND t."item_id" IN (?, ?) AND t."item_id" NOT IN (?)' +
      ' ORDER BY t."amount" DESC, t."name" ASC, t."item_id" ASC LIMIT 10 OFFSET 5',
    );
    expect(compiled.args).toEqual(["a", "b", 1, 2, 3, 4, 1, 2, 3]);
    expect(compiled.fields).toEqual(["name", "id"]);
  });

  it("orders keyless tables by every declared column", () => {
    const compiled = compileSqlQuery(dialect, { table: "v", primaryKey: [], columns: { a: { column: "a" }, b: { column: "b" } } }, query(), 1);
    expect(compiled.sql).toBe('SELECT t."a" AS "a", t."b" AS "b" FROM "v" AS t ORDER BY t."a" ASC, t."b" ASC LIMIT 1 OFFSET 0');
  });

  it("rejects unsupported query shapes", () => {
    expect(() => compileSqlQuery(dialect, items, query({ source: { kind: "collection-group", name: "Items" } }), 1)).toThrow("Test nested or collection-group queries");
    expect(() => compileSqlQuery(dialect, items, query({ startAt: { values: [1] } }), 1)).toThrow("Test DALgo query cursors");
    expect(() => compileSqlQuery(dialect, items, query({ startAfter: { values: [1] } }), 1)).toThrow(TestUnsupported);
    expect(() => compileSqlQuery(dialect, items, query({ endAt: { values: [1] } }), 1)).toThrow(TestUnsupported);
    expect(() => compileSqlQuery(dialect, items, query({ endBefore: { values: [1] } }), 1)).toThrow(TestUnsupported);
    expect(() => compileSqlQuery(dialect, items, query(), 0)).toThrow("Test query limit must be a positive safe integer");
    expect(() => compileSqlQuery(dialect, { table: "t", primaryKey: [], columns: {} }, query(), 1)).toThrow("Test projections must include at least one field");
    expect(() => compileSqlQuery(dialect, items, query({ offset: -1 }), 1)).toThrow("Test query offset must be a non-negative safe integer");
    expect(() => compileSqlQuery(dialect, items, query({ filters: [{ field: "id", operator: "in", value: [] }] }), 1)).toThrow("Test in filters require 1 to 100 values");
    expect(() => compileSqlQuery(dialect, items, query({ filters: [{ field: "id", operator: "not-in", value: 1 }] }), 1)).toThrow(TestUnsupported);
    expect(() => compileSqlQuery(dialect, items, query({ filters: [{ field: "id", operator: "array-contains", value: 1 }] }), 1)).toThrow("Test query operator: array-contains");
    expect(() => compileSqlQuery(dialect, items, query({ filters: [{ field: "id", operator: "array-contains-any", value: [1] }] }), 1)).toThrow(TestUnsupported);
    const tooMany = Array.from({ length: 101 }, () => ({ field: "id", operator: "==" as const, value: 1 }));
    expect(() => compileSqlQuery(dialect, items, query({ filters: tooMany }), 1)).toThrow("Test queries support at most 100 bound values");
    expect(() => compileSqlQuery(dialect, items, query({ orders: [{ field: "missing", direction: "asc" }] }), 1)).toThrow(TestUnsupported);
  });
});

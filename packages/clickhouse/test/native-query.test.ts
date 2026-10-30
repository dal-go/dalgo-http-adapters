import type { JoinedTugQLQuery, ParsedTugQLQuery, QueryColumn, StructuredQuery } from "@dalgo/core";
import type { OrdinalParameter, OrdinalStructuredQuery } from "@dalgo/adapter-runtime";
import { describe, expect, it } from "vitest";
import { compileOrdinalQuery } from "../src/native-dalgo.js";
import { nativeParameters } from "../src/native-query.js";

const tables = new Map([["events", { database: "explore", table: "events", columns: { id: "event_id", amount: "amount", label: "label" } }]]);
const field = (name: string) => ({ kind: "field" as const, field: { source: "e", field: name } });
const columns: readonly QueryColumn[] = [{ expression: field("id"), as: "duplicate" }, { expression: field("id"), as: "duplicate" }];
const joined: JoinedTugQLQuery = { kind: "joined-tugql", from: { name: "events", alias: "e", joins: [] }, filters: [], orders: [], columns };
const compile = (query: ParsedTugQLQuery<Record<string, unknown>>, options: Partial<Omit<OrdinalStructuredQuery, "kind" | "query">> = {}) => compileOrdinalQuery({ kind: "structured", query, ...options }, tables, false, 100);

describe("DALgo ordinal compiler", () => {
  it("preserves actual DALgo projection order, aliases, nested conditions, order, limit and typed parameters", () => {
    const parameter: OrdinalParameter = { name: "maximum", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } };
    const compiled = compile({ ...joined, limit: 2, filters: [{ kind: "and", conditions: [
      { left: field("id"), operator: "==", right: { kind: "param", name: "maximum" } },
      { kind: "or", conditions: [{ kind: "is-null", operand: field("label") }, { kind: "is-not-null", operand: field("label") }] },
      { left: field("id"), operator: "in", right: { kind: "values", values: [1, 2] } },
    ] }], orders: [{ field: { source: "e", field: "amount" }, direction: "desc" }] }, { parameters: [parameter] });
    expect(compiled.sql).toBe("SELECT `events`.`event_id` AS `duplicate`, `events`.`event_id` AS `duplicate` FROM `explore`.`events` WHERE ((`events`.`event_id` = {maximum:UInt64}) AND ((`events`.`label` IS NULL) OR (`events`.`label` IS NOT NULL)) AND (`events`.`event_id` IN ({__dalgo_literal_0:UInt64}, {__dalgo_literal_1:UInt64}))) ORDER BY `events`.`amount` DESC LIMIT 2");
    expect(nativeParameters(compiled.parameters)).toEqual([{ name: "__dalgo_literal_0", value: "1" }, { name: "__dalgo_literal_1", value: "2" }, { name: "maximum", value: "18446744073709551615" }]);
  });

  it("bridges core QueryBuilder's StructuredQuery without requiring a keyed Database", () => {
    const query: StructuredQuery<Record<string, unknown>> = { source: { kind: "collection", name: "events" }, filters: [{ field: "label", operator: "==", value: null }, { field: "id", operator: "not-in", value: [1, 2] }], orders: [{ field: "id", direction: "asc" }], limit: 3 };
    const compiled = compile(query, { columns: [{ expression: { kind: "field", field: { source: "events", field: "id" } }, as: "native id" }] });
    expect(compiled.sql).toBe("SELECT `events`.`event_id` AS `native id` FROM `explore`.`events` WHERE (`events`.`label` IS NULL) AND (`events`.`event_id` NOT IN ({__dalgo_literal_0:UInt64}, {__dalgo_literal_1:UInt64})) ORDER BY `events`.`event_id` ASC LIMIT 3");
  });

  it("retains SQL null comparison semantics for joined predicates and safely binds literals", () => {
    const compiled = compile({ ...joined, columns: [ { expression: { kind: "literal", value: "quote's" }, as: "a`b" } ], filters: [{ field: { source: "e", field: "label" }, operator: "==", value: null }] });
    expect(compiled.sql).toContain("AS `a``b`");
    expect(compiled.sql).toContain("`events`.`label` = {__dalgo_literal_1:Nullable(String)}");
    expect(nativeParameters(compiled.parameters)).toEqual([{ name: "__dalgo_literal_0", value: "quote\\'s" }, { name: "__dalgo_literal_1", value: "\\N" }]);
  });

  it("qualifies physical predicates and order when an output alias captures another field name", () => {
    const compiled = compile({ ...joined, columns: [{ expression: field("id"), as: "amount" }], filters: [{ field: { source: "e", field: "amount" }, operator: ">", value: 1 }], orders: [{ field: { source: "e", field: "amount" }, direction: "asc" }] });
    expect(compiled.sql).toBe("SELECT `events`.`event_id` AS `amount` FROM `explore`.`events` WHERE (`events`.`amount` > {__dalgo_literal_0:UInt64}) ORDER BY `events`.`amount` ASC LIMIT 100");
    expect(() => compile({ ...joined, columns: [{ expression: field("id"), as: "same" }, { expression: field("amount"), as: "same" }] })).toThrow("unsupported");
  });

  it("refuses backslash identifier escapes and injection payloads before producing SQL", () => {
    for (const alias of ["trailing\\", "literal\\n", "literal\\N", "x\\`, secret FROM forbidden.secret --"]) {
      expect(() => compile({ ...joined, columns: [{ expression: { kind: "literal", value: 1 }, as: alias }] })).toThrow("unsupported");
    }
    expect(compile({ ...joined, columns: [{ expression: field("id"), as: "a`b" }] }).sql).toContain("AS `a``b`");
  });

  it("refuses native SQL without its separate grant and sends enabled native SQL unchanged", () => {
    const request = { kind: "native" as const, sql: " SELECT {id:UInt64}; -- unchanged\n", parameters: [{ name: "id", nativeType: "UInt64", value: { kind: "integer" as const, value: "5" } }] };
    expect(() => compileOrdinalQuery(request, tables, false, 100)).toThrow("permission");
    expect(compileOrdinalQuery(request, tables, true, 100)).toEqual({ sql: request.sql, parameters: request.parameters });
    expect(() => compileOrdinalQuery({ kind: "native", sql: " " }, tables, true, 100)).toThrow("unsupported");
  });

  it("fails before I/O for unsupported query shapes and missing structured grants", () => {
    for (const query of [
      { ...joined, from: { ...joined.from, name: "secret" } },
      { ...joined, offset: 1 }, { ...joined, limit: 101 }, { ...joined, groupBy: [] },
      { ...joined, columns: undefined }, { ...joined, columns: [{ wildcard: { exclude: [] } }] },
      { ...joined, columns: [{ expression: { kind: "star" } }] },
      { ...joined, columns: [{ expression: { kind: "field", field: { source: "e", field: "secret" } } }] },
      { ...joined, orders: [{ expression: { kind: "literal", value: 1 }, direction: "asc" }] },
      { ...joined, filters: [{ field: { source: "other", field: "id" }, operator: "==", value: 1 }] },
      { ...joined, filters: [{ field: { source: "e", field: "id" }, operator: "==", value: 9007199254740992 }] },
      { ...joined, filters: [{ kind: "and", conditions: [] }] },
      { ...joined, filters: [{ left: field("id"), operator: "==", right: { kind: "param", name: "missing" } }] },
      { ...joined, filters: [{ field: { source: "e", field: "id" }, operator: "array-contains", value: 1 }] },
    ]) expect(() => compile(query as JoinedTugQLQuery)).toThrow();
    expect(() => compile(joined, { parameters: [{ name: "unused", nativeType: "UInt64", value: 1 }] })).toThrow();
    expect(() => compile({ source: { kind: "collection-group", name: "events" }, filters: [], orders: [] }, { columns })).toThrow();
  });
});

describe("typed ClickHouse HTTP bindings", () => {
  it("serializes exact integers, decimals, nullable arrays, strings, booleans, floats and temporal text", () => {
    const parameters: OrdinalParameter[] = [
      { name: "u", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } },
      { name: "i", nativeType: "Int8", value: -128 },
      { name: "d", nativeType: "Decimal(38, 9)", value: { kind: "decimal", unscaled: "-12345678901234567890123456789", scale: 9 } },
      { name: "small", nativeType: "Decimal(9, 2)", value: { kind: "decimal", unscaled: "1", scale: 2 } },
      { name: "whole", nativeType: "Decimal(9, 0)", value: { kind: "decimal", unscaled: "1", scale: 0 } },
      { name: "a", nativeType: "Array(Nullable(String))", value: { kind: "array", values: [null, "a\n'\\\t\r\0"] } },
      { name: "b", nativeType: "Bool", value: false }, { name: "f", nativeType: "Float64", value: 1.25 },
      { name: "t", nativeType: "DateTime64(9, 'UTC')", value: "2026-01-02 03:04:05.123456789" },
    ];
    expect(nativeParameters(parameters)).toEqual([
      { name: "u", value: "18446744073709551615" }, { name: "i", value: "-128" },
      { name: "d", value: "-12345678901234567890.123456789" }, { name: "small", value: "0.01" }, { name: "whole", value: "1" },
      { name: "a", value: "[NULL,'a\\n\\'\\\\\\t\\r\\0']" }, { name: "b", value: "0" }, { name: "f", value: "1.25" }, { name: "t", value: "2026-01-02 03:04:05.123456789" },
    ]);
  });

  it("rejects unsafe numbers, out-of-range integers, wrong scales, duplicate names and malicious nested types", () => {
    const bad: OrdinalParameter[] = [
      { name: "p", nativeType: "UInt64", value: 9007199254740992 },
      { name: "p", nativeType: "UInt8", value: 256 }, { name: "p", nativeType: "Int8", value: -129 },
      { name: "p", nativeType: "UInt64", value: { kind: "integer", value: "-1" } },
      { name: "p", nativeType: "UInt64", value: { kind: "integer", value: "01" } },
      { name: "p", nativeType: "Decimal(2, 1)", value: { kind: "decimal", unscaled: "123", scale: 1 } },
      { name: "p", nativeType: "Decimal(9, 2)", value: { kind: "decimal", unscaled: "1", scale: 3 } },
      { name: "p", nativeType: "Array(String) } SETTINGS readonly=0 --)", value: { kind: "array", values: [] } },
      { name: "p", nativeType: "Nullable(Unsupported)", value: null }, { name: "p", nativeType: "Float64", value: Infinity },
      { name: "bad-name", nativeType: "String", value: "x" },
    ];
    for (const parameter of bad) expect(() => nativeParameters([parameter])).toThrow();
    const parameter = { name: "same", nativeType: "String", value: "x" };
    expect(() => nativeParameters([parameter, parameter])).toThrow("permission");
    expect(() => nativeParameters([{ name: "large", nativeType: "String", value: "😀".repeat(10) }], 20)).toThrow("bounds");
  });
});

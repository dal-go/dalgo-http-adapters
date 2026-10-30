import { describe, expect, it } from "vitest";
import { decodeClickHouseRowBinary } from "../src/row-binary.js";
import { binary, float, leb, text, uint } from "./helpers/binary.js";

const limits = { maxRows: 10, maxColumns: 30, maxValues: 100, maxDepth: 16 };
const integer = (value: string) => ({ kind: "integer", value });

describe("native RowBinary", () => {
  it("preserves duplicate labels, duplicate rows, UInt64/Decimal precision and nested map entries", () => {
    const types = ["UInt64", "Decimal(38, 9)", "Nullable(String)", "Array(UInt64)", "Map(String, UInt64)", "DateTime64(9, 'UTC')"];
    const row = [...uint(18446744073709551615n, 8), ...uint(12345678901234567890123456789n, 16), 1,
      1, ...uint(18446744073709551615n, 8), 2, ...text("same"), ...uint(1n, 8), ...text("same"), ...uint(2n, 8), ...uint(1767323045123456789n, 8)];
    const result = decodeClickHouseRowBinary(binary(["same", "same", "null", "array", "map", "time"], types, [row, row]), limits);
    expect(result.columns.slice(0, 2).map((column) => column.name)).toEqual(["same", "same"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual([
      integer("18446744073709551615"), { kind: "decimal", unscaled: "12345678901234567890123456789", scale: 9 }, null,
      { kind: "array", values: [integer("18446744073709551615")] },
      { kind: "map", entries: [["same", integer("1")], ["same", integer("2")]] },
      { kind: "datetime", ticksSinceEpoch: "1767323045123456789", scale: 9, timezone: "UTC" },
    ]);
    expect(result.rows[1]).toEqual(result.rows[0]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("decodes scalar widths, signed values, dates, floats, decimals and low-cardinality nullable strings", () => {
    const types = ["Int8", "UInt16", "Int32", "Int64", "Int128", "UInt256", "Float32", "Float64", "Bool", "Date", "Date32", "DateTime", "DateTime('UTC')", "DateTime64(0)", "Decimal32(2)", "Decimal64(3)", "Decimal256(9)", "LowCardinality(Nullable(String))"];
    const row = [...uint(-1n, 1), ...uint(65535n, 2), ...uint(-2n, 4), ...uint(-3n, 8), ...uint(-4n, 16), ...uint((1n << 256n) - 1n, 32),
      ...float(1.25, 4), ...float(-2.5), 1, ...uint(2n, 2), ...uint(-1n, 4), ...uint(3n, 4), ...uint(4n, 4), ...uint(-5n, 8),
      ...uint(-123n, 4), ...uint(1234n, 8), ...uint(5n, 32), 0, ...text("value")];
    const result = decodeClickHouseRowBinary(binary(types, types, [row]), limits);
    expect(result.rows[0]).toEqual([integer("-1"), integer("65535"), integer("-2"), integer("-3"), integer("-4"), integer(((1n << 256n) - 1n).toString()),
      1.25, -2.5, true, { kind: "date", daysSinceEpoch: "2" }, { kind: "date", daysSinceEpoch: "-1" },
      { kind: "datetime", ticksSinceEpoch: "3", scale: 0 }, { kind: "datetime", ticksSinceEpoch: "4", scale: 0, timezone: "UTC" },
      { kind: "datetime", ticksSinceEpoch: "-5", scale: 0 }, { kind: "decimal", unscaled: "-123", scale: 2 },
      { kind: "decimal", unscaled: "1234", scale: 3 }, { kind: "decimal", unscaled: "5", scale: 9 }, "value"]);
  });

  it("keeps zero-row metadata and empty nested values", () => {
    expect(decodeClickHouseRowBinary(binary(["empty"], ["String"]), limits)).toEqual({ columns: [{ name: "empty", nativeType: "String" }], rows: [] });
    expect(decodeClickHouseRowBinary(binary(["a", "m", "b"], ["Array(String)", "Map(String, String)", "Bool"], [[0, 0, 0]]), limits).rows)
      .toEqual([[{ kind: "array", values: [] }, { kind: "map", entries: [] }, false]]);
  });

  it.each(["Tuple(UInt64, String)", "JSON", "UUID", "FixedString(4)", "Enum8('ok' = 1)", "Nothing", "Decimal(0, 0)", "Decimal(77, 1)", "Decimal(9, 10)", "Decimal32(1, 2)", "DateTime64(10)", "DateTime('bad zone')", "Map(String)", "Nullable(UInt8, String)", "Array(UInt8))", "Array('broken)"])("fails closed for unsupported type %s even with zero rows", (type) => {
    expect(() => decodeClickHouseRowBinary(binary(["field"], [type]), limits)).toThrow("unsupported");
  });

  it("rejects malformed headers, truncated rows, invalid UTF-8, nullable flags and non-finite floats", () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(0), Uint8Array.from(Array<number>(10).fill(255)),
      binary(["n"], ["UInt64"], [[1]]), binary(["n"], ["Nullable(String)"], [[2]]), binary(["n"], ["Bool"], [[2]])]) {
      expect(() => decodeClickHouseRowBinary(bytes, limits)).toThrow();
    }
    expect(() => decodeClickHouseRowBinary(binary(["n"], ["String"], [[1, 255]]), limits)).toThrow("unsupported");
    expect(() => decodeClickHouseRowBinary(binary(["n"], ["Float64"], [float(Infinity)]), limits)).toThrow("unsupported");
  });

  it("enforces row, column, total-cell, length and nesting bounds", () => {
    expect(() => decodeClickHouseRowBinary(binary(["a", "b"], ["UInt8", "UInt8"]), { ...limits, maxColumns: 1 })).toThrow("bounds");
    expect(() => decodeClickHouseRowBinary(binary(["a"], ["UInt8"], [[1], [2]]), { ...limits, maxRows: 1 })).toThrow("bounds");
    expect(() => decodeClickHouseRowBinary(binary(["a"], ["Array(UInt8)"], [[2, 1, 2]]), { ...limits, maxValues: 2 })).toThrow("bounds");
    expect(() => decodeClickHouseRowBinary(binary(["a"], ["String"], [[...leb(1000), 1]]), limits)).toThrow("bounds");
    expect(() => decodeClickHouseRowBinary(binary(["a"], ["Array(Array(UInt8))"]), { ...limits, maxDepth: 1 })).toThrow("unsupported");
  });
});

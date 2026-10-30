import { describe, expect, it } from "vitest";
import { isOrdinalQueryExecutor, type OrdinalQueryExecutor, type OrdinalQueryResult } from "../src/index.js";

describe("optional ordinal contract", () => {
  it("does not require a keyed core Database or fabricate identities", async () => {
    const result: OrdinalQueryResult = { columns: [{ name: "duplicate", nativeType: "UInt64" }, { name: "duplicate", nativeType: "String" }], rows: [[{ kind: "integer", value: "18446744073709551615" }, "same"], [{ kind: "integer", value: "18446744073709551615" }, "same"]] };
    const executor: OrdinalQueryExecutor = { queryOrdinal: () => Promise.resolve(result) };
    expect(isOrdinalQueryExecutor(executor)).toBe(true);
    expect(await executor.queryOrdinal({ kind: "native", sql: "SELECT 1" })).toBe(result);
    expect(isOrdinalQueryExecutor({ query: () => Promise.resolve({ records: [] }) })).toBe(false);
    expect(isOrdinalQueryExecutor(null)).toBe(false);
    expect(isOrdinalQueryExecutor("queryOrdinal")).toBe(false);
  });
});

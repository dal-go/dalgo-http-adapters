import type { OrdinalStructuredQuery } from "@dalgo/adapter-runtime";
import { NativeClickHouseDatabase } from "../src/index.js";

const adapter = new NativeClickHouseDatabase({
  serverUrl: "https://clickhouse.example", allowNativeSql: false,
  tables: { events: { database: "analytics", table: "events", columns: { id: "id", amount: "amount" } } },
});
const request: OrdinalStructuredQuery = {
  kind: "structured",
  query: {
    kind: "joined-tugql", from: { name: "events", alias: "e", joins: [] },
    columns: [{ expression: { kind: "field", field: { source: "e", field: "id" } }, as: "native id" }],
    filters: [{ left: { kind: "field", field: { source: "e", field: "id" } }, operator: "==", right: { kind: "param", name: "id" } }],
    orders: [], limit: 10,
  },
  parameters: [{ name: "id", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } }],
};
export async function queryNative(signal?: AbortSignal) { return await adapter.queryOrdinal(request, signal); }

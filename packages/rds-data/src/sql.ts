import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dal-go/dalgo";
import type { RdsDataDialect, RdsDataTable } from "./types.js";

const identifier = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
export interface RdsParameter { readonly name: string; readonly value: unknown; }
export interface CompiledRdsQuery { readonly sql: string; readonly parameters: readonly RdsParameter[]; }

export function quoteIdentifier(value: string, dialect: RdsDataDialect, label = "identifier"): string {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`);
  return dialect === "postgresql" ? `"${value}"` : `\`${value}\``;
}
export function quoteTable(table: RdsDataTable, dialect: RdsDataDialect): string {
  return `${quoteIdentifier(table.schema, dialect, "schema")}.${quoteIdentifier(table.table, dialect, "table")}`;
}
function column(table: RdsDataTable, field: string): string {
  if (field === DOCUMENT_ID) return table.keyColumn;
  const result = table.columns[field];
  if (result === undefined) throw new UnsupportedError(`RDS Data API field is not declared in table mapping: ${field}`);
  return result;
}
function scalar(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new UnsupportedError("RDS Data API parameters must be null, string, boolean, finite number, or safe integer");
}
function keyValue(value: unknown, table: RdsDataTable): string | number {
  if (table.keyType === "string" && typeof value === "string") return value;
  if (table.keyType === "integer" && typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  throw new TypeError(`RDS Data API ${table.keyType} key type mismatch`);
}
function filter<T>(item: QueryFilter<T>, table: RdsDataTable, dialect: RdsDataDialect, index: number): { readonly sql: string; readonly parameter?: RdsParameter } {
  const field = String(item.field); const col = `t.${quoteIdentifier(column(table, field), dialect, "column")}`; const name = `p${String(index)}`;
  const value = field === DOCUMENT_ID ? keyValue(item.value, table) : scalar(item.value);
  switch (item.operator) {
    case "==": return value === null ? { sql: `${col} IS NULL` } : { sql: `${col} = :${name}`, parameter: { name, value } };
    case "!=": return value === null ? { sql: `${col} IS NOT NULL` } : { sql: `${col} IS NOT NULL AND ${col} != :${name}`, parameter: { name, value } };
    case "<": case "<=": case ">": case ">=": return { sql: `${col} ${item.operator} :${name}`, parameter: { name, value } };
    default: throw new UnsupportedError(`RDS Data API query operator: ${String(item.operator)}`);
  }
}
export function compileRdsQuery<T>(table: RdsDataTable, dialect: RdsDataDialect, query: StructuredQuery<T>, limit: number, offset: number | undefined): CompiledRdsQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("RDS Data API collection-group or nested collection queries");
  if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("RDS Data API cursors");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new TypeError("offset must be a non-negative safe integer");
  const parameters: RdsParameter[] = [];
  const clauses = (query.filters ?? []).map((item, index) => { const result = filter(item, table, dialect, index); if (result.parameter !== undefined) parameters.push(result.parameter); return result.sql; });
  const order = (query.orders ?? []).map((item: QueryOrder<T>) => {
    if (item.direction !== "asc" && item.direction !== "desc") throw new TypeError("RDS Data API order direction must be asc or desc");
    return `t.${quoteIdentifier(column(table, String(item.field)), dialect, "column")} ${item.direction.toUpperCase()}`;
  });
  const selected = [`t.${quoteIdentifier(table.keyColumn, dialect, "keyColumn")} AS ${quoteIdentifier("__dalgo_key", dialect)}`, ...Object.entries(table.columns).map(([field, col]) => `t.${quoteIdentifier(col, dialect, "column")} AS ${quoteIdentifier(field, dialect, "field")}`)];
  return { sql: `SELECT ${selected.join(", ")} FROM ${quoteTable(table, dialect)} AS t${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}${order.length === 0 ? "" : ` ORDER BY ${order.join(", ")}`} LIMIT ${String(limit)}${offset === undefined ? "" : ` OFFSET ${String(offset)}`}`, parameters };
}
export function rdsKeyValue(value: unknown, table: RdsDataTable): string | number { return keyValue(value, table); }
export function rdsScalar(value: unknown): unknown { return scalar(value); }

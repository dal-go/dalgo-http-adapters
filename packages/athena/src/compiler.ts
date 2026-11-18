import { DOCUMENT_ID, type StructuredQuery } from "@dalgo/core";
import { fail } from "./errors.js";
import { encode } from "./json.js";
import { integer, type Operation } from "./operation.js";
import type { AthenaSource, AthenaTable } from "./types.js";
import { array, field, only, snapshot, text } from "./validation.js";
export interface ReadPlan { readonly sql: string; readonly parameters: readonly string[]; readonly collection: string; readonly columns: readonly string[]; readonly types: readonly string[]; readonly limit: number; readonly offset: number }
export function identifier(value: string): string { text(value); return '"' + value.replaceAll('"', '""') + '"'; }
function scalar(type: string, value: unknown): string {
  const kind = type.toLowerCase();
  if (/^(?:varchar|char)(?:\(\d+\))?$|^string$/u.test(kind)) { if (typeof value !== "string") throw fail("input"); if (value.length > 1020) throw fail("bounds"); return "'" + value.replaceAll("'", "''") + "'"; }
  if (kind === "boolean") { if (typeof value !== "boolean") throw fail("input"); return value ? "TRUE" : "FALSE"; }
  if (/^(?:tinyint|smallint|integer|int|bigint|double|real|float|decimal(?:\(\d+,\s*\d+\))?)$/u.test(kind)) {
    if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw fail("input");
    if (typeof value !== "number" && typeof value !== "string") throw fail("input");
    const raw = String(value); if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw) || raw.length > 128) throw fail("input"); return raw;
  }
  if (kind === "date") { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/u.test(value)) throw fail("input"); const epoch = Date.parse(value + "T00:00:00.000Z"); if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) throw fail("input"); return "CAST('" + value + "' AS DATE)"; }
  throw fail("input");
}
export function sourceCopy(value: AthenaSource, op: Operation): AthenaSource {
  const copy = snapshot(value, op); const src = only(copy, ["sourceId", "region", "workGroup", "catalog", "database", "outputLocation", "expectedBucketOwner", "maxScanBytes", "encryption", "tables"]);
  text(src.sourceId, 256); if (typeof src.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(src.region)) throw fail("configuration");
  if (typeof src.workGroup !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/u.test(src.workGroup)) throw fail("configuration");
  identifier(text(src.catalog)); identifier(text(src.database));
  if (typeof src.outputLocation !== "string" || !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[!-~]*\/$/u.test(src.outputLocation) || src.outputLocation.includes("?") || src.outputLocation.includes("#")) throw fail("configuration");
  if (typeof src.expectedBucketOwner !== "string" || !/^\d{12}$/u.test(src.expectedBucketOwner) || typeof src.maxScanBytes !== "string" || !/^\d{8,18}$/u.test(src.maxScanBytes) || BigInt(src.maxScanBytes) < 10_000_000n) throw fail("configuration");
  const encryption = only(src.encryption, ["option", "kmsKey"]);
  if (encryption.option !== "SSE_S3" && encryption.option !== "SSE_KMS" || encryption.option === "SSE_KMS" && typeof encryption.kmsKey !== "string" || encryption.option === "SSE_S3" && encryption.kmsKey !== undefined) throw fail("configuration");
  if (encryption.option === "SSE_KMS") text(encryption.kmsKey, 2048);
  const tables = only(src.tables, Object.keys(src.tables as object)); const names = Object.keys(tables);
  if (names.length === 0 || names.length > 256) throw fail("bounds");
  for (const name of names) {
    text(name, 256); const table = only(tables[name], ["table", "columns", "idColumn"]); identifier(text(table.table));
    const columns = only(table.columns, Object.keys(table.columns as object)); if (Object.keys(columns).length === 0 || Object.keys(columns).length > op.limits.maxColumns) throw fail("bounds");
    for (const [column, type] of Object.entries(columns)) { identifier(column); text(type, 256); }
    if (table.idColumn !== undefined && (typeof table.idColumn !== "string" || !Object.hasOwn(columns, table.idColumn) || !/^(?:varchar|char|string)/iu.test(String(columns[table.idColumn])))) throw fail("configuration");
  }
  return copy as AthenaSource;
}
export function compile(query: StructuredQuery<unknown>, source: AthenaSource, offset: number, op: Operation, projection?: readonly string[]): ReadPlan {
  op.check(); only(query, ["source", "filters", "orders", "limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]); const sourceNode = only(field(query, "source"), ["kind", "name", "parent", "codec"]); if (field(sourceNode, "kind") !== "collection" || field(sourceNode, "parent") !== undefined) throw fail("input");
  const collection = text(field(sourceNode, "name"), 256); if (!Object.hasOwn(source.tables, collection)) throw fail("input"); const table: AthenaTable | undefined = source.tables[collection]; if (table === undefined) throw fail("input");
  const parameters: string[] = []; const columns = projection === undefined ? Object.keys(table.columns) : array(projection, op.limits.maxColumns).map(value => text(value));
  if (columns.length === 0 || new Set(columns).size !== columns.length || columns.some(value => !Object.hasOwn(table.columns, value))) throw fail("input");
  const column = (value: unknown): string => { let name = text(value); if (name === DOCUMENT_ID) { if (table.idColumn === undefined) throw fail("input"); name = table.idColumn; } if (!Object.hasOwn(table.columns, name)) throw fail("input"); return name; };
  for (const key of ["startAt", "startAfter", "endAt", "endBefore"]) if (field(query, key) !== undefined) throw fail("input");
  const queryOffset = field(query, "offset"); if (queryOffset !== undefined) { const requested = integer(queryOffset, 0, 100_000); if (offset !== 0 && offset !== requested) throw fail("input"); offset = requested; }
  const suppliedLimit = field(query, "limit"); const limit = suppliedLimit === undefined ? op.limits.maxRows + 1 : integer(suppliedLimit, 1, op.limits.maxRows);
  const bind = (name: string, value: unknown): string => {
    const type = table.columns[name]; if (type === undefined || parameters.length >= 64) throw fail("bounds");
    const param = scalar(type, value); if (param.length > 1024) throw fail("bounds"); parameters.push(param); return "?";
  };
  const filters = array(field(query, "filters") ?? [], 64).map(item => {
    const f = only(item, ["field", "operator", "value"]); const name = column(f.field), quoted = identifier(name);
    if (f.operator === "in" || f.operator === "not-in") {
      const values = array(f.value, 64); if (values.length === 0 || values.some(value => value === null)) throw fail("input");
      return quoted + (f.operator === "in" ? " IN (" : " NOT IN (") + values.map(value => bind(name, value)).join(", ") + ")";
    }
    const operators: Readonly<Record<string, string>> = { "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
    if (typeof f.operator !== "string" || !Object.hasOwn(operators, f.operator)) throw fail("input"); const operator = operators[f.operator]; if (operator === undefined) throw fail("input");
    if (f.value === null) { if (f.operator !== "==" && f.operator !== "!=") throw fail("input"); return quoted + (f.operator === "==" ? " IS NULL" : " IS NOT NULL"); }
    return quoted + " " + operator + " " + bind(name, f.value);
  });
  const orders = array(field(query, "orders") ?? [], 16).map(item => { const order = only(item, ["field", "direction"]); if (order.direction !== "asc" && order.direction !== "desc") throw fail("input"); return identifier(column(order.field)) + (order.direction === "asc" ? " ASC" : " DESC"); });
  const sql = "SELECT " + columns.map(identifier).join(", ") + " FROM " + [source.catalog, source.database, table.table].map(identifier).join(".")
    + (filters.length === 0 ? "" : " WHERE " + filters.join(" AND ")) + (orders.length === 0 ? "" : " ORDER BY " + orders.join(", "))
    + (offset === 0 ? "" : " OFFSET " + String(offset)) + " LIMIT " + String(limit);
  const result = { sql, parameters, collection, columns, types: columns.map(name => table.columns[name] ?? ""), limit, offset }; encode(result, op.limits.maxRequestBytes, op); return result;
}

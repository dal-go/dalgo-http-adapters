import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dalgo/core";
import type { D1Table } from "./types.js";

export type D1Json = null | boolean | number | string | D1Blob | readonly D1Json[] | { readonly [key: string]: D1Json };
export type D1Operator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not-in";
export type D1WireValue = D1Json | D1Blob | readonly D1WireValue[] | { readonly [key: string]: D1WireValue };
export interface D1Filter { readonly field: string; readonly operator: D1Operator; readonly value: D1Json; }
export interface D1Order { readonly field: string; readonly direction: "asc" | "desc"; }
export interface D1QueryRequest {
  readonly version: 1;
  readonly collection: string;
  readonly columns?: readonly string[];
  readonly filters?: readonly D1Filter[];
  readonly orders?: readonly D1Order[];
  readonly limit?: number;
  readonly offset?: number;
}
export interface D1QueryResponse {
  readonly version: 1;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly records: readonly Readonly<Record<string, D1WireValue>>[];
}
export interface D1Blob { readonly $type: "blob"; readonly base64: string; }

export interface CompiledD1Query {
  readonly sql: string;
  readonly args: readonly (string | number | null | ArrayBuffer | ArrayBufferView)[];
  readonly fields: readonly string[];
}

const maxMembership = 100;
const maxBoundValues = 100;

export function validateIdentifier(value: string, label: string): void {
  let hasControl = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code !== undefined && (code < 32 || code === 127)) hasControl = true;
  }
  if (value.length === 0 || value.length > 255 || hasControl) throw new TypeError(`${label} is not a valid configured SQLite identifier`);
}

export function quoteIdentifier(value: string, label: string): string {
  validateIdentifier(value, label);
  return `"${value.replaceAll('"', '""')}"`;
}

export function fieldColumn(table: D1Table, field: string): string {
  if (field === DOCUMENT_ID) {
    if (table.primaryKey.length !== 1) throw new UnsupportedError("D1 DOCUMENT_ID filters and orders require a single-column primary key");
    const keyField = table.primaryKey[0];
    if (keyField === undefined) throw new TypeError("D1 primary key configuration is invalid");
    return table.columns[keyField]?.column ?? keyField;
  }
  const column = table.columns[field];
  if (column === undefined) throw new UnsupportedError(`D1 field is not declared in the table mapping: ${field}`);
  return column.column;
}

function sqlValue(value: unknown, label: string): string | number | null | ArrayBuffer | ArrayBufferView {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new UnsupportedError(`D1 ${label} integral numbers must be JavaScript safe integers`);
    return value;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 2 &&
    (value as { readonly $type?: unknown }).$type === "blob" && typeof (value as { readonly base64?: unknown }).base64 === "string") {
    let binary: string;
    try { binary = atob((value as { readonly base64: string }).base64); } catch { throw new UnsupportedError(`D1 ${label} blob encoding is invalid`); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    let canonical = "";
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    if (btoa(canonical) !== (value as { readonly base64: string }).base64) throw new UnsupportedError(`D1 ${label} blob encoding is invalid`);
    return bytes;
  }
  throw new UnsupportedError(`D1 ${label} values must be JSON scalars or blobs`);
}

function expression(table: D1Table, field: string): string {
  return `t.${quoteIdentifier(fieldColumn(table, field), "column name")}`;
}

function filterSql<T>(filter: QueryFilter<T>, table: D1Table, args: (string | number | null | ArrayBuffer | ArrayBufferView)[]): string {
  const expr = expression(table, String(filter.field));
  const bind = (value: unknown): string => { args.push(sqlValue(value, "filter")); return "?"; };
  switch (filter.operator) {
    case "==": return filter.value === null ? `${expr} IS NULL` : `${expr} = ${bind(filter.value)}`;
    case "!=": return filter.value === null ? `${expr} IS NOT NULL` : `${expr} != ${bind(filter.value)}`;
    case "<": return `${expr} < ${bind(filter.value)}`;
    case "<=": return `${expr} <= ${bind(filter.value)}`;
    case ">": return `${expr} > ${bind(filter.value)}`;
    case ">=": return `${expr} >= ${bind(filter.value)}`;
    case "in":
    case "not-in": {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > maxMembership) {
        throw new UnsupportedError(`D1 ${filter.operator} filters require 1 to ${String(maxMembership)} values`);
      }
      return `${expr} ${filter.operator === "not-in" ? "NOT IN" : "IN"} (${filter.value.map(bind).join(", ")})`;
    }
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`D1 query operator: ${filter.operator}`);
  }
}

function orderedFields<T>(orders: readonly QueryOrder<T>[], table: D1Table): readonly string[] {
  const fields = orders.map((order) => String(order.field));
  for (const field of fields) fieldColumn(table, field);
  const tieFields = table.primaryKey.length > 0 ? table.primaryKey : Object.keys(table.columns);
  return [...fields, ...tieFields.filter((field) => !fields.includes(field))];
}

/** Compile one bounded, top-level DALgo query into parameterized SQLite SQL. */
export function compileD1Query<T>(
  table: D1Table,
  query: StructuredQuery<T>,
  limit: number,
  projection: readonly string[] = Object.keys(table.columns),
): CompiledD1Query {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("D1 nested or collection-group queries");
  if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("D1 DALgo query cursors");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("D1 query limit must be a positive safe integer");
  const fields = [...new Set([...projection, ...table.primaryKey])];
  if (fields.length === 0) throw new TypeError("D1 projections must include at least one field");
  const selected = fields.map((field) => `${expression(table, field)} AS ${quoteIdentifier(field, "mapped field")}`);
  const args: (string | number | null | ArrayBuffer | ArrayBufferView)[] = [];
  const clauses = query.filters.map((filter) => filterSql(filter, table, args));
  if (args.length > maxBoundValues) throw new UnsupportedError(`D1 queries support at most ${String(maxBoundValues)} bound values`);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const ordered = orderedFields(query.orders, table);
  const order = ordered.length === 0 ? "" : ` ORDER BY ${ordered.map((field, index) => {
    const direction = query.orders[index]?.direction ?? "asc";
    return `${expression(table, field)} ${direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ")}`;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("D1 query offset must be a non-negative safe integer");
  return {
    sql: `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table.table, "table name")} AS t${where}${order} LIMIT ${String(limit)} OFFSET ${String(offset)}`,
    args,
    fields,
  };
}

export function compileD1Request(table: D1Table, request: D1QueryRequest, maxLimit: number): CompiledD1Query {
  if (!Number.isSafeInteger(request.limit ?? maxLimit) || (request.limit ?? maxLimit) < 1 || (request.limit ?? maxLimit) > maxLimit) {
    throw new RangeError(`D1 request limit must be a positive safe integer no greater than ${String(maxLimit)}`);
  }
  if (!Number.isSafeInteger(request.offset ?? 0) || (request.offset ?? 0) < 0) throw new TypeError("D1 request offset must be a non-negative safe integer");
  const fields = request.columns ?? Object.keys(table.columns);
  if (!Array.isArray(fields) || fields.length === 0) throw new TypeError("D1 request columns must be a non-empty array");
  const filters = request.filters ?? [];
  const orders = request.orders ?? [];
  const query: StructuredQuery<Record<string, unknown>> = {
    source: { kind: "collection", name: request.collection },
    filters: filters.map((filter) => ({ field: filter.field, operator: filter.operator, value: filter.value })),
    orders: orders.map((order) => ({ field: order.field, direction: order.direction })),
    limit: request.limit ?? maxLimit,
    offset: request.offset ?? 0,
  };
  return compileD1Query(table, query, request.limit ?? maxLimit, fields);
}

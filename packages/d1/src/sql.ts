import { UnsupportedError, type StructuredQuery } from "@dalgo/core";
import { compileSqlQuery, quoteIdentifier, validateIdentifier, type CompiledSqlQuery, type SqlDialect } from "@dalgo/sqlite-sql";
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

export type CompiledD1Query = CompiledSqlQuery;

const d1Dialect: SqlDialect = { name: "D1", unsupported: (capability) => new UnsupportedError(capability) };

export { quoteIdentifier, validateIdentifier };

/** Compile one bounded, top-level DALgo query into parameterized SQLite SQL. */
export function compileD1Query<T>(
  table: D1Table,
  query: StructuredQuery<T>,
  limit: number,
  projection: readonly string[] = Object.keys(table.columns),
): CompiledD1Query {
  return compileSqlQuery(d1Dialect, table, query, limit, projection);
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

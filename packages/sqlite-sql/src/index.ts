import type { DOCUMENT_ID, QueryFilter, QueryOrder, StructuredQuery } from "@dalgo/core";

/**
 * Shared DALgo-to-SQLite query compiler used by `@dalgo/d1` and
 * `@dalgo/sqlite-wasm`. It depends on `@dalgo/core` for types only, so each
 * adapter supplies its own error constructors through a {@link SqlDialect} and
 * errors keep the identity of the adapter's own core instance.
 */

const documentId: typeof DOCUMENT_ID = "__name__";

export interface SqlColumn {
  /** Physical SQLite column name. The DALgo field name is the object key. */
  readonly column: string;
}

export interface SqlTable {
  /** Physical SQLite table name. */
  readonly table: string;
  /** Explicit DALgo field to physical column mapping. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
  /** DALgo field names that form the primary key, in database key order. */
  readonly primaryKey: readonly string[];
}

export type SqlBindValue = string | number | null | ArrayBuffer | ArrayBufferView;

export interface CompiledSqlQuery {
  readonly sql: string;
  readonly args: readonly SqlBindValue[];
  readonly fields: readonly string[];
}

/** Adapter-specific message prefix and error constructor. */
export interface SqlDialect {
  /** Prefix for error messages, for example `D1` or `SQLite`. */
  readonly name: string;
  /** Creates the adapter's DALgo `UnsupportedError` for a capability. */
  unsupported(capability: string): Error;
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

export function fieldColumn(dialect: SqlDialect, table: SqlTable, field: string): string {
  if (field === documentId) {
    if (table.primaryKey.length !== 1) throw dialect.unsupported(`${dialect.name} DOCUMENT_ID filters and orders require a single-column primary key`);
    const keyField = table.primaryKey[0];
    if (keyField === undefined) throw new TypeError(`${dialect.name} primary key configuration is invalid`);
    return table.columns[keyField]?.column ?? keyField;
  }
  const column = table.columns[field];
  if (column === undefined) throw dialect.unsupported(`${dialect.name} field is not declared in the table mapping: ${field}`);
  return column.column;
}

function isBlobObject(value: object): value is { readonly $type: "blob"; readonly base64: string } {
  return !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 2 &&
    (value as { readonly $type?: unknown }).$type === "blob" && typeof (value as { readonly base64?: unknown }).base64 === "string";
}

/** Converts one DALgo filter value to a SQLite bind value without coercing JSON structures. */
export function sqlValue(dialect: SqlDialect, value: unknown, label: string): SqlBindValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw dialect.unsupported(`${dialect.name} ${label} integral numbers must be JavaScript safe integers`);
    return value;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (typeof value === "object" && isBlobObject(value)) {
    let binary: string;
    try { binary = atob(value.base64); } catch { throw dialect.unsupported(`${dialect.name} ${label} blob encoding is invalid`); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    let canonical = "";
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    if (btoa(canonical) !== value.base64) throw dialect.unsupported(`${dialect.name} ${label} blob encoding is invalid`);
    return bytes;
  }
  throw dialect.unsupported(`${dialect.name} ${label} values must be JSON scalars or blobs`);
}

function expression(dialect: SqlDialect, table: SqlTable, field: string): string {
  return `t.${quoteIdentifier(fieldColumn(dialect, table, field), "column name")}`;
}

function filterSql<T>(dialect: SqlDialect, filter: QueryFilter<T>, table: SqlTable, args: SqlBindValue[]): string {
  const expr = expression(dialect, table, String(filter.field));
  const bind = (value: unknown): string => { args.push(sqlValue(dialect, value, "filter")); return "?"; };
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
        throw dialect.unsupported(`${dialect.name} ${filter.operator} filters require 1 to ${String(maxMembership)} values`);
      }
      return `${expr} ${filter.operator === "not-in" ? "NOT IN" : "IN"} (${filter.value.map(bind).join(", ")})`;
    }
    case "array-contains":
    case "array-contains-any":
      throw dialect.unsupported(`${dialect.name} query operator: ${filter.operator}`);
  }
}

function orderedFields<T>(dialect: SqlDialect, orders: readonly QueryOrder<T>[], table: SqlTable): readonly string[] {
  const fields = orders.map((order) => String(order.field));
  for (const field of fields) fieldColumn(dialect, table, field);
  const tieFields = table.primaryKey.length > 0 ? table.primaryKey : Object.keys(table.columns);
  return [...fields, ...tieFields.filter((field) => !fields.includes(field))];
}

/** Compile one bounded, top-level DALgo query into parameterized SQLite SQL. */
export function compileSqlQuery<T>(
  dialect: SqlDialect,
  table: SqlTable,
  query: StructuredQuery<T>,
  limit: number,
  projection: readonly string[] = Object.keys(table.columns),
): CompiledSqlQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw dialect.unsupported(`${dialect.name} nested or collection-group queries`);
  if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw dialect.unsupported(`${dialect.name} DALgo query cursors`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${dialect.name} query limit must be a positive safe integer`);
  const fields = [...new Set([...projection, ...table.primaryKey])];
  if (fields.length === 0) throw new TypeError(`${dialect.name} projections must include at least one field`);
  const selected = fields.map((field) => `${expression(dialect, table, field)} AS ${quoteIdentifier(field, "mapped field")}`);
  const args: SqlBindValue[] = [];
  const clauses = query.filters.map((filter) => filterSql(dialect, filter, table, args));
  if (args.length > maxBoundValues) throw dialect.unsupported(`${dialect.name} queries support at most ${String(maxBoundValues)} bound values`);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  // Reaching this point proves at least one declared column, so the tie-break
  // order is never empty.
  const order = ` ORDER BY ${orderedFields(dialect, query.orders, table).map((field, index) => {
    const direction = query.orders[index]?.direction ?? "asc";
    return `${expression(dialect, table, field)} ${direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ")}`;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`${dialect.name} query offset must be a non-negative safe integer`);
  return {
    sql: `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table.table, "table name")} AS t${where}${order} LIMIT ${String(limit)} OFFSET ${String(offset)}`,
    args,
    fields,
  };
}

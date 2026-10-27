import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dalgo/core";

import type { LibSQLColumn, LibSQLKeyType, LibSQLTable, NativeLibSQLTable } from "./types.js";

export type LibSQLScalar = boolean | number | string | null;
export type LibSQLKeyValue = string | number;
export type LibSQLCursorScalar = string | number | null;

export interface CompiledLibSQLQuery {
  readonly sql: string;
  readonly args: readonly LibSQLScalar[];
  readonly cursorColumns: readonly LibSQLColumn[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_KEY_CHARS = 4_096;
const MAX_CURSOR_CHARS = 65_536;

export function validateIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`);
}

export function quoteIdentifier(value: string, label: string): string {
  validateIdentifier(value, label);
  return `"${value}"`;
}

/** Restricts JavaScript numbers to values the JSON Hrana value mapping can round-trip losslessly. */
export function libSQLScalar(value: unknown, label: string): LibSQLScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsupportedError(`libSQL ${label} numbers must be finite`);
    if (Object.is(value, -0)) throw new UnsupportedError(`libSQL ${label} numbers must not be negative zero`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new UnsupportedError(`libSQL ${label} integral numbers must be JavaScript safe integers`);
    }
    return value;
  }
  throw new UnsupportedError(`libSQL ${label} values must be null, boolean, finite numbers, or strings`);
}

/** Validates one native key exactly as stored, never converting between text and numbers. */
export function libSQLNativeKey(value: unknown, type: LibSQLKeyType, label: string): LibSQLKeyValue {
  if (type === "text") {
    if (typeof value !== "string") throw new UnsupportedError(`libSQL ${label} keys must be strings for a text key column`);
    if (value.length === 0 || value.length > MAX_KEY_CHARS) throw new UnsupportedError(`libSQL ${label} keys must be 1 to ${String(MAX_KEY_CHARS)} characters`);
    return value;
  }
  if (typeof value !== "number") throw new UnsupportedError(`libSQL ${label} keys must be numbers for a ${type} key column`);
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new UnsupportedError(`libSQL ${label} keys must be finite and not negative zero`);
  if (type === "integer" && !Number.isSafeInteger(value)) {
    throw new UnsupportedError(`libSQL ${label} integer keys must be JavaScript safe integers`);
  }
  return value;
}

/** Validates one cursor position exactly, including the configured byte budget. */
export function libSQLCursorPosition(value: unknown, maximum: number, label: string): LibSQLCursorScalar {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > maximum) throw new UnsupportedError(`libSQL ${label} cursor values exceed maxCursorBytes`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new UnsupportedError(`libSQL ${label} cursor numbers must be finite and not negative zero`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new UnsupportedError(`libSQL ${label} integral cursor values must be JavaScript safe integers`);
    }
    return value;
  }
  throw new UnsupportedError(`libSQL ${label} cursor values must be null, strings, or finite numbers`);
}

function columnForField(table: LibSQLTable, field: string): LibSQLColumn {
  if (field === DOCUMENT_ID) return table.keyColumn;
  const column = table.columns[field];
  if (column === undefined) throw new UnsupportedError(`libSQL field is not declared in the table mapping: ${field}`);
  return column;
}

function expression(column: LibSQLColumn): string { return `t.${quoteIdentifier(column.column, "column name")}`; }
function parameter(args: LibSQLScalar[], value: unknown): string { args.push(libSQLScalar(value, "parameter")); return "?"; }

function filterSql<T>(filter: QueryFilter<T>, table: LibSQLTable, args: LibSQLScalar[]): string {
  const isKey = String(filter.field) === DOCUMENT_ID;
  if (isKey && filter.value !== null && typeof filter.value !== "string" && typeof filter.value !== "number") {
    throw new UnsupportedError("libSQL DOCUMENT_ID filters require a string or number key");
  }
  const expr = expression(columnForField(table, String(filter.field)));
  switch (filter.operator) {
    case "==": return filter.value === null ? `${expr} IS NULL` : `${expr} = ${parameter(args, filter.value)}`;
    case "!=": return filter.value === null ? `${expr} IS NOT NULL` : `${expr} IS NOT NULL AND ${expr} != ${parameter(args, filter.value)}`;
    case "<": return `${expr} < ${parameter(args, filter.value)}`;
    case "<=": return `${expr} <= ${parameter(args, filter.value)}`;
    case ">": return `${expr} > ${parameter(args, filter.value)}`;
    case ">=": return `${expr} >= ${parameter(args, filter.value)}`;
    case "in":
    case "not-in":
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`libSQL SQL query operator: ${filter.operator}`);
  }
}

function orderedColumns<T>(orders: readonly QueryOrder<T>[], table: LibSQLTable): readonly LibSQLColumn[] {
  const fields = orders.map((order) => columnForField(table, String(order.field)));
  return fields.some((column) => column.column === table.keyColumn.column) ? fields : [...fields, table.keyColumn];
}

function orderSql<T>(orders: readonly QueryOrder<T>[], columns: readonly LibSQLColumn[]): string {
  return columns.map((column, index) => {
    const direction = orders[index]?.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") throw new TypeError("libSQL order direction must be asc or desc");
    return `${expression(column)} ${direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ");
}

function cursorSql<T>(
  query: StructuredQuery<T>,
  table: LibSQLTable,
  columns: readonly LibSQLColumn[],
  args: LibSQLScalar[],
  maxCursorChars: number,
): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("libSQL inclusive or end cursors");
  if (query.startAfter === undefined) return undefined;
  if (query.orders.length === 0) throw new UnsupportedError("libSQL startAfter without an explicit order");
  if (query.startAfter.values.length !== columns.length) throw new TypeError("libSQL cursor must include every order field and the key tie-breaker");
  const clauses: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = query.startAfter.values[index];
    if (column === undefined) throw new Error("libSQL cursor column missing");
    const isKey = column.column === table.keyColumn.column;
    if (!isKey && column.nullable !== false) throw new UnsupportedError(`libSQL paginated order requires nullable: false for ${column.column}`);
    if (value === undefined || value === null) throw new UnsupportedError("libSQL null or undefined cursor values");
    if (isKey) {
      if (typeof value !== "string" && typeof value !== "number") throw new UnsupportedError("libSQL key cursor position must be a string or number");
      if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) throw new UnsupportedError("libSQL key cursor numbers must be finite and not negative zero");
      if (typeof value === "string" && value.length > maxCursorChars) throw new UnsupportedError("libSQL key cursor values exceed maxCursorBytes");
    } else {
      libSQLCursorPosition(value, maxCursorChars, "legacy");
    }
    const previous = columns.slice(0, index).map((prior, priorIndex) => {
      const priorValue = query.startAfter?.values[priorIndex];
      if (priorValue === undefined || priorValue === null) throw new UnsupportedError("libSQL null or undefined cursor values");
      return `${expression(prior)} = ${parameter(args, priorValue)}`;
    });
    const direction = query.orders[index]?.direction ?? "asc";
    clauses.push(`(${[...previous, `${expression(column)} ${direction === "desc" ? "<" : ">"} ${parameter(args, value)}`].join(" AND ")})`);
  }
  return `(${clauses.join(" OR ")})`;
}

/** Compile one bounded top-level DALgo query to SQLite SQL with positional bindings. */
export function compileLibSQLQuery<T>(
  table: LibSQLTable,
  query: StructuredQuery<T>,
  limit: number,
  maxCursorChars = MAX_CURSOR_CHARS,
): CompiledLibSQLQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("libSQL nested or collection-group queries");
  if (query.offset !== undefined) throw new UnsupportedError("libSQL query offsets");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("libSQL query limit must be a positive safe integer");
  const args: LibSQLScalar[] = [];
  const clauses = query.filters.map((filter) => filterSql(filter, table, args));
  const columns = orderedColumns(query.orders, table);
  // A DALgo key is a non-null identity; only explicit order fields need the
  // caller's nullable: false assertion. The implicit key tie-breaker (and an
  // unordered modern page ordered by that key) stays usable without it.
  if (query.orders.length > 0) {
    for (const column of columns) {
      if (column.column !== table.keyColumn.column && column.nullable !== false) {
        throw new UnsupportedError(`libSQL ordered query requires nullable: false for ${column.column}`);
      }
    }
  }
  const cursor = cursorSql(query, table, columns, args, maxCursorChars);
  if (cursor !== undefined) clauses.push(cursor);
  const projection = [
    `${expression(table.keyColumn)} AS "__dalgo_key"`,
    ...Object.entries(table.columns).map(([field, column]) => `${expression(column)} AS ${quoteIdentifier(field, "mapped field")}`),
  ];
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = query.orders.length === 0 ? "" : ` ORDER BY ${orderSql(query.orders, columns)}`;
  return { sql: `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(table.table, "table")} AS t${where}${order} LIMIT ${String(limit)}`, args, cursorColumns: columns };
}

/* ------------------------------------------------------------------------- */
/* Native read-only keyset compiler                                          */
/* ------------------------------------------------------------------------- */

export interface NativeLibSQLOrder {
  readonly field: string;
  readonly column: string;
  readonly direction: "asc" | "desc";
}

export interface CompiledNativeLibSQLQuery {
  readonly sql: string;
  readonly args: readonly LibSQLScalar[];
  readonly orders: readonly NativeLibSQLOrder[];
}

function nativeExpression(column: string): string { return `t.${quoteIdentifier(column, "column name")}`; }

function nativeFieldColumn(table: NativeLibSQLTable, field: string): string {
  if (field === DOCUMENT_ID) return table.key.column;
  const column = table.columns[field];
  if (column === undefined) throw new UnsupportedError(`libSQL native field is not declared in the table allowlist: ${field}`);
  return column.column;
}

function nativeOrderColumns<T>(table: NativeLibSQLTable, orders: readonly QueryOrder<T>[]): readonly NativeLibSQLOrder[] {
  if (orders.length === 0) return Object.freeze([]);
  const mapped: NativeLibSQLOrder[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    if (order.direction !== "asc" && order.direction !== "desc") throw new TypeError("libSQL native order direction must be asc or desc");
    const column = nativeFieldColumn(table, String(order.field));
    if (seen.has(column)) throw new UnsupportedError("libSQL native duplicate query order columns");
    seen.add(column);
    mapped.push({ field: String(order.field), column, direction: order.direction });
  }
  const keyIndex = mapped.findIndex((order) => order.column === table.key.column);
  if (keyIndex !== -1 && keyIndex !== mapped.length - 1) {
    throw new UnsupportedError("libSQL native key tie-breaker must be the final order column");
  }
  if (keyIndex === -1) mapped.push({ field: DOCUMENT_ID, column: table.key.column, direction: "asc" });
  return Object.freeze(mapped);
}

function nativeOrderSql(orders: readonly NativeLibSQLOrder[]): string {
  return orders.map((order) => {
    // SQLite defaults to NULLS FIRST for ASC and NULLS LAST for DESC. The
    // clauses are explicit so the keyset predicate below and the ordering can
    // never disagree because of a compile-time default.
    return `${nativeExpression(order.column)} ${order.direction === "desc" ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`;
  }).join(", ");
}

function nativeEquality(order: NativeLibSQLOrder, value: LibSQLCursorScalar, args: LibSQLScalar[]): string {
  return value === null ? `${nativeExpression(order.column)} IS NULL` : `${nativeExpression(order.column)} = ${parameter(args, value)}`;
}

function nativeCursorSql<T>(
  table: NativeLibSQLTable,
  query: StructuredQuery<T>,
  orders: readonly NativeLibSQLOrder[],
  maxCursorChars: number,
  args: LibSQLScalar[],
): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("libSQL native inclusive or end cursors");
  }
  if (query.startAfter === undefined) return undefined;
  if (orders.length === 0) throw new UnsupportedError("libSQL native startAfter without an explicit order");
  if (query.startAfter.values.length !== orders.length) throw new TypeError("libSQL native cursor must include every order field and the key tie-breaker");
  const terms: string[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const raw = query.startAfter.values[index];
    if (order === undefined) throw new Error("libSQL native cursor column missing");
    const value = order.column === table.key.column
      ? libSQLNativeKey(raw, table.key.type, "cursor")
      : libSQLCursorPosition(raw, maxCursorChars, "native");
    if (order.column === table.key.column && value === null) throw new UnsupportedError("libSQL native key cursor values cannot be null");
    if (typeof value === "string" && value.length > maxCursorChars) throw new UnsupportedError("libSQL native cursor values exceed maxCursorBytes");
    const prefix = orders.slice(0, index).map((prior, priorIndex) => {
      const priorValue = query.startAfter?.values[priorIndex];
      const priorScalar = prior.column === table.key.column
        ? libSQLNativeKey(priorValue, table.key.type, "cursor")
        : libSQLCursorPosition(priorValue, maxCursorChars, "native");
      if (typeof priorScalar === "string" && priorScalar.length > maxCursorChars) {
        throw new UnsupportedError("libSQL native cursor values exceed maxCursorBytes");
      }
      return nativeEquality(prior, priorScalar, args);
    });
    const expr = nativeExpression(order.column);
    if (order.direction === "asc") {
      // NULLs sort first. After a NULL position every non-NULL value is next;
      // after a non-NULL position only greater non-NULL values remain.
      const branch = value === null ? `${expr} IS NOT NULL` : `${expr} > ${parameter(args, value)}`;
      terms.push(`(${[...prefix, branch].join(" AND ")})`);
    } else if (value !== null) {
      // NULLs sort last. After a NULL position nothing remains; after a
      // non-NULL position smaller values and every NULL remain.
      terms.push(`(${[...prefix, `(${expr} < ${parameter(args, value)} OR ${expr} IS NULL)`].join(" AND ")})`);
    }
  }
  if (terms.length === 0) return "0";
  return `(${terms.join(" OR ")})`;
}

function nativeFilterSql<T>(table: NativeLibSQLTable, filter: QueryFilter<T>, args: LibSQLScalar[]): string {
  const field = String(filter.field);
  const isKey = field === DOCUMENT_ID;
  if (isKey) {
    if (filter.value === null) throw new UnsupportedError("libSQL native DOCUMENT_ID filters cannot test NULL");
    libSQLNativeKey(filter.value, table.key.type, "filter");
  }
  const expr = nativeExpression(nativeFieldColumn(table, field));
  switch (filter.operator) {
    case "==": return filter.value === null ? `${expr} IS NULL` : `${expr} = ${parameter(args, filter.value)}`;
    case "!=": return filter.value === null ? `${expr} IS NOT NULL` : `${expr} IS NOT NULL AND ${expr} != ${parameter(args, filter.value)}`;
    case "<": return `${expr} < ${parameter(args, filter.value)}`;
    case "<=": return `${expr} <= ${parameter(args, filter.value)}`;
    case ">": return `${expr} > ${parameter(args, filter.value)}`;
    case ">=": return `${expr} >= ${parameter(args, filter.value)}`;
    case "in":
    case "not-in":
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`libSQL native SQL query operator: ${filter.operator}`);
  }
}

/**
 * Compile one bounded native read query with a null-aware deterministic keyset.
 *
 * SQLite orders NULLs first for ASC and last for DESC; the predicate follows
 * that exact rule, so nullable order columns are paginated honestly rather than
 * silently refused or treated as non-null.
 */
export function compileNativeLibSQLQuery<T>(
  table: NativeLibSQLTable,
  query: StructuredQuery<T>,
  limit: number,
  maxCursorChars = MAX_CURSOR_CHARS,
): CompiledNativeLibSQLQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) {
    throw new UnsupportedError("libSQL native collection-group or nested-collection queries");
  }
  if (query.offset !== undefined) throw new UnsupportedError("libSQL native query offsets");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("libSQL native query limit must be a positive safe integer");
  const args: LibSQLScalar[] = [];
  const clauses = query.filters.map((filter) => nativeFilterSql(table, filter, args));
  const orders = nativeOrderColumns(table, query.orders);
  const cursor = nativeCursorSql(table, query, orders, maxCursorChars, args);
  if (cursor !== undefined) clauses.push(cursor);
  const projection = [
    `${nativeExpression(table.key.column)} AS "__dalgo_key"`,
    ...Object.entries(table.columns).map(([field, column]) => `${nativeExpression(column.column)} AS ${quoteIdentifier(field, "mapped field")}`),
  ];
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = orders.length === 0 ? "" : ` ORDER BY ${nativeOrderSql(orders)}`;
  return {
    sql: `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(table.table, "table")} AS t${where}${order} LIMIT ${String(limit)}`,
    args,
    orders,
  };
}

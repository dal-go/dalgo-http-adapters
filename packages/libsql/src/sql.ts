import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dal-go/dalgo";
import type { LibSQLColumn, LibSQLTable } from "./types.js";

export type LibSQLScalar = boolean | number | string | null;

export interface CompiledLibSQLQuery {
  readonly sql: string;
  readonly args: readonly LibSQLScalar[];
  readonly cursorColumns: readonly LibSQLColumn[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validateIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`);
}

export function quoteIdentifier(value: string, label: string): string {
  validateIdentifier(value, label);
  return `"${value}"`;
}

/** Restricts JavaScript numbers to values the JSON Hrana value mapping can round-trip. */
export function libSQLScalar(value: unknown, label: string): LibSQLScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new UnsupportedError(`libSQL SQL ${label} integral numbers must be JavaScript safe integers`);
    }
    return value;
  }
  throw new UnsupportedError(`libSQL SQL ${label} values must be null, boolean, finite numbers, or strings`);
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
  if (isKey && typeof filter.value !== "string") throw new UnsupportedError("libSQL DOCUMENT_ID filters require a string key");
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

function cursorSql<T>(query: StructuredQuery<T>, table: LibSQLTable, columns: readonly LibSQLColumn[], args: LibSQLScalar[]): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("libSQL inclusive or end cursors");
  if (query.startAfter === undefined) return undefined;
  if (query.orders.length === 0) throw new UnsupportedError("libSQL startAfter without an explicit order");
  if (query.startAfter.values.length !== columns.length) throw new TypeError("libSQL cursor must include every order field and the key tie-breaker");
  const clauses: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = query.startAfter.values[index];
    if (column === undefined) throw new Error("libSQL cursor column missing");
    if (column.nullable !== false) throw new UnsupportedError(`libSQL paginated order requires nullable: false for ${column.column}`);
    if (value === undefined || value === null) throw new UnsupportedError("libSQL null or undefined cursor values");
    if (column.column === table.keyColumn.column && typeof value !== "string") throw new UnsupportedError("libSQL key cursor position must be a string");
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
export function compileLibSQLQuery<T>(table: LibSQLTable, query: StructuredQuery<T>, limit: number): CompiledLibSQLQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("libSQL nested or collection-group queries");
  if (query.offset !== undefined) throw new UnsupportedError("libSQL query offsets");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("libSQL query limit must be a positive safe integer");
  const args: LibSQLScalar[] = [];
  const clauses = query.filters.map((filter) => filterSql(filter, table, args));
  const columns = orderedColumns(query.orders, table);
  if (query.orders.length > 0) for (const column of columns) if (column.nullable !== false) throw new UnsupportedError(`libSQL ordered query requires nullable: false for ${column.column}`);
  const cursor = cursorSql(query, table, columns, args);
  if (cursor !== undefined) clauses.push(cursor);
  const projection = [
    `${expression(table.keyColumn)} AS "__dalgo_key"`,
    ...Object.entries(table.columns).map(([field, column]) => `${expression(column)} AS ${quoteIdentifier(field, "mapped field")}`),
  ];
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = query.orders.length === 0 ? "" : ` ORDER BY ${orderSql(query.orders, columns)}`;
  return { sql: `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(table.table, "table")} AS t${where}${order} LIMIT ${String(limit)}`, args, cursorColumns: columns };
}

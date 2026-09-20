import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dal-go/dalgo";
import type { InfluxDB3Column, InfluxDB3Table } from "./types.js";

export interface CompiledInfluxDB3Query {
  readonly sql: string;
  readonly params: Readonly<Record<string, boolean | number | string | null>>;
  readonly cursorColumns: readonly InfluxDB3Column[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validateIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`);
}

function quote(value: string, label: string): string {
  validateIdentifier(value, label);
  return `"${value}"`;
}

function scalar(value: unknown, label: string): boolean | number | string | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new UnsupportedError(`InfluxDB 3 SQL ${label} values must be null, boolean, finite numbers, or strings`);
}

function columnForField(table: InfluxDB3Table, field: string): InfluxDB3Column {
  if (field === DOCUMENT_ID) return table.keyColumn;
  const column = table.columns[field];
  if (column === undefined) throw new UnsupportedError(`InfluxDB 3 field is not declared in the table mapping: ${field}`);
  return column;
}

function expression(column: InfluxDB3Column): string {
  return `t.${quote(column.column, "column name")}`;
}

function addParameter(params: Record<string, boolean | number | string | null>, name: string, value: unknown): string {
  params[name] = scalar(value, "parameter");
  return `$${name}`;
}

function filterSql<T>(filter: QueryFilter<T>, table: InfluxDB3Table, index: number, params: Record<string, boolean | number | string | null>): string {
  const isKey = String(filter.field) === DOCUMENT_ID;
  if (isKey && typeof filter.value !== "string") throw new UnsupportedError("InfluxDB 3 DOCUMENT_ID filters require a string key");
  const expr = expression(columnForField(table, String(filter.field)));
  const name = `p${String(index)}`;
  switch (filter.operator) {
    case "==": return filter.value === null ? `${expr} IS NULL` : `${expr} = ${addParameter(params, name, filter.value)}`;
    case "!=": return filter.value === null ? `${expr} IS NOT NULL` : `${expr} IS NOT NULL AND ${expr} != ${addParameter(params, name, filter.value)}`;
    case "<": return `${expr} < ${addParameter(params, name, filter.value)}`;
    case "<=": return `${expr} <= ${addParameter(params, name, filter.value)}`;
    case ">": return `${expr} > ${addParameter(params, name, filter.value)}`;
    case ">=": return `${expr} >= ${addParameter(params, name, filter.value)}`;
    case "in":
    case "not-in":
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`InfluxDB 3 SQL query operator: ${filter.operator}`);
  }
}

function orderedColumns<T>(orders: readonly QueryOrder<T>[], table: InfluxDB3Table): readonly InfluxDB3Column[] {
  const fields = orders.map((order) => columnForField(table, String(order.field)));
  return fields.some((column) => column.column === table.keyColumn.column) ? fields : [...fields, table.keyColumn];
}

function orderSql<T>(orders: readonly QueryOrder<T>[], columns: readonly InfluxDB3Column[]): string {
  return columns.map((column, index) => {
    const direction = orders[index]?.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") throw new TypeError("InfluxDB 3 order direction must be asc or desc");
    return `${expression(column)} ${direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ");
}

function cursorSql<T>(query: StructuredQuery<T>, table: InfluxDB3Table, columns: readonly InfluxDB3Column[], params: Record<string, boolean | number | string | null>): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("InfluxDB 3 inclusive or end cursors");
  if (query.startAfter === undefined) return undefined;
  if (query.orders.length === 0) throw new UnsupportedError("InfluxDB 3 startAfter without an explicit order");
  if (query.startAfter.values.length !== columns.length) throw new TypeError("InfluxDB 3 cursor must include every order field and the key tie-breaker");
  const clauses: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = query.startAfter.values[index];
    if (column === undefined) throw new Error("InfluxDB 3 cursor column missing");
    if (column.nullable !== false) throw new UnsupportedError(`InfluxDB 3 paginated order requires nullable: false for ${column.column}`);
    if (value === undefined || value === null) throw new UnsupportedError("InfluxDB 3 null or undefined cursor values");
    if (column.column === table.keyColumn.column && typeof value !== "string") throw new UnsupportedError("InfluxDB 3 key cursor position must be a string");
    const previous = columns.slice(0, index).map((prior, priorIndex) => `${expression(prior)} = $c${String(priorIndex)}`);
    addParameter(params, `c${String(index)}`, value);
    const direction = query.orders[index]?.direction ?? "asc";
    clauses.push(`(${[...previous, `${expression(column)} ${direction === "desc" ? "<" : ">"} $c${String(index)}`].join(" AND ")})`);
  }
  return `(${clauses.join(" OR ")})`;
}

/** Compile one bounded DALgo query into InfluxDB 3 SQL and named WHERE parameters. */
export function compileInfluxDB3Query<T>(table: InfluxDB3Table, query: StructuredQuery<T>, limit: number, offset?: number): CompiledInfluxDB3Query {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("InfluxDB 3 nested or collection-group queries");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("InfluxDB 3 query limit must be a positive safe integer");
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new TypeError("InfluxDB 3 offset must be a non-negative safe integer");
  const params: Record<string, boolean | number | string | null> = {};
  const clauses = query.filters.map((filter, index) => filterSql(filter, table, index, params));
  const columns = orderedColumns(query.orders, table);
  if (query.orders.length > 0) {
    for (const column of columns) if (column.nullable !== false) throw new UnsupportedError(`InfluxDB 3 ordered query requires nullable: false for ${column.column}`);
  }
  const cursor = cursorSql(query, table, columns, params);
  if (cursor !== undefined) clauses.push(cursor);
  const projection = [
    `${expression(table.keyColumn)} AS "__dalgo_key"`,
    ...Object.entries(table.columns).map(([field, column]) => `${expression(column)} AS ${quote(field, "mapped field")}`),
  ];
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = query.orders.length === 0 ? "" : ` ORDER BY ${orderSql(query.orders, columns)}`;
  const offsetSql = offset === undefined || offset === 0 ? "" : ` OFFSET ${String(offset)}`;
  return { sql: `SELECT ${projection.join(", ")} FROM ${quote(table.table, "table") } AS t${where}${order} LIMIT ${String(limit)}${offsetSql}`, params, cursorColumns: columns };
}

import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type QueryOrder, type StructuredQuery } from "@dal-go/dalgo";
import type { BigQueryColumn, BigQueryScalarType, BigQueryTable } from "./types.js";

export interface BigQueryParameter {
  readonly name: string;
  readonly parameterType: { readonly type: BigQueryScalarType | "ARRAY"; readonly arrayType?: { readonly type: BigQueryScalarType } };
  readonly parameterValue: { readonly value?: string; readonly arrayValues?: readonly { readonly value?: string }[] };
}

export interface CompiledBigQueryQuery {
  readonly sql: string;
  readonly parameters: readonly BigQueryParameter[];
  readonly cursorColumns: readonly BigQueryColumn[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validateIdentifier(value: string, label: string): void {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple BigQuery identifier`);
}

/** Google project IDs may contain hyphens, unlike dataset/table/column identifiers. */
export function validateProjectId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,61}$/u.test(value)) {
    throw new TypeError("projectId must contain only letters, numbers, and hyphens");
  }
}

function quoteIdentifier(value: string, label: string): string {
  validateIdentifier(value, label);
  return `\`${value}\``;
}

export function quoteTable(projectId: string, table: BigQueryTable): string {
  validateProjectId(projectId);
  validateIdentifier(table.datasetId, "datasetId");
  validateIdentifier(table.tableId, "tableId");
  return `\`${projectId}.${table.datasetId}.${table.tableId}\``;
}

function scalarValue(value: unknown, type: BigQueryScalarType): { readonly value?: string } {
  if (value === undefined) throw new TypeError(`${type} parameters cannot be undefined`);
  if (value === null) return {};
  switch (type) {
    case "BOOL":
      if (typeof value === "boolean") return { value: value ? "true" : "false" };
      if (value === "true" || value === "false") return { value };
      throw new TypeError("BOOL parameters require a boolean or BigQuery wire boolean string");
    case "INT64":
      if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isSafeInteger(value))) {
        throw new TypeError("INT64 parameters require a decimal string or safe integer");
      }
      if (typeof value === "string" && !/^-?(?:0|[1-9]\d*)$/u.test(value)) {
        throw new TypeError("INT64 parameters require a decimal string or safe integer");
      }
      return { value: String(value) };
    case "FLOAT64":
      if (typeof value === "number" && Number.isFinite(value)) return { value: String(value) };
      if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) return { value };
      throw new TypeError("FLOAT64 parameters require a finite number or BigQuery wire float string");
    case "NUMERIC":
    case "BIGNUMERIC":
      if (typeof value !== "string" && typeof value !== "number") throw new TypeError(`${type} parameters require a decimal string or number`);
      if ((typeof value === "number" && !Number.isFinite(value)) || (typeof value === "string" && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))) {
        throw new TypeError(`${type} parameters require a finite decimal value`);
      }
      return { value: String(value) };
    case "JSON":
      if (typeof value === "string") return { value };
      return { value: JSON.stringify(value) };
    default:
      if (typeof value !== "string") throw new TypeError(`${type} parameters require a string`);
      return { value };
  }
}

export function parameter(name: string, column: BigQueryColumn, value: unknown): BigQueryParameter {
  return { name, parameterType: { type: column.type }, parameterValue: scalarValue(value, column.type) };
}

function arrayParameter(name: string, column: BigQueryColumn, values: unknown): BigQueryParameter {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("in and not-in filters require a non-empty array");
  if (values.some((value) => value === null)) throw new UnsupportedError("BigQuery membership filters containing null");
  return {
    name,
    parameterType: { type: "ARRAY", arrayType: { type: column.type } },
    parameterValue: { arrayValues: values.map((value) => scalarValue(value, column.type)) },
  };
}

function columnForField(table: BigQueryTable, field: string): BigQueryColumn {
  if (field === DOCUMENT_ID) return table.keyColumn;
  const column = table.columns[field];
  if (column === undefined) throw new UnsupportedError(`BigQuery field not declared in table mapping: ${field}`);
  return column;
}

function columnExpression(column: BigQueryColumn): string {
  return `t.${quoteIdentifier(column.column, "column name")}`;
}

function filterSql<T>(filter: QueryFilter<T>, table: BigQueryTable, index: number): { readonly sql: string; readonly parameter?: BigQueryParameter } {
  const column = columnForField(table, String(filter.field));
  const expr = columnExpression(column);
  const name = `p${String(index)}`;
  switch (filter.operator) {
    case "==": return filter.value === null
      ? { sql: `${expr} IS NULL` }
      : { sql: `${expr} = @${name}`, parameter: parameter(name, column, filter.value) };
    case "!=": return filter.value === null
      ? { sql: `${expr} IS NOT NULL` }
      : { sql: `${expr} IS NOT NULL AND ${expr} != @${name}`, parameter: parameter(name, column, filter.value) };
    case "<": return { sql: `${expr} < @${name}`, parameter: parameter(name, column, filter.value) };
    case "<=": return { sql: `${expr} <= @${name}`, parameter: parameter(name, column, filter.value) };
    case ">": return { sql: `${expr} > @${name}`, parameter: parameter(name, column, filter.value) };
    case ">=": return { sql: `${expr} >= @${name}`, parameter: parameter(name, column, filter.value) };
    case "in": return { sql: `${expr} IN UNNEST(@${name})`, parameter: arrayParameter(name, column, filter.value) };
    case "not-in": return { sql: `${expr} IS NOT NULL AND ${expr} NOT IN UNNEST(@${name})`, parameter: arrayParameter(name, column, filter.value) };
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`BigQuery ${filter.operator} filters on repeated columns`);
    default:
      throw new UnsupportedError(`BigQuery query operator: ${String(filter.operator)}`);
  }
}

function orderColumns<T>(orders: readonly QueryOrder<T>[], table: BigQueryTable): readonly BigQueryColumn[] {
  const columns = orders.map((order) => columnForField(table, String(order.field)));
  if (!columns.some((column) => column.column === table.keyColumn.column)) return [...columns, table.keyColumn];
  return columns;
}

function requireNonNullableCursorColumns(columns: readonly BigQueryColumn[]): void {
  for (const column of columns) {
    if (column.nullable !== false) {
      throw new UnsupportedError(`BigQuery paginated order requires nullable: false for ${column.column}`);
    }
  }
}

function orderSql<T>(orders: readonly QueryOrder<T>[], columns: readonly BigQueryColumn[]): string {
  return columns.map((column, index) => {
    const explicit = orders[index];
    if (explicit !== undefined && explicit.direction !== "asc" && explicit.direction !== "desc") {
      throw new TypeError("BigQuery order direction must be asc or desc");
    }
    return `${columnExpression(column)} ${explicit?.direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ");
}

function cursorSql<T>(query: StructuredQuery<T>, columns: readonly BigQueryColumn[], parameters: BigQueryParameter[]): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("BigQuery inclusive or end cursors");
  }
  if (query.startAfter === undefined) return undefined;
  if (query.orders.length === 0) throw new UnsupportedError("BigQuery startAfter without an explicit order");
  if (query.startAfter.values.length !== columns.length) {
    throw new TypeError("BigQuery cursor value count must include every order field and the key tie-breaker");
  }
  if (query.startAfter.values.some((value) => value === null)) {
    throw new UnsupportedError("BigQuery cursors containing null values");
  }
  const terms: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = query.startAfter.values[index];
    if (column === undefined || value === undefined) throw new TypeError("invalid BigQuery cursor");
    const name = `c${String(index)}`;
    parameters.push(parameter(name, column, value));
    const equal = columns.slice(0, index).map((previous, previousIndex) => `${columnExpression(previous)} = @c${String(previousIndex)}`);
    const direction = query.orders[index]?.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") throw new TypeError("BigQuery order direction must be asc or desc");
    terms.push(`(${[...equal, `${columnExpression(column)} ${direction === "desc" ? "<" : ">"} @${name}`].join(" AND ")})`);
  }
  return `(${terms.join(" OR ")})`;
}

export function compileBigQueryQuery<T>(projectId: string, table: BigQueryTable, query: StructuredQuery<T>, rowLimit: number): CompiledBigQueryQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("BigQuery collection-group or nested collection queries");
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1) throw new TypeError("row limit must be a positive safe integer");
  const parameters: BigQueryParameter[] = [];
  const clauses = query.filters.map((filter, index) => {
    const compiled = filterSql(filter, table, index);
    if (compiled.parameter !== undefined) parameters.push(compiled.parameter);
    return compiled.sql;
  });
  const cursorColumns = orderColumns(query.orders, table);
  if (query.orders.length > 0) {
    requireNonNullableCursorColumns(cursorColumns);
  }
  const cursor = cursorSql(query, cursorColumns, parameters);
  if (cursor !== undefined) clauses.push(cursor);
  const selected = [
    `${columnExpression(table.keyColumn)} AS \`__dalgo_key\``,
    ...Object.entries(table.columns).map(([field, column]) => `${columnExpression(column)} AS ${quoteIdentifier(field, "field name")}`),
  ];
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const ordered = query.orders.length === 0 ? "" : ` ORDER BY ${orderSql(query.orders, cursorColumns)}`;
  return {
    sql: `SELECT ${selected.join(", ")} FROM ${quoteTable(projectId, table)} AS t${where}${ordered} LIMIT ${String(rowLimit)}`,
    parameters,
    cursorColumns,
  };
}

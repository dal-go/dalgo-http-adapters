import type { QueryColumn, QueryFieldReference, TugQLCondition, TugQLExpression, TugQLQueryFilter } from "@dalgo/core";
import type { OrdinalParameter, OrdinalQuery, OrdinalValue } from "@dalgo/adapter-runtime";
import { ClickHouseNativeError } from "./native-errors.js";
import { nativeIdentifier, nativeParameters } from "./native-query.js";
import type { ClickHouseReadGrant } from "./native-types.js";

interface CompiledOrdinalQuery { readonly sql: string; readonly parameters: readonly OrdinalParameter[]; }
const refuse = (): never => { throw new ClickHouseNativeError("unsupported"); };
function onlyKeys(value: object, allowed: readonly string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) refuse(); }
function label(value: string): string {
  // ClickHouse treats backslashes as escapes inside quoted identifiers. This
  // bounded surface explicitly refuses them rather than changing a label or
  // allowing an escaped delimiter to enter generated SQL.
  if (value.length < 1 || value.length > 256 || /[\\\u0000-\u001f\u007f]/u.test(value)) refuse();
  return `\`${value.replace(/`/gu, "``")}\``;
}
function literal(value: unknown): { readonly nativeType: string; readonly value: OrdinalValue } {
  if (value === null) return { nativeType: "Nullable(String)", value: null };
  if (typeof value === "string") return { nativeType: "String", value };
  if (typeof value === "boolean") return { nativeType: "Bool", value };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) refuse();
    return { nativeType: Object.is(value, -0) ? "Float64" : Number.isInteger(value) ? value < 0 ? "Int64" : "UInt64" : "Float64", value };
  }
  return refuse();
}

/** Compiles a bounded single-source subset of the actual released DALgo model. */
export function compileOrdinalQuery(request: OrdinalQuery, tables: ReadonlyMap<string, ClickHouseReadGrant>, allowNative: boolean, maxRows: number): CompiledOrdinalQuery {
  if (request.kind === "native") {
    onlyKeys(request, ["kind", "sql", "parameters"]);
    if (!allowNative) throw new ClickHouseNativeError("permission");
    if (typeof request.sql !== "string" || request.sql.trim().length === 0) refuse();
    return { sql: request.sql, parameters: request.parameters ?? [] };
  }
  if (request.kind !== "structured") return refuse();
  onlyKeys(request, ["kind", "query", "columns", "parameters"]);
  const query = request.query;
  const joined = "kind" in query;
  let logical: string;
  let sourceName: string;
  let projection: readonly QueryColumn[] | undefined;
  if (joined) {
    if (query.kind !== "joined-tugql") return refuse();
    onlyKeys(query, ["kind", "from", "filters", "orders", "columns", "limit", "offset", "groupBy", "having"]);
    onlyKeys(query.from, ["name", "alias", "joins"]);
    if (query.from.joins.length !== 0 || query.groupBy !== undefined || query.having !== undefined || request.columns !== undefined) return refuse();
    logical = query.from.name;
    sourceName = query.from.alias ?? logical;
    nativeIdentifier(sourceName);
    projection = query.columns;
  } else {
    onlyKeys(query, ["source", "filters", "orders", "limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]);
    onlyKeys(query.source, ["kind", "name", "parent", "codec"]);
    if (query.source.kind !== "collection" || query.source.parent !== undefined || query.source.codec !== undefined
      || query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) return refuse();
    logical = query.source.name;
    sourceName = logical;
    projection = request.columns;
  }
  if ((query.offset ?? 0) !== 0 || query.filters.length > 256 || query.orders.length > 32) return refuse();
  const table = tables.get(logical);
  if (table === undefined) throw new ClickHouseNativeError("permission");
  if (projection === undefined || projection.length === 0 || projection.length > 1024) return refuse();
  const limit = query.limit ?? maxRows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) throw new ClickHouseNativeError("bounds");
  const parameters: OrdinalParameter[] = [];
  const supplied = new Map<string, OrdinalParameter>();
  nativeParameters(request.parameters ?? []);
  for (const parameter of request.parameters ?? []) supplied.set(parameter.name, parameter);
  const used = new Set<string>();
  const literalBindings = new Map<string, string>();
  let nodes = 0;
  const visit = (depth: number): void => { nodes += 1; if (nodes > 4096 || depth > 16) throw new ClickHouseNativeError("bounds"); };
  const field = (reference: QueryFieldReference): string => {
    onlyKeys(reference, ["field", "source"]);
    if (reference.source !== sourceName && reference.source !== logical && reference.source !== "") throw new ClickHouseNativeError("permission");
    const column = Object.hasOwn(table.columns, reference.field) ? table.columns[reference.field] : undefined;
    if (column === undefined) throw new ClickHouseNativeError("permission");
    return `${nativeIdentifier(table.table)}.${nativeIdentifier(column)}`;
  };
  const bind = (value: unknown): string => {
    const scalar = literal(value);
    const identity = `${scalar.nativeType}:${Object.is(scalar.value, -0) ? "-0" : JSON.stringify(scalar.value)}`;
    const existing = literalBindings.get(identity);
    if (existing !== undefined) return existing;
    let name = `__dalgo_literal_${String(parameters.length)}`;
    while (supplied.has(name)) name += "_";
    const parameter = { name, ...scalar };
    parameters.push(parameter);
    if (parameters.length > 256) throw new ClickHouseNativeError("bounds");
    const placeholder = `{${name}:${parameter.nativeType}}`;
    literalBindings.set(identity, placeholder);
    return placeholder;
  };
  const expression = (value: TugQLExpression, depth = 0): string => {
    visit(depth);
    if (value.kind === "field") { onlyKeys(value, ["kind", "field"]); return field(value.field); }
    if (value.kind === "literal") { onlyKeys(value, ["kind", "value"]); return bind(value.value); }
    if (value.kind === "param") {
      onlyKeys(value, ["kind", "name"]);
      const parameter = supplied.get(value.name);
      if (parameter === undefined) return refuse();
      used.add(parameter.name);
      return `{${parameter.name}:${parameter.nativeType}}`;
    }
    return refuse();
  };
  const compare = (left: string, operator: string, right: string): string => {
    const operators: Readonly<Record<string, string>> = { "==": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=", in: "IN", "not-in": "NOT IN" };
    const sql = Object.hasOwn(operators, operator) ? operators[operator] : undefined;
    if (sql === undefined) return refuse();
    return `(${left} ${sql} ${right})`;
  };
  const condition = (value: TugQLCondition | TugQLQueryFilter, depth = 0): string => {
    visit(depth);
    if ("kind" in value) {
      if (value.kind === "and" || value.kind === "or") {
        onlyKeys(value, ["kind", "conditions"]);
        if (value.conditions.length === 0 || value.conditions.length > 256) return refuse();
        return `(${value.conditions.map((child) => condition(child, depth + 1)).join(value.kind === "and" ? " AND " : " OR ")})`;
      }
      if (value.kind === "is-null" || value.kind === "is-not-null") {
        onlyKeys(value, ["kind", "operand"]);
        return `(${expression(value.operand, depth + 1)} IS ${value.kind === "is-not-null" ? "NOT " : ""}NULL)`;
      }
      return refuse();
    }
    if ("field" in value) {
      onlyKeys(value, ["field", "operator", "value"]);
      const right = value.operator === "in" || value.operator === "not-in"
        ? values(value.value) : bind(value.value);
      return compare(field(value.field), value.operator, right);
    }
    onlyKeys(value, ["left", "operator", "right"]);
    const membership = value.operator === "in" || value.operator === "not-in";
    const right = membership && value.right.kind === "values" ? values(value.right.values) : expression(value.right, depth + 1);
    return compare(expression(value.left, depth + 1), value.operator, right);
  };
  const values = (value: unknown): string => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 256) return refuse();
    return `(${value.map((item: unknown) => bind(item)).join(", ")})`;
  };
  const aliases = new Map<string, string>();
  const columns = projection.map((column) => {
    onlyKeys(column, ["expression", "as", "wildcard"]);
    if (column.expression === undefined || column.wildcard !== undefined) return refuse();
    const sql = expression(column.expression);
    const name = column.as ?? (column.expression.kind === "field" ? column.expression.field.field : undefined);
    if (name === undefined) return refuse();
    // ClickHouse substitutes SELECT aliases into expressions. Identical repeated
    // projections are safe; one label for two different expressions is refused.
    const existing = aliases.get(name);
    if (existing !== undefined && existing !== sql) return refuse();
    aliases.set(name, sql);
    return `${sql} AS ${label(name)}`;
  });
  const filters = joined ? query.filters.map((filter) => condition(filter)) : query.filters.map((filter) => {
    onlyKeys(filter, ["field", "operator", "value"]);
    const left = field({ field: filter.field, source: logical });
    if (filter.value === null && (filter.operator === "==" || filter.operator === "!=")) return `(${left} IS ${filter.operator === "!=" ? "NOT " : ""}NULL)`;
    const right = filter.operator === "in" || filter.operator === "not-in" ? values(filter.value) : bind(filter.value);
    return compare(left, filter.operator, right);
  });
  const orders = joined ? query.orders.map((order) => {
    onlyKeys(order, ["field", "direction"]);
    if (order.field === undefined || (order.direction !== "asc" && order.direction !== "desc")) return refuse();
    return `${field(order.field)} ${order.direction.toUpperCase()}`;
  }) : query.orders.map((order) => {
    onlyKeys(order, ["field", "direction"]);
    if (order.direction !== "asc" && order.direction !== "desc") return refuse();
    return `${field({ field: order.field, source: logical })} ${order.direction.toUpperCase()}`;
  });
  if (used.size !== supplied.size) return refuse();
  parameters.push(...supplied.values());
  nativeParameters(parameters);
  return { sql: `SELECT ${columns.join(", ")} FROM ${nativeIdentifier(table.database)}.${nativeIdentifier(table.table)}${filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`}${orders.length === 0 ? "" : ` ORDER BY ${orders.join(", ")}`} LIMIT ${String(limit)}`, parameters };
}

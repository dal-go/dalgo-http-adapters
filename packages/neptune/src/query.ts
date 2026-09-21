import {
  DOCUMENT_ID,
  UnsupportedError,
  type FieldPath,
  type QueryCursor,
  type QueryFilter,
  type QueryOrder,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { assertIdentifier, assertQueryScalar, dalgoId, neptuneId, quoteIdentifier } from "./validation.js";
import type { ResolvedCollection } from "./types.js";

export interface CompiledNeptuneQuery<T> {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly collection: ResolvedCollection;
  readonly orders: readonly QueryOrder<T>[];
}

function property<T>(field: FieldPath<T>): string {
  return field === DOCUMENT_ID ? "id(n)" : `n.${quoteIdentifier(field, "Neptune query field")}`;
}

function orders<T>(query: StructuredQuery<T>): readonly QueryOrder<T>[] {
  return query.orders.some((order) => order.field === DOCUMENT_ID)
    ? query.orders
    : [...query.orders, { field: DOCUMENT_ID, direction: query.orders.at(-1)?.direction ?? "asc" }];
}

function documentId(collection: ResolvedCollection, value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} must be a non-empty string Neptune DALgo key ID`);
  return neptuneId(collection, value);
}

function filter<T>(item: QueryFilter<T>, name: string): string {
  const field = property(item.field);
  if (item.operator === "array-contains" || item.operator === "array-contains-any") {
    throw new UnsupportedError("Neptune array-property filters: this adapter maps scalar properties only");
  }
  if (item.operator === "in" || item.operator === "not-in") {
    if (!Array.isArray(item.value) || item.value.length === 0) throw new TypeError(`Neptune ${item.operator} values must be non-empty arrays`);
    item.value.forEach((value, index) => { assertQueryScalar(value, `Neptune ${item.operator} value ${index.toString()}`); });
    return item.operator === "in" ? `${field} IN $${name}` : `NOT ${field} IN $${name}`;
  }
  assertQueryScalar(item.value, `Neptune ${item.operator} value`);
  const operators: Readonly<Record<string, string>> = { "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
  const operator = operators[item.operator];
  if (operator === undefined) throw new UnsupportedError(`Neptune query operator: ${item.operator}`);
  return `${field} ${operator} $${name}`;
}

function parameterValue<T>(item: QueryFilter<T>, collection: ResolvedCollection): unknown {
  if (item.operator === "in" || item.operator === "not-in") {
    if (!Array.isArray(item.value)) throw new TypeError("Neptune membership value must be an array");
    return item.field === DOCUMENT_ID
      ? item.value.map((value) => documentId(collection, value, "Neptune DALgo ID filter value"))
      : item.value;
  }
  assertQueryScalar(item.value, "Neptune query value");
  return item.field === DOCUMENT_ID ? documentId(collection, item.value, "Neptune DALgo ID filter value") : item.value;
}

function cursor<T>(
  value: QueryCursor | undefined,
  queryOrders: readonly QueryOrder<T>[],
  collection: ResolvedCollection,
  kind: "startAt" | "startAfter" | "endAt" | "endBefore",
  parameters: Record<string, unknown>,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.values.length !== queryOrders.length) throw new TypeError("Neptune cursor length does not match query order fields");
  const lower = kind === "startAt" || kind === "startAfter";
  const inclusive = kind === "startAt" || kind === "endAt";
  const terms: string[] = [];
  for (let index = 0; index < queryOrders.length; index += 1) {
    const order = queryOrders[index];
    const cursorValue = value.values[index];
    if (order === undefined || cursorValue === undefined) throw new TypeError("Neptune cursor contains an undefined value");
    assertQueryScalar(cursorValue, `Neptune cursor value ${index.toString()}`);
    const name = `${kind}${index.toString()}`;
    parameters[name] = order.field === DOCUMENT_ID ? documentId(collection, cursorValue, "Neptune cursor document ID") : cursorValue;
    const before = queryOrders.slice(0, index).map((previous, previousIndex) => `${property(previous.field)} = $${kind}${previousIndex.toString()}`);
    const ascending = order.direction === "asc";
    const comparison = lower ? (ascending ? ">" : "<") : (ascending ? "<" : ">");
    const finalComparison = inclusive && index === queryOrders.length - 1 ? `${comparison}=` : comparison;
    terms.push([...before, `${property(order.field)} ${finalComparison} $${name}`].join(" AND "));
  }
  return `(${terms.join(" OR ")})`;
}

export function compileNeptuneQuery<T>(query: StructuredQuery<T>, collections: ReadonlyMap<string, ResolvedCollection>): CompiledNeptuneQuery<T> {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) {
    throw new UnsupportedError("Neptune nested and collection-group DALgo queries");
  }
  const collection = collections.get(query.source.name);
  if (collection === undefined) throw new TypeError(`Neptune collection is not configured: ${query.source.name}`);
  const parameters: Record<string, unknown> = {};
  const clauses = query.filters.map((item, index) => {
    const name = `filter${index.toString()}`;
    const expression = filter(item, name);
    parameters[name] = parameterValue(item, collection);
    return expression;
  });
  const queryOrders = orders(query);
  const start = cursor(query.startAt, queryOrders, collection, "startAt", parameters) ?? cursor(query.startAfter, queryOrders, collection, "startAfter", parameters);
  const end = cursor(query.endAt, queryOrders, collection, "endAt", parameters) ?? cursor(query.endBefore, queryOrders, collection, "endBefore", parameters);
  if (start !== undefined) clauses.push(start);
  if (end !== undefined) clauses.push(end);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = queryOrders.map((item) => `${property(item.field)} ${item.direction.toUpperCase()}`).join(", ");
  const offset = query.offset === undefined ? "" : ` SKIP ${query.offset.toString()}`;
  const limit = query.limit === undefined ? "" : ` LIMIT ${query.limit.toString()}`;
  return { statement: `MATCH (n:${quoteIdentifier(collection.label, "Neptune node label")})${where} RETURN n AS node ORDER BY ${order}${offset}${limit}`, parameters, collection, orders: queryOrders };
}

export function cursorFromNode<T>(node: Readonly<Record<string, unknown>>, queryOrders: readonly QueryOrder<T>[], collection: ResolvedCollection): QueryCursor {
  return { values: queryOrders.map((order) => {
    const value = order.field === DOCUMENT_ID ? dalgoId(collection, String(node["~id"])) : node[assertIdentifier(order.field, "Neptune query field")];
    assertQueryScalar(value, "Neptune cursor result value");
    return value;
  }) };
}

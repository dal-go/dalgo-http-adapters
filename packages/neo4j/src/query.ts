import {
  DOCUMENT_ID,
  UnsupportedError,
  type FieldPath,
  type QueryCursor,
  type QueryFilter,
  type QueryOrder,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { assertIdentifier, assertJsonValue, collectionForKey, quoteIdentifier } from "./validation.js";
import type { ResolvedCollection } from "./types.js";

export interface CompiledNeo4jQuery<T> {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly collection: ResolvedCollection;
  readonly orders: readonly QueryOrder<T>[];
}

function property<T>(field: FieldPath<T>, collection: ResolvedCollection): string {
  if (field === DOCUMENT_ID) {
    return `n.${quoteIdentifier(collection.idProperty, "Neo4j ID property")}`;
  }
  return `n.${quoteIdentifier(field, "Neo4j query field")}`;
}

function queryOrders<T>(dalQuery: StructuredQuery<T>): readonly QueryOrder<T>[] {
  if (dalQuery.orders.some(({ field }) => field === DOCUMENT_ID)) {
    return dalQuery.orders;
  }
  return [...dalQuery.orders, { field: DOCUMENT_ID, direction: dalQuery.orders.at(-1)?.direction ?? "asc" }];
}

function filterExpression<T>(
  filter: QueryFilter<T>,
  collection: ResolvedCollection,
  name: string,
): string {
  if (filter.value === null) {
    throw new UnsupportedError("Neo4j null filter values");
  }
  assertJsonValue(filter.value, `query parameter ${name}`);
  const field = property(filter.field, collection);
  switch (filter.operator) {
    case "==": return `${field} = $${name}`;
    case "!=": return `${field} <> $${name}`;
    case "<": return `${field} < $${name}`;
    case "<=": return `${field} <= $${name}`;
    case ">": return `${field} > $${name}`;
    case ">=": return `${field} >= $${name}`;
    case "in":
    case "not-in":
    case "array-contains-any":
      if (!Array.isArray(filter.value) || filter.value.some((value) => value === null)) {
        throw new TypeError(`Neo4j ${filter.operator} query values must be non-null arrays`);
      }
      if (filter.operator === "in") return `${field} IN $${name}`;
      if (filter.operator === "not-in") return `${field} NOT IN $${name}`;
      if (filter.field === DOCUMENT_ID) throw new UnsupportedError("array operation on DALgo document ID");
      return `any(item IN ${field} WHERE item IN $${name})`;
    case "array-contains":
      if (filter.field === DOCUMENT_ID) throw new UnsupportedError("array operation on DALgo document ID");
      return `$${name} IN ${field}`;
  }
}

function cursorCondition<T>(
  cursor: QueryCursor | undefined,
  orders: readonly QueryOrder<T>[],
  collection: ResolvedCollection,
  kind: "startAt" | "startAfter" | "endAt" | "endBefore",
  parameters: Record<string, unknown>,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.values.length !== orders.length) {
    throw new TypeError(`cursor has ${cursor.values.length.toString()} values but the compiled query has ${orders.length.toString()} order fields`);
  }
  const isLower = kind === "startAt" || kind === "startAfter";
  const inclusive = kind === "startAt" || kind === "endAt";
  const terms: string[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const value = cursor.values[index];
    if (order === undefined || value === undefined || value === null) {
      throw new TypeError("Neo4j query cursors require non-null JSON values");
    }
    assertJsonValue(value, `cursor value ${index.toString()}`);
    const name = `${kind}${index.toString()}`;
    parameters[name] = value;
    const preceding = orders.slice(0, index).map((precedingOrder, precedingIndex) => (
      `${property(precedingOrder.field, collection)} = $${kind}${precedingIndex.toString()}`
    ));
    const ascending = order.direction === "asc";
    const operator = isLower
      ? (ascending ? ">" : "<")
      : (ascending ? "<" : ">");
    const comparison = index === orders.length - 1 && inclusive
      ? `${property(order.field, collection)} ${operator}= $${name}`
      : `${property(order.field, collection)} ${operator} $${name}`;
    terms.push([...preceding, comparison].join(" AND "));
  }
  return `(${terms.join(" OR ")})`;
}

export function compileNeo4jQuery<T>(
  dalQuery: StructuredQuery<T>,
  collections: ReadonlyMap<string, ResolvedCollection>,
): CompiledNeo4jQuery<T> {
  if (dalQuery.source.kind !== "collection") {
    throw new UnsupportedError("Neo4j collection-group queries");
  }
  if (dalQuery.source.parent !== undefined) {
    throw new UnsupportedError("Neo4j nested DALgo collections");
  }
  const collection = collectionForKey(collections, dalQuery.source.name);
  const parameters: Record<string, unknown> = {};
  const clauses = dalQuery.filters.map((filter, index) => {
    const name = `filter${index.toString()}`;
    parameters[name] = filter.value;
    return filterExpression(filter, collection, name);
  });
  const orders = queryOrders(dalQuery);
  const start = cursorCondition(dalQuery.startAt, orders, collection, "startAt", parameters)
    ?? cursorCondition(dalQuery.startAfter, orders, collection, "startAfter", parameters);
  const end = cursorCondition(dalQuery.endAt, orders, collection, "endAt", parameters)
    ?? cursorCondition(dalQuery.endBefore, orders, collection, "endBefore", parameters);
  if (start !== undefined) clauses.push(start);
  if (end !== undefined) clauses.push(end);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = orders.map((item) => `${property(item.field, collection)} ${item.direction.toUpperCase()}`).join(", ");
  let paging = "";
  if (dalQuery.offset !== undefined) {
    parameters.offset = dalQuery.offset;
    paging += " SKIP $offset";
  }
  if (dalQuery.limit !== undefined) {
    parameters.limit = dalQuery.limit;
    paging += " LIMIT $limit";
  }
  return {
    statement: `MATCH (n:${quoteIdentifier(collection.label, "Neo4j node label")})${where} RETURN n AS node ORDER BY ${order}${paging}`,
    parameters,
    collection,
    orders,
  };
}

export function cursorFromNode<T>(node: Readonly<Record<string, unknown>>, orders: readonly QueryOrder<T>[], collection: ResolvedCollection): QueryCursor {
  return {
    values: orders.map((order) => {
      const name = order.field === DOCUMENT_ID ? collection.idProperty : assertIdentifier(order.field, "Neo4j query field");
      const value = node[name];
      if (value === undefined || value === null) throw new TypeError(`Neo4j result is missing a non-null cursor property: ${name}`);
      return value;
    }),
  };
}

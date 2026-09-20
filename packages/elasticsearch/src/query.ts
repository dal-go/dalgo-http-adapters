import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryFilter,
  type StructuredQuery,
} from "@dal-go/dalgo";

type JsonObject = Record<string, unknown>;

export interface CompiledElasticsearchQuery {
  readonly body: JsonObject;
}

function fieldName(field: string): string {
  return field === DOCUMENT_ID ? "_id" : field;
}

export function validateElasticsearchIndex(index: string): void {
  if (index.length === 0) throw new TypeError("Elasticsearch index name is required");
  if (new TextEncoder().encode(index).length > 255) {
    throw new TypeError("Elasticsearch index names cannot exceed 255 bytes");
  }
  if (index !== index.toLowerCase() || index === "." || index === "..") {
    throw new TypeError("Elasticsearch index names must be lowercase and cannot be . or ..");
  }
  if (/^[_+-]/u.test(index) || /[\\/*?"<>| ,#:]/u.test(index)) {
    throw new TypeError(`unsafe Elasticsearch index name: ${index}`);
  }
}

function filterClause<T>(filter: QueryFilter<T>): JsonObject {
  const field = fieldName(String(filter.field));
  switch (filter.operator) {
    case "==":
    case "array-contains":
      return { term: { [field]: filter.value } };
    case "in":
    case "array-contains-any":
      if (!Array.isArray(filter.value)) throw new TypeError(`${filter.operator} requires an array`);
      return { terms: { [field]: filter.value } };
    case "!=":
      return { bool: {
        filter: [{ exists: { field } }],
        must_not: [{ term: { [field]: filter.value } }],
      } };
    case "not-in":
      if (!Array.isArray(filter.value)) throw new TypeError("not-in requires an array");
      return { bool: {
        filter: [{ exists: { field } }],
        must_not: [{ terms: { [field]: filter.value } }],
      } };
    case "<":
      return { range: { [field]: { lt: filter.value } } };
    case "<=":
      return { range: { [field]: { lte: filter.value } } };
    case ">":
      return { range: { [field]: { gt: filter.value } } };
    case ">=":
      return { range: { [field]: { gte: filter.value } } };
  }
}

export function compileElasticsearchQuery<T>(query: StructuredQuery<T>): CompiledElasticsearchQuery {
  validateElasticsearchIndex(query.source.name);
  if (query.source.kind === "collection-group") {
    throw new UnsupportedError("Elasticsearch collection-group queries");
  }
  if (query.source.parent !== undefined) {
    throw new UnsupportedError("Elasticsearch nested collection queries");
  }
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("Elasticsearch inclusive or end cursors");
  }
  if (query.startAfter !== undefined && query.orders.length === 0) {
    throw new UnsupportedError("Elasticsearch startAfter without an explicit order");
  }
  if (query.startAfter !== undefined && (query.offset ?? 0) !== 0) {
    throw new UnsupportedError("Elasticsearch startAfter combined with offset");
  }
  if (query.startAfter !== undefined && query.startAfter.values.length !== query.orders.length) {
    throw new TypeError("cursor value count must match query order count");
  }
  if (query.orders.some((order) => order.field === DOCUMENT_ID)) {
    throw new UnsupportedError("Elasticsearch document-ID ordering");
  }

  const body: JsonObject = {
    query: query.filters.length === 0
      ? { match_all: {} }
      : { bool: { filter: query.filters.map((filter) => filterClause(filter)) } },
  };
  if (query.orders.length > 0) {
    body.sort = query.orders.map((order) => ({
      [fieldName(String(order.field))]: order.direction,
    }));
  }
  if (query.limit !== undefined) body.size = query.limit;
  if (query.offset !== undefined) body.from = query.offset;
  if (query.startAfter !== undefined) body.search_after = [...query.startAfter.values];
  return { body };
}

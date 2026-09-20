import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryFilter,
  type StructuredQuery,
} from "@dal-go/dalgo";

type JsonObject = Record<string, unknown>;

export interface CompiledOpenSearchQuery {
  readonly body: JsonObject;
}

function validateDocumentIdValue(value: unknown, operator: string): void {
  if (operator === "in" || operator === "array-contains-any") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new TypeError(`${operator} filters on DOCUMENT_ID require an array of strings`);
    }
    return;
  }
  if (typeof value !== "string") throw new TypeError("DOCUMENT_ID filters require string IDs");
}

function fieldName(field: string): string {
  return field === DOCUMENT_ID ? "_id" : field;
}

export function validateOpenSearchIndex(index: string): void {
  if (index.length === 0) throw new TypeError("OpenSearch index name is required");
  if (new TextEncoder().encode(index).length > 255) {
    throw new TypeError("OpenSearch index names cannot exceed 255 bytes");
  }
  if (index !== index.toLowerCase() || index === "." || index === "..") {
    throw new TypeError("OpenSearch index names must be lowercase and cannot be . or ..");
  }
  if (/^[_+-]/u.test(index) || /[\\/*?"<>| ,#:]/u.test(index)) {
    throw new TypeError(`unsafe OpenSearch index name: ${index}`);
  }
}

function filterClause<T>(filter: QueryFilter<T>): JsonObject {
  const field = fieldName(String(filter.field));
  if (field === "_id") validateDocumentIdValue(filter.value, filter.operator);
  switch (filter.operator) {
    case "==":
      if (filter.value === null) return { bool: { must_not: [{ exists: { field } }] } };
      return { term: { [field]: filter.value } };
    case "array-contains":
      return { term: { [field]: filter.value } };
    case "in":
    case "array-contains-any":
      if (!Array.isArray(filter.value)) throw new TypeError(`${filter.operator} requires an array`);
      if (filter.value.length === 0) return { match_none: {} };
      return { terms: { [field]: filter.value } };
    case "!=":
      if (filter.value === null) return { exists: { field } };
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

export function compileOpenSearchQuery<T>(query: StructuredQuery<T>, maxQueryLimit = 1_000): CompiledOpenSearchQuery {
  if (!Number.isSafeInteger(maxQueryLimit) || maxQueryLimit <= 0) {
    throw new TypeError("maxQueryLimit must be a positive safe integer");
  }
  validateOpenSearchIndex(query.source.name);
  if (query.source.kind === "collection-group") {
    throw new UnsupportedError("OpenSearch collection-group queries");
  }
  if (query.source.parent !== undefined) {
    throw new UnsupportedError("OpenSearch nested collection queries");
  }
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("OpenSearch inclusive or end cursors");
  }
  if (query.startAfter !== undefined && query.orders.length === 0) {
    throw new UnsupportedError("OpenSearch startAfter without an explicit order");
  }
  if (query.startAfter !== undefined && (query.offset ?? 0) !== 0) {
    throw new UnsupportedError("OpenSearch startAfter combined with offset");
  }
  if (query.startAfter !== undefined && query.startAfter.values.length !== query.orders.length) {
    throw new TypeError("cursor value count must match query order count");
  }
  if (query.orders.some((order) => order.field === DOCUMENT_ID)) {
    throw new UnsupportedError("OpenSearch document-ID ordering");
  }
  if (query.limit !== undefined && query.limit > maxQueryLimit) {
    throw new RangeError(`query limit exceeds maxQueryLimit (${String(maxQueryLimit)})`);
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
  body.size = query.limit ?? maxQueryLimit;
  if (query.offset !== undefined) body.from = query.offset;
  if (query.startAfter !== undefined) body.search_after = [...query.startAfter.values];
  return { body };
}

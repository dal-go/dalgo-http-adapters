import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryFilter,
  type StructuredQuery,
} from "@dal-go/dalgo";

export type QdrantPointId = string | number;
export type QdrantFilter = Readonly<Record<string, unknown>>;

export interface CompiledQdrantQuery {
  readonly filter?: QdrantFilter;
  readonly limit: number;
  readonly offset?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateQdrantPointId(value: unknown): asserts value is QdrantPointId {
  if (typeof value === "string" && isUuid(value)) return;
  if (isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0) return;
  throw new TypeError("Qdrant point IDs must be UUID strings or non-negative safe integers representable in JavaScript");
}

export function validateQdrantCollectionName(value: string): void {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > 255 || hasControlCharacter(value)) {
    throw new TypeError("Qdrant collection names must be non-empty, at most 255 bytes, and contain no control characters");
  }
}

function payloadKey(field: unknown): string {
  const key = String(field);
  if (key.length === 0 || new TextEncoder().encode(key).byteLength > 255 || hasControlCharacter(key)) {
    throw new TypeError("Qdrant payload keys must be non-empty, at most 255 bytes, and contain no control characters");
  }
  return key;
}

function matchValue(value: unknown, operator: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value)) return value;
  throw new UnsupportedError(`Qdrant ${operator} filters require string, finite-number, or boolean payload values`);
}

function matchAnyValue(value: unknown, operator: string): string | number {
  if (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new UnsupportedError(`Qdrant ${operator} filters require keyword strings or safe integers`);
}

function ids(value: unknown, operator: string): readonly QdrantPointId[] {
  const values = operator === "==" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`Qdrant ${operator} document-ID filters require a non-empty array`);
  return values.map((item): QdrantPointId => {
    validateQdrantPointId(item);
    return item;
  });
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function filterClause<T>(filter: QueryFilter<T>): QdrantFilter {
  if (filter.field === DOCUMENT_ID) {
    if (filter.operator !== "==" && filter.operator !== "in") {
      throw new UnsupportedError(`Qdrant document-ID filter operator ${filter.operator}`);
    }
    return { has_id: ids(filter.value, filter.operator) };
  }
  const key = payloadKey(filter.field);
  switch (filter.operator) {
    case "==":
    case "array-contains":
      return { key, match: { value: matchValue(filter.value, filter.operator) } };
    case "in":
    case "array-contains-any": {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new TypeError(`Qdrant ${filter.operator} filters require a non-empty array`);
      }
      return { key, match: { any: filter.value.map((value) => matchAnyValue(value, filter.operator)) } };
    }
    case "<":
      return { key, range: { lt: rangeValue(filter.value, filter.operator) } };
    case "<=":
      return { key, range: { lte: rangeValue(filter.value, filter.operator) } };
    case ">":
      return { key, range: { gt: rangeValue(filter.value, filter.operator) } };
    case ">=":
      return { key, range: { gte: rangeValue(filter.value, filter.operator) } };
    case "!=":
    case "not-in":
      throw new UnsupportedError(`Qdrant negative filter operator ${filter.operator}`);
  }
}

function rangeValue(value: unknown, operator: string): number {
  if (!isFiniteNumber(value)) throw new UnsupportedError(`Qdrant ${operator} filters require finite numeric payload values`);
  return value;
}

/** Compiles only the DALgo subset whose filtering and pagination semantics Qdrant preserves. */
export function compileQdrantQuery<T>(query: StructuredQuery<T>, maxQueryLimit = 1_000, maxQueryOffset = 10_000): CompiledQdrantQuery {
  if (!Number.isSafeInteger(maxQueryLimit) || maxQueryLimit <= 0) throw new TypeError("maxQueryLimit must be a positive safe integer");
  if (!Number.isSafeInteger(maxQueryOffset) || maxQueryOffset < 0) throw new TypeError("maxQueryOffset must be a non-negative safe integer");
  if (query.source.kind === "collection-group") throw new UnsupportedError("Qdrant collection-group queries");
  if (query.source.parent !== undefined) throw new UnsupportedError("Qdrant nested collection queries");
  if (query.orders.length > 0) throw new UnsupportedError("Qdrant DALgo ordering");
  if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("Qdrant DALgo cursors");
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > maxQueryLimit)) {
    throw new RangeError(`query limit must be a positive safe integer no greater than maxQueryLimit (${String(maxQueryLimit)})`);
  }
  if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > maxQueryOffset)) {
    throw new RangeError(`query offset must be a non-negative safe integer no greater than maxQueryOffset (${String(maxQueryOffset)})`);
  }
  const must = query.filters.map((filter) => filterClause(filter));
  return {
    ...(must.length === 0 ? {} : { filter: { must } }),
    limit: query.limit ?? maxQueryLimit,
    ...(query.offset === undefined ? {} : { offset: query.offset }),
  };
}

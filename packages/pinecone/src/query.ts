import { DOCUMENT_ID, UnsupportedError, type QueryFilter, type StructuredQuery } from "@dal-go/dalgo";

export type PineconeFilter = Readonly<Record<string, unknown>>;

export interface CompiledPineconeVectorQuery {
  readonly filter?: PineconeFilter;
  readonly topK: number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`Pinecone ${label} must be a finite number`);
  }
  return value;
}

function fieldName(value: unknown): string {
  const field = String(value);
  if (field.length === 0 || new TextEncoder().encode(field).byteLength > 255 || hasControlCharacter(field)) {
    throw new TypeError("Pinecone metadata filter fields must be non-empty, at most 255 bytes, and contain no control characters");
  }
  return field;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function scalar(value: unknown, label: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "boolean") return value;
  return finite(value, label);
}

function clause<T>(filter: QueryFilter<T>): PineconeFilter {
  if (filter.field === DOCUMENT_ID) throw new UnsupportedError("Pinecone document-ID filters");
  const field = fieldName(filter.field);
  switch (filter.operator) {
    case "==": return { [field]: { $eq: scalar(filter.value, "filter value") } };
    case "!=": return { [field]: { $ne: scalar(filter.value, "filter value") } };
    case "<": return { [field]: { $lt: finite(filter.value, "range filter value") } };
    case "<=": return { [field]: { $lte: finite(filter.value, "range filter value") } };
    case ">": return { [field]: { $gt: finite(filter.value, "range filter value") } };
    case ">=": return { [field]: { $gte: finite(filter.value, "range filter value") } };
    case "in":
    case "not-in": {
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError(`Pinecone ${filter.operator} filters require a non-empty array`);
      return { [field]: { [filter.operator === "in" ? "$in" : "$nin"]: filter.value.map((item) => scalar(item, "membership filter value")) } };
    }
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`Pinecone ${filter.operator} filters`);
  }
}

/** Compiles the documented Pinecone metadata-filter subset for explicit vector search. */
export function compilePineconeVectorQuery<T>(query: StructuredQuery<T>, maximumTopK = 1_000): CompiledPineconeVectorQuery {
  if (!Number.isSafeInteger(maximumTopK) || maximumTopK < 1) throw new TypeError("maximumTopK must be a positive safe integer");
  if (query.source.kind !== "collection") throw new UnsupportedError("Pinecone collection-group queries");
  if (query.source.parent !== undefined) throw new UnsupportedError("Pinecone nested collection queries");
  if (query.orders.length > 0) throw new UnsupportedError("Pinecone DALgo ordering");
  if (query.offset !== undefined || query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("Pinecone DALgo pagination cursors or offsets");
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > maximumTopK)) {
    throw new RangeError(`Pinecone vector-query limit must be a positive safe integer no greater than ${String(maximumTopK)}`);
  }
  const filters = query.filters.map(clause);
  if (filters.length > 1) return { topK: query.limit ?? maximumTopK, filter: { $and: filters } };
  return { topK: query.limit ?? maximumTopK, ...(filters.length === 0 ? {} : { filter: filters[0] }) };
}

export function validatePineconeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[!-~]+$/u.test(value)) {
    throw new TypeError("Pinecone vector IDs must be non-empty printable ASCII strings up to 512 characters with no spaces or control characters");
  }
}

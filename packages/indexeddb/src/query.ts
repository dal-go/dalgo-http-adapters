import {
  DOCUMENT_ID,
  Key,
  type ExistingRecord,
  type FieldPath,
  type QueryCursor,
  type QueryFilter,
  type QueryOrder,
  type QueryPage,
  type QuerySource,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { collectionPath, deserializeKey, type SerializedKeyPart } from "./path.js";

export interface StoredRecord {
  readonly path: string;
  readonly collectionPath: string;
  readonly collectionName: string;
  readonly id: string | number;
  readonly keyParts: readonly SerializedKeyPart[];
  readonly data: unknown;
}

export interface QueryStore {
  index(name: "collectionPath" | "collectionName"): IDBIndex;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function fieldValue(data: unknown, field: string): unknown {
  let value = data;
  for (const part of field.split(".")) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function comparable(value: unknown): readonly [number, string | number | bigint] {
  if (value === undefined) return [0, ""];
  if (value === null) return [1, ""];
  if (value instanceof Date) return [2, value.getTime()];
  if (typeof value === "number") return [3, value];
  if (typeof value === "bigint") return [4, value];
  if (typeof value === "string") return [5, value];
  if (typeof value === "boolean") return [6, value ? 1 : 0];
  const serialized = JSON.stringify(value) as string | undefined;
  return [7, serialized ?? Object.prototype.toString.call(value)];
}

function compareValues(left: unknown, right: unknown): number {
  if (deepEqual(left, right)) return 0;
  const [leftRank, leftValue] = comparable(left);
  const [rightRank, rightValue] = comparable(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (leftValue < rightValue) return -1;
  return 1;
}

function documentIdValue(record: StoredRecord, source: QuerySource<unknown>): string | number {
  return source.kind === "collection" ? record.id : record.path;
}

function normalizeDocumentId(value: unknown, source: QuerySource<unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDocumentId(item, source));
  }
  if (value instanceof Key) {
    if (source.kind === "collection") {
      const expected = collectionPath(source);
      if (value.collectionPath !== expected) {
        throw new TypeError(`document key belongs to ${value.collectionPath}, expected ${expected}`);
      }
      return value.id;
    }
    if (value.collection !== source.name) {
      throw new TypeError(`document key belongs to ${value.collection}, expected ${source.name}`);
    }
    return value.path;
  }
  return value;
}

function recordField<T>(record: StoredRecord, field: FieldPath<T>, source: QuerySource<T>): unknown {
  return field === DOCUMENT_ID ? documentIdValue(record, source) : fieldValue(record.data, field);
}

function arrayOperand(value: unknown, operator: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${operator} requires an array operand`);
  return value;
}

function matchesFilter<T>(record: StoredRecord, filter: QueryFilter<T>, source: QuerySource<T>): boolean {
  const actual = recordField(record, filter.field, source);
  const expected = filter.field === DOCUMENT_ID
    ? normalizeDocumentId(filter.value, source)
    : filter.value;
  switch (filter.operator) {
    case "==": return deepEqual(actual, expected);
    case "!=": return !deepEqual(actual, expected);
    case "<": return compareValues(actual, expected) < 0;
    case "<=": return compareValues(actual, expected) <= 0;
    case ">": return compareValues(actual, expected) > 0;
    case ">=": return compareValues(actual, expected) >= 0;
    case "in": return arrayOperand(expected, "in").some((value) => deepEqual(actual, value));
    case "not-in": return !arrayOperand(expected, "not-in").some((value) => deepEqual(actual, value));
    case "array-contains": return Array.isArray(actual) && actual.some((value) => deepEqual(value, expected));
    case "array-contains-any": {
      const candidates = arrayOperand(expected, "array-contains-any");
      return Array.isArray(actual)
        && actual.some((value) => candidates.some((candidate) => deepEqual(value, candidate)));
    }
  }
}

export function queryOrders<T>(query: StructuredQuery<T>): readonly QueryOrder<T>[] {
  if (query.orders.some(({ field }) => field === DOCUMENT_ID)) return query.orders;
  return [
    ...query.orders,
    { field: DOCUMENT_ID, direction: query.orders.at(-1)?.direction ?? "asc" },
  ];
}

function tuple<T>(record: StoredRecord, orders: readonly QueryOrder<T>[], source: QuerySource<T>): readonly unknown[] {
  return orders.map(({ field }) => recordField(record, field, source));
}

function normalizeCursor<T>(cursor: QueryCursor, orders: readonly QueryOrder<T>[], source: QuerySource<T>): readonly unknown[] {
  if (cursor.values.length !== orders.length) {
    throw new TypeError(
      `cursor has ${cursor.values.length.toString()} values but the query has ${orders.length.toString()} order fields`,
    );
  }
  return cursor.values.map((value, index) => (
    orders[index]?.field === DOCUMENT_ID ? normalizeDocumentId(value, source) : value
  ));
}

function compareTuples<T>(left: readonly unknown[], right: readonly unknown[], orders: readonly QueryOrder<T>[]): number {
  for (let index = 0; index < orders.length; index += 1) {
    const comparison = compareValues(left[index], right[index]);
    if (comparison !== 0) return orders[index]?.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function applyCursor<T>(
  records: readonly StoredRecord[],
  cursor: QueryCursor | undefined,
  orders: readonly QueryOrder<T>[],
  source: QuerySource<T>,
  accept: (comparison: number) => boolean,
): readonly StoredRecord[] {
  if (cursor === undefined) return records;
  const cursorValues = normalizeCursor(cursor, orders, source);
  return records.filter((record) => accept(compareTuples(tuple(record, orders, source), cursorValues, orders)));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    }, { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    }, { once: true });
  });
}

export async function executeQuery<T>(store: QueryStore, query: StructuredQuery<T>): Promise<QueryPage<T>> {
  const sourceValue = query.source.kind === "collection" ? collectionPath(query.source) : query.source.name;
  const indexName = query.source.kind === "collection" ? "collectionPath" : "collectionName";
  let records = await requestResult(store.index(indexName).getAll(sourceValue)) as StoredRecord[];
  records = records.filter((record) => query.filters.every((filter) => matchesFilter(record, filter, query.source)));

  const orders = queryOrders(query);
  records.sort((left, right) => compareTuples(tuple(left, orders, query.source), tuple(right, orders, query.source), orders));
  records = [...applyCursor(records, query.startAt, orders, query.source, (value) => value >= 0)];
  records = [...applyCursor(records, query.startAfter, orders, query.source, (value) => value > 0)];
  records = [...applyCursor(records, query.endAt, orders, query.source, (value) => value <= 0)];
  records = [...applyCursor(records, query.endBefore, orders, query.source, (value) => value < 0)];

  const offset = query.offset ?? 0;
  const pageRecords = records.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
  const codec = query.source.codec;
  const output = pageRecords.map((record): ExistingRecord<T> => ({
    key: deserializeKey(record.keyParts),
    exists: true,
    data: codec === undefined ? record.data as T : codec.decode(record.data),
    metadata: { source: "indexeddb" },
  }));
  const last = pageRecords.at(-1);
  const nextCursor = query.limit !== undefined && pageRecords.length === query.limit && last !== undefined
    ? { values: tuple(last, orders, query.source) }
    : undefined;
  return { records: output, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
